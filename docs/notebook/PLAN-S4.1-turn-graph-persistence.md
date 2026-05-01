# Plan: S4.1 — Turn-graph persistence + writer-handler completion

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: close the V1.5 substrate gap PLAN-S4 §10 queued (and that S5a / S5b inherited): land the metadata-writer turn-graph persistence — `append_turn`, `fork_agent`, `move_agent_head`, plus a real `record_event` shape for `kind: "agent_ref_move"` — migrate `AgentSupervisor._missed_turns` off the in-memory `_turns` cache onto `metadata.rts.zone.agents.<id>.turns[]`, and re-enable the three multi-agent live smokes PLAN-S4 §9 deferred.
**Time budget**: ~0.7-0.9 day. Up from PLAN-S4 §10's "0.3-0.5 day delta" guess after reading the code: four writer handlers (not one) need to flip + a new `agent_ref_move` event branch on `record_event`; the supervisor migration deletes `record_turn` + `_turns` (option (a) below) which forces test-rewrite churn for ~14 existing tests that call `sup.record_turn(...)`. Single-agent feasible.

---

## §1. Why this work exists

PLAN-S4 V1 shipped at submodule `52a355c` with a documented divergence (PLAN-S4 §10): `_missed_turns` reads from `AgentSupervisor._turns: dict` because the metadata-writer turn-graph persistence is in `_PENDING_SLICE`. The follow-up was named `PLAN-S4.1-turn-graph-persistence-handoff-fix.md`; this is that file (renamed to drop the `-handoff-fix` suffix because the scope grew beyond handoff after S5a / S5b shipped on the same `_PENDING_SLICE` pattern).

Verified state today (`vendor/LLMKernel/llm_kernel/metadata_writer.py:1205-1224`):

```python
_PENDING_SLICE = {
    "append_turn":              "BSP-002 turn graph slice",
    "create_agent":             "BSP-002 turn graph slice",
    "move_agent_head":          "BSP-002 turn graph slice",
    "fork_agent":               "BSP-002 turn graph slice",
    "update_agent_session":     "BSP-002 turn graph slice",
    "add_overlay":              "BSP-002 turn graph slice",
    "move_overlay_ref":         "BSP-002 turn graph slice",
    "update_ordering":          "BSP-002 turn graph slice",
    ...
}
```

The supervisor surfaces three pending-slice diagnostics that this plan retires: `revert_move_agent_head_pending_slice` (`agent_supervisor.py:1020`), `fork_agent_intent_pending_slice` (`agent_supervisor.py:1310`), and `revert_agent_ref_move_pending_slice` / `fork_agent_ref_move_pending_slice` (`agent_supervisor.py:1043, 1329`) — the last pair currently fail with K40 because the supervisor submits `intent_kind: "agent_ref_move"` which is not in `_BSP003_INTENT_KINDS` (`metadata_writer.py:817-848`).

[`record_event`](../atoms/protocols/family-d-event-log.md) IS already in the registered kinds list (`metadata_writer.py:828`) but its handler (`metadata_writer.py:1166-1180`) is wired to `append_drift_event` and requires `field_path`, which is the wrong shape for an `agent_ref_move` event-log entry. The plan reshapes `record_event` to dispatch on `parameters.kind`.

Driver: PLAN-S4 §10 (the V1.5 follow-up callout); PLAN-S5 §3 steps 3 + 6 (revert / branch writer-intent dependencies).

## §2. Goals and non-goals

### Goals

- Flip three intent handlers from `_PENDING_SLICE` stubs to active: `append_turn`, `fork_agent`, `move_agent_head`. Verified pending; verified used by S4 / S5a / S5b call sites.
- Reshape `record_event` so `parameters.kind: "agent_ref_move"` writes a structured entry to `metadata.rts.event_log[]` per [family-d-event-log](../atoms/protocols/family-d-event-log.md) + [BSP-002 §8.5](BSP-002-conversation-graph.md). Existing `field_path`-shaped drift events stay backward-compatible.
- Lock the schema for `metadata.rts.zone.agents.<id>.turns[]` (NOT currently defined anywhere — verified absent from `_rfc_schemas.py`; see §3.B).
- Migrate `_missed_turns` off `AgentSupervisor._turns` onto the persisted turn array (option (a) — big-bang; see §3.C).
- Delete `AgentSupervisor.record_turn` and `_turns` / `_head_turn_id` instance fields. Replace test seeding with `submit_intent({intent_kind: "append_turn", ...})` calls.
- Re-enable PLAN-S4 §9's three deferred smokes: two-agent end-to-end, three-agent stress, idle-resume + handoff. Verified deferred in PLAN-S4 §9 lines 185-187.

### Non-goals

- `update_agent_session`, `create_agent`, `add_overlay`, `move_overlay_ref`, `update_ordering` — also `_PENDING_SLICE`, but out of scope for this slice. Flagged for a follow-up.
- BSP-007 overlay-commit kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`) — separate K-OVERLAY slice.
- BSP-008 `record_run_frame` — separate S6 slice.
- Branch-switching UX, reflog, protected branches — V2+ per PLAN-S5 §2.5.

## §3. Concrete work

### §3.A Writer handlers to flip

Three `_PENDING_SLICE` entries removed, three handlers added in `metadata_writer.py:_intent_handler_for`:

1. **`append_turn`** — appends one immutable turn record into `metadata.rts.zone.agents.<agent_id>.turns[]`. Validates `parent_id` either equals an existing turn id in the same agent's chain OR is `None` (root). Validates `turn_id` is unique zone-wide. Bumps `snapshot_version` via the standard mutator path (NOT the `record_event` / `acknowledge_drift` post-bump branch at `metadata_writer.py:1095`).

2. **`fork_agent`** — creates `metadata.rts.zone.agents.<new_agent_id>` with the schema fields per [agent atom](../atoms/concepts/agent.md). Required parameters (verified against `agent_supervisor.py:1297-1307`): `source_agent_id`, `new_agent_id`, `at_turn_id`, `case` (`"A"` or `"B"`), `claude_session_id`. Validates `new_agent_id` not in `agents`; validates `source_agent_id` exists; validates `at_turn_id` is in source's ancestry by walking the persisted `turns[]`.

3. **`move_agent_head`** — mutates `metadata.rts.zone.agents.<agent_id>.session.head_turn_id` and `.last_seen_turn_id` to the new value. Required parameters (verified against `agent_supervisor.py:1010-1017`): `agent_id`, `head_turn_id`, `last_seen_turn_id`. Validates target turn is in the agent's persisted ancestry.

### §3.B `record_event` reshape — `agent_ref_move` branch

`record_event` handler (`metadata_writer.py:1166-1180`) currently requires `field_path` and routes to `append_drift_event`. Reshape: dispatch on `parameters.kind`:

- `kind: "agent_ref_move"` (NEW): append `{kind, reason, agent_id, from_turn_id, to_turn_id, recorded_at}` to `metadata.rts.event_log[]`. Reason vocabulary: `"operator_revert" | "operator_branch"` — verified against `agent_supervisor.py:1035, 1321`.
- `kind` absent OR `field_path` present (legacy): existing drift-log path preserved.

The supervisor's `intent_kind: "agent_ref_move"` submissions at `agent_supervisor.py:1031-1040` and `1317-1326` are rewritten to use `intent_kind: "record_event"` with `parameters.kind: "agent_ref_move"`. (`agent_ref_move` is NOT added to `_BSP003_INTENT_KINDS` — it's an event sub-kind, not a top-level intent kind, per [submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md) registry.)

### §3.B' Schema — `metadata.rts.zone.agents.<id>.turns[]`

**Verified absent**: grep of `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` for `"turns"` returns no matches; grep of `metadata_writer.py` returns no matches in the agent state path. The atom [concepts/turn.md](../atoms/concepts/turn.md) §"Schema" specifies the canonical shape; this slice locks the writer-side mirror to it:

```jsonc
// metadata.rts.zone.agents.<agent_id>.turns[<idx>]
{
  "id":                 "t_01HZX...",
  "parent_id":          "t_01HZX..." | null,
  "agent_id":           "alpha",                   // mirrors enclosing key
  "claude_session_id":  "9d4f-..." | null,
  "role":               "operator" | "agent" | "system",
  "body":               "the turn text",
  "cell_id":            "vscode-notebook-cell:.../#abc" | null,
  "created_at":         "2026-04-30T17:30:00Z"
}
```

`provider` and `spans[]` from the atom are accepted on the wire but written as `provider: "claude-code"` (V1 only) and `spans: []` (real spans land via the BSP-008 slice). [agent atom](../atoms/concepts/agent.md) `last_seen_turn_id` is stored at `agents.<id>.session.last_seen_turn_id` (already the contract); no schema change there.

### §3.C Supervisor migration — option (a) big-bang

**Decision: option (a).** Verified by grep — `record_turn` is called only from tests (`test_agent_supervisor.py` 14 sites, `test_hydrate.py` 2 sites) and from PLAN-S4 / supervisor docstrings. No production code outside the supervisor calls it. Removing the symbol is safe; the alternative (option (b) dual-source bridge) preserves a debt symbol with no benefit.

Migration steps:

1. Delete `AgentSupervisor._turns: Dict[str, Dict[str, Any]]` (`agent_supervisor.py:228`), `_head_turn_id: Optional[str]` (`agent_supervisor.py:232`), and the `record_turn` method (`agent_supervisor.py:234-265`).
2. Rewrite `_missed_turns` (`agent_supervisor.py:727-…`) to read from `self._metadata_writer.snapshot()["zone"]["agents"]` — flatten the per-agent `turns[]` arrays, then walk `parent_id` from the supervisor's resolved notebook head back to the agent's `last_seen_turn_id`. Keep the `_HANDOFF_MAX_DEPTH` cycle guard.
3. Rewrite `_notebook_head_turn_id` (`agent_supervisor.py:267-270`) to compute the head as the most-recently-`created_at` turn across all agents in the persisted snapshot (deterministic tiebreak by `id`).
4. Rewrite `revert`'s ancestry walk (`agent_supervisor.py:958-974`) and `fork`'s ancestry walk (`agent_supervisor.py:1232-1246`) to read from the persisted snapshot, not `self._turns`.

### §3.D Hydrate path — `_spawn_from_config_entry`

Already restores `handle.last_seen_turn_id` from `entry["last_seen_turn_id"]` (`agent_supervisor.py:1796, 1804-1805`). No additional rebuild needed: under option (a) the walker reads directly from `metadata.rts` (which `MetadataWriter.hydrate(snapshot)` already populates), so no in-memory cache repopulation is required. Remove the cache-rebuild TODO that PLAN-S4 §10 step 3 considered.

### §3.E Caller wiring — who emits `append_turn`

Today `record_turn` is called by tests and was planned to be called by `mcp_server` dispatcher per PLAN-S4 line 226. After migration, the call site is the `AgentHandle._reader_thread` callback OR `mcp_server.dispatch_agent_response` — whichever already produces the post-turn observation. This slice points that single call site at `submit_intent({intent_kind: "append_turn", parameters: {...}})`. Operator turns are emitted by the same site that resolves operator messages in `send_user_turn` (`agent_supervisor.py:638` neighborhood).

## §4. Interface contracts

### Writer intent shapes (NEW handlers)

```jsonc
{ "intent_kind": "append_turn",      "parameters": { "id": "t_...", "parent_id": "t_..."|null, "agent_id": "alpha", "claude_session_id": "9d4f-...", "role": "agent"|"operator"|"system", "body": "...", "cell_id": "...", "created_at": "..." } }
{ "intent_kind": "fork_agent",       "parameters": { "source_agent_id": "...", "new_agent_id": "...", "at_turn_id": "t_...", "case": "A"|"B", "claude_session_id": "..." } }
{ "intent_kind": "move_agent_head",  "parameters": { "agent_id": "...", "head_turn_id": "t_...", "last_seen_turn_id": "t_..." } }
{ "intent_kind": "record_event",     "parameters": { "kind": "agent_ref_move", "reason": "operator_revert"|"operator_branch", "agent_id": "...", "from_turn_id": "t_...", "to_turn_id": "t_..." } }
```

### `AgentSupervisor` surface

- `record_turn(...)` **REMOVED**. Callers migrate to `submit_intent({intent_kind: "append_turn", ...})`.
- `_turns` and `_head_turn_id` removed from `__init__`.
- `_missed_turns`, `_notebook_head_turn_id`, `revert`, `fork` unchanged signatures; bodies migrate.

No wire changes. Driver invariance preserved per [discipline/wire-as-public-api](../atoms/discipline/wire-as-public-api.md).

## §5. Test surface

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_append_turn_intent_round_trip` — single turn appended; readback via snapshot.
- `test_append_turn_rejects_unknown_parent_k42` — `parent_id` not in agent's `turns[]`.
- `test_append_turn_rejects_duplicate_turn_id_k42` — same id submitted twice in one zone.
- `test_fork_agent_intent_round_trip` — Case A + Case B both persist a new agent record.
- `test_fork_agent_rejects_duplicate_agent_id_k42`.
- `test_move_agent_head_intent_round_trip`.
- `test_move_agent_head_rejects_target_outside_ancestry_k42`.
- `test_record_event_agent_ref_move_branch` — `kind: "agent_ref_move"` writes to `event_log[]`.
- `test_record_event_legacy_drift_path_preserved` — `field_path`-shaped envelope still routes to `drift_log`.

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_missed_turns_reads_from_metadata_rts` — supervisor's `_missed_turns` walks the persisted graph; no `_turns` cache.
- All 14 existing `record_turn` call sites rewritten to `submit_intent({intent_kind: "append_turn", ...})`. (Test-update churn, not new tests.)

In `vendor/LLMKernel/tests/test_hydrate.py`:

- `test_handoff_after_hydrate_walks_persisted_turns` — close → reopen → `@@agent alpha` replays beta's pre-reopen turns from `metadata.rts`. (Was deferred in PLAN-S4 §9.)

Lifted from PLAN-S4 §9 deferred (live smokes):

- `test_two_agent_end_to_end_handoff_smoke`.
- `test_three_agent_stress_smoke`.
- `test_idle_resume_and_handoff_smoke`.

Expected count: 9 writer + 1 supervisor + 1 hydrate + 3 lifted smokes = **14 new tests**, plus rewrite churn on ~14 existing supervisor tests + 2 hydrate tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Test churn from removing `record_turn` is large (~14 sites) | Mechanical rewrite; one helper `_seed_turn(writer, ...)` factored into `tests/_helpers.py` keeps the per-test diff minimal. |
| `_missed_turns` reading from a live snapshot every call is O(N agents × M turns) | Acceptable for V1 (zones rarely exceed 100 turns total); V2 may add an index keyed by `parent_id`. PLAN-S5 §6 already accepts the same complexity for revert/fork ancestry walks. |
| `record_event` reshape breaks any caller expecting the legacy `field_path` shape | Backward-compat preserved: handler dispatches on `parameters.kind` first; if `kind` absent and `field_path` present, legacy drift path runs unchanged. Add a test for the legacy path to lock it. |
| Notebook-head computation by `created_at` is non-deterministic on ties | Deterministic tiebreak: lexicographic on `id`. Tests pin both fields. |
| `fork_agent` Case B relies on the persisted graph containing the source's full ancestry | True post-migration. Pre-migration, an in-memory-only graph could fail Case B after reopen; this slice closes that gap by definition. |
| `agent_ref_move` is currently submitted as `intent_kind: "agent_ref_move"` (K40-failing) | Supervisor call sites rewritten to `intent_kind: "record_event"`; the K40 path becomes dead code and the diagnostic markers (`revert_agent_ref_move_pending_slice`, `fork_agent_ref_move_pending_slice`) are removed. |
| Other `_PENDING_SLICE` kinds (`update_agent_session`, `create_agent`, `add_overlay`, `move_overlay_ref`, `update_ordering`) remain stubbed | Out of scope; flagged here. Follow-up slice S4.2 (or rolled into S6). `update_agent_session` is the most consequential — it's what S4 + S5b call best-effort for runtime status / `last_seen_turn_id`. The walker migration in this slice does NOT depend on it (last_seen lives on the in-memory `AgentHandle`); but the close-reopen scenario for runtime status persistence remains a `_PENDING_SLICE` gap. |

## §7. Atoms touched

- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — note that `append_turn`, `fork_agent`, `move_agent_head` flip from spec'd to V1 shipped; `record_event` grows the `agent_ref_move` branch.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — registry table rows for `append_turn`, `fork_agent`, `move_agent_head` lose any "_PENDING_SLICE" caveat.
- [protocols/family-d-event-log.md](../atoms/protocols/family-d-event-log.md) — `agent_ref_move` event entry shape locked.
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `record_turn` removed from public surface; `_turns` cache removed; `_missed_turns` source migrated.
- [concepts/turn.md](../atoms/concepts/turn.md) — already specifies the schema; no atom edit, but verify the "V1 shipped" Status holds after persistence ships.

(Atom edits are author-time discipline per [discipline/sub-agent-dispatch](../atoms/discipline/sub-agent-dispatch.md). This slice is doc-only at the PLAN level; atom flips happen when the implementation slice ships.)

## §8. Cross-references (sibling PLANs)

- [PLAN-S4-cross-agent-handoff.md §10](PLAN-S4-cross-agent-handoff.md) — the V1.5 callout this plan formalizes.
- [PLAN-S5-branch-revert-stop.md §3 steps 3 + 6](PLAN-S5-branch-revert-stop.md) — `move_agent_head` + `fork_agent` writer dependencies.
- [PLAN-S5.0.3.1-executor-live-mode.md §3.C](PLAN-S5.0.3.1-executor-live-mode.md) — Family F snapshots the executor mirrors back will now include the populated `turns[]` arrays.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G4 (`fork_agent` / `move_agent_head` writer handlers) closes here.
- [BSP-002 §2.1](BSP-002-conversation-graph.md) — turn data model; this slice is the writer-side persistence of it.
- [BSP-003 §5](BSP-003-writer-registry.md) — the intent registry the four kinds live in.

## §9. Definition of done

- [ ] All 14 new tests pass + rewritten existing tests stay green: `pixi run pytest -n auto --dist=loadfile`.
- [ ] `_PENDING_SLICE` dict (`metadata_writer.py:1205`) no longer contains `append_turn`, `fork_agent`, `move_agent_head`.
- [ ] `_intent_handler_for` returns active handlers for the three flipped kinds.
- [ ] `record_event` handler dispatches on `parameters.kind`; legacy `field_path` path preserved by test.
- [ ] `AgentSupervisor.record_turn` removed; `self._turns` / `self._head_turn_id` removed; tests migrated to `submit_intent`.
- [ ] `_missed_turns`, `_notebook_head_turn_id`, `revert`'s + `fork`'s ancestry walks read from `metadata.rts.zone.agents.<*>.turns[]`.
- [ ] Three deferred PLAN-S4 §9 smokes (`test_two_agent_end_to_end_handoff_smoke`, `test_three_agent_stress_smoke`, `test_idle_resume_and_handoff_smoke`) present and green.
- [ ] PLAN-S4 §10 V1.5-callout updated to "shipped at <commit>"; PLAN-S4 §9 deferred-smoke checkboxes flipped.
- [ ] Atom Status notes updated per §7.
- [ ] BSP-005 changelog updated with the slice's commit SHA.
- [ ] This plan's Status flips to `shipped (commit <SHA>)`.
