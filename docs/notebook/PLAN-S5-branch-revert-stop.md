# Plan: S5 — Branch / revert / stop (line-magic vocabulary)

**Status**: ready (refresh after S5.0/S5.0.1/S5.0.3)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship the three git-style operator controls — `@branch`, `@revert`, `@stop` — end-to-end on the post-S5.0 magic substrate. Wire `AgentSupervisor.fork / revert / stop`, the `agent_branch` / `agent_revert` / `agent_stop` operator-action handlers, the writer intent handlers (`fork_agent`, `move_agent_head`), and the line-magic dispatch path that the S5.0 registry already reserves as stubs.
**Time budget**: ~1.4 days. The substrate (turn DAG materialized at `metadata.rts.zone.agents.<id>.turns[]`, magic registry with reserved stubs, operator-action envelopes catalogued) is already shipped; the supervisor methods and writer handlers are NOT. Cross-layer (kernel + extension); single-agent feasible.

---

## §1. Why this work exists

[BSP-002 §3](BSP-002-conversation-graph.md) defines three git-style operations on agent histories:

- `@branch <source> [at <turn>] as <new_id>` — fork an agent at any ancestor turn.
- `@revert <agent> to <turn>` — move HEAD backward; future turns build from the new head.
- `@stop <agent>` — clean SIGTERM; record `runtime_status: idle`.

These were originally drafted as `/branch`, `/revert`, `/stop` slash directives (the PLAN-S5 first draft predates S5.0). After S5.0 shipped the `@`/`@@` magic vocabulary, the canonical operator surface for all three is **line magic** (`@`, not `@@`) — a parametric per-cell effect, NOT a cell-kind declaration. See [magic atom](../atoms/concepts/magic.md) line-magic registry: `revert / stop / branch | stub (S5)`. PLAN-S5.0 §3.4 lines 124-126 register the names with `pending_slice="S5"`; this slice flips them from stub to active.

[stop-agent](../atoms/operations/stop-agent.md) Status is `V1 shipped` (the supervisor already has stop-on-idle plumbing); [branch-agent](../atoms/operations/branch-agent.md) and [revert-agent](../atoms/operations/revert-agent.md) Status is `V1 spec'd (data model in BSP-002 §2; full UX V2+)`. Verifying against `vendor/LLMKernel/llm_kernel/agent_supervisor.py`: `fork`, explicit `revert`, and explicit `stop(agent_id)` methods are NOT present; the `agent_branch / agent_revert / agent_stop` action_types are catalogued in [protocols/operator-action](../atoms/protocols/operator-action.md) but no kernel handler dispatches to them. Writer intents `fork_agent` and `move_agent_head` are listed in `metadata_writer.py` but the handlers are stubs (per [PLAN-substrate-gap-closure](PLAN-substrate-gap-closure.md) gap G4).

Driver: [BSP-005 §"S5"](BSP-005-cell-roadmap.md). Atoms: [branch-agent](../atoms/operations/branch-agent.md), [revert-agent](../atoms/operations/revert-agent.md), [stop-agent](../atoms/operations/stop-agent.md), [agent](../atoms/concepts/agent.md), [magic](../atoms/concepts/magic.md).

Hard dependencies (all shipped):
- S2 (resume), S3 (multi-turn), S3.5 (context manifest), S4 (cross-agent handoff).
- S5.0 (magic registry + parser); S5.0.1 (hash mode + emission ban + Cell Manager precondition gates); S5.0.3 (driver extraction).
- Turn DAG materialization at `metadata.rts.zone.agents.<id>.turns[]` per [turn atom](../atoms/concepts/turn.md) Status `V1 shipped` — was an open item in the original PLAN-S5; now closed upstream.

## §2. Goals and non-goals

### Goals

- `AgentSupervisor.fork(source, at_turn_id, new_agent_id) → AgentHandle` per [contracts/agent-supervisor](../atoms/contracts/agent-supervisor.md).
- `AgentSupervisor.revert(agent_id, to_turn_id) → None`: SIGTERM the live process if any, move `head_turn_id`, record a `agent_ref_move` event, mint fresh `claude_session_id` for next continuation.
- `AgentSupervisor.stop(agent_id) → None`: clean SIGTERM, `runtime_status: idle`, `pid: null`.
- The reserved line-magic stubs `@branch`, `@revert`, `@stop` flip from `status="stub"` to `status="active"` in `magic_registry.py`; their `apply()` methods record an entry on `cell.line_magics` consumed by the kernel routing layer to ship `operator.action` envelopes.
- Both Case A (head) and Case B (ancestor) branch mechanics work per [branch-agent §"Two cases"](../atoms/operations/branch-agent.md).
- Writer intent handlers for `fork_agent` and `move_agent_head` close [substrate gap G4](PLAN-substrate-gap-closure.md).
- Hash-mode interaction: branch/revert/stop magic lines participate in the bidirectional hash strip + emission ban per [PLAN-S5.0.1 §3.4](PLAN-S5.0.1-cell-magic-injection-defense.md).
- Cell Manager precondition gates from [PLAN-S5.0.1 §3.10](PLAN-S5.0.1-cell-magic-injection-defense.md) apply: branch/revert/stop on a running cell raises K3C; on a contaminated cell raises K3E.

### Non-goals

- Branch-switching UX in the notebook view (sidebar/picker per [BSP-002 §11.2](BSP-002-conversation-graph.md)) — V2+ per [branch-agent §V1 vs V2+](../atoms/operations/branch-agent.md).
- Cell-rendered DAG visualization. V1 keeps a flat timeline; the operator follows branches via cell decorations + `@@agent <id>` addressing.
- Reflog / protected branches / cross-agent revert. V2+ (see §2.5).
- Section-overlay machinery — lands in [PLAN-S5.5-sections](PLAN-S5.5-sections.md) on the same writer path.

## §2.5. V1 vs V2+ — explicit feature split

**V1 ships:**
- Three line magics active. Single-agent target per invocation.
- `@branch alpha at t_3 as beta` produces a new ref; both Case A and Case B mechanics.
- `@revert alpha to t_2` moves HEAD; replay synthesizes a fresh session on next continue.
- `@stop alpha` clean SIGTERM with grace.
- Legacy column-0 `/branch`, `/revert`, `/stop` slash directives are **not** in the documented S5.0 alias set (§3.9 of PLAN-S5.0 lists only `/spawn` and `@<id>:`). Treat slash forms as **NOT preserved** unless explicitly re-added by a follow-up; flagged as an open question for operator review (see §6).

**V2+ deferred:**
- **Reflog**: a per-agent history of HEAD movements that survives revert. V1 records `agent_ref_move` event-log entries (per [revert-agent](../atoms/operations/revert-agent.md)); a navigable reflog UI is V2+.
- **Protected branches**: opt-in flag preventing `@revert` on a named ref. Operator workflow today: `@branch` before risky work.
- **Cross-agent revert**: `@revert alpha to <turn_in_beta_lineage>` raises K22 (target not in alpha's ancestry). V2+ may offer "rebase onto" semantics.
- **Soft revert** (keep session alive when target reachable via claude's resume) per [revert-agent §V2+](../atoms/operations/revert-agent.md).

Per [discipline/zachtronics](../atoms/discipline/zachtronics.md), every V1 control-flow effect is visible in the issuing cell's text — no hidden routing state.

## §3. Concrete work

1. **Activate the line-magic stubs.** In `vendor/LLMKernel/llm_kernel/magic_registry.py`, replace the three `LineMagicHandler(..., status="stub", pending_slice="S5")` entries with active handlers whose `apply(cell, args_str)` parses arguments via `magic_registry.parse_kv_args` (positional + named) and appends a `(name, parsed_args)` tuple to `cell.line_magics`. The kernel routing layer reads these and ships `operator.action` envelopes.

2. **`AgentSupervisor.fork(source_agent, at_turn_id, new_agent_id) → AgentHandle`** per [contracts/agent-supervisor §"Spec'd but not yet present"](../atoms/contracts/agent-supervisor.md):
   - Validate `source_agent` exists with a head; else **K21**.
   - Validate `at_turn_id` (default = `source.head_turn_id`) is in the source's ancestry; else **K22**.
   - Validate `new_agent_id` is unique in the zone and not a reserved magic name; else K-class per [magic §K-class](../atoms/concepts/magic.md) (K32) or spawn-uniqueness error.
   - **Case A** (`at_turn_id == source.head_turn_id`): spawn claude with `--resume=<source_session> --fork-session`; mint fresh `claude_session_id` for the new agent.
   - **Case B** (ancestor): spawn claude with fresh `--session-id`; replay turns `t_root..at_turn_id` over stdin as user/assistant JSON lines per the supervisor's existing replay mechanism (S2/Case B path).
   - Persist via `fork_agent` intent.

3. **`AgentSupervisor.revert(agent_id, to_turn_id) → None`** per [revert-agent](../atoms/operations/revert-agent.md):
   - Validate agent exists; else **K20**.
   - Validate `to_turn_id` is in the agent's ancestry; else **K22**.
   - SIGTERM if alive; let the watchdog observe (treat exit code 0 as expected).
   - Submit `move_agent_head` intent: `agent.head_turn_id = to_turn_id`; `agent.last_seen_turn_id = to_turn_id` (so [PLAN-S4](PLAN-S4-cross-agent-handoff.md) handoff replay walks the post-revert ancestry correctly).
   - Submit `record_event` with kind `agent_ref_move` and `reason: "operator_revert"` per [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md).
   - Fresh `claude_session_id` is assigned on the next continuation per [agent atom](../atoms/concepts/agent.md) invariants — pre-revert turns retain their original session id.

4. **`AgentSupervisor.stop(agent_id) → None`** per [stop-agent](../atoms/operations/stop-agent.md):
   - Validate agent exists; else **K20**.
   - SIGTERM with `shutdown_grace_seconds`; on grace timeout SIGKILL and mark `runtime_status: "exited"` (per stop-agent §"idle vs exited").
   - Submit `update_agent_session` intent: `runtime_status: "idle"` (or `"exited"` on escalation), `pid: null`. `claude_session_id`, `head_turn_id`, `last_seen_turn_id` unchanged.

5. **Writer intent handlers.** In `vendor/LLMKernel/llm_kernel/metadata_writer.py`, implement the `fork_agent` and `move_agent_head` intents (currently catalogued at lines 820-821 / 1210-1211 but with stub bodies). Closes substrate gap G4.

6. **Kernel routing.** In the operator-action dispatcher (`custom_messages.py` or successor), add handlers for `agent_branch`, `agent_revert`, `agent_stop` action types that dispatch to `AgentSupervisor.fork / revert / stop`. The dispatcher reads `cell.line_magics` after `parse_cell` and ships one envelope per recorded magic invocation.

7. **Hash-mode interaction (per [PLAN-S5.0.1 §3.4](PLAN-S5.0.1-cell-magic-injection-defense.md)).** When hash mode is on, the operator types `@branch foo` and the canonical storage is `@<HMAC>:branch foo`. `parse_cell` (already pin-aware post-S5.0.1) recovers the magic name. The `fork_agent` / `move_agent_head` / `update_agent_session` intent payloads carry the **canonical (un-hashed) magic name and parameters** — the writer never sees hashes; hashes live only in cell text. On the agent-visible egress (ContextPacker, handoff prefix), `strip_hashes_from_text` rewrites the line to plain `@branch …` form per S5.0.1 §3.4. Drivers that re-emit cell text into the editor surface the hashed canonical form.

8. **Event log entries.** Every `@branch`, `@revert`, `@stop` writes a `record_event` intent so Inspect mode can replay "alpha was reverted to t_2 at 14:03." See [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md).

9. **Atom Status flips.** Per §7 below — flip `branch-agent`, `revert-agent` from spec'd to V1 shipped; refine `stop-agent` Status to call out the explicit `@stop` magic path (idle-timeout already shipped, explicit op is the new piece).

## §4. Interface contracts

`AgentSupervisor` additions:

```python
def fork(self, source_agent: str, at_turn_id: Optional[str], new_agent_id: str) -> AgentHandle: ...
def revert(self, agent_id: str, to_turn_id: str) -> None: ...
def stop(self, agent_id: str) -> None: ...
```

Wire envelopes (already catalogued in [protocols/operator-action](../atoms/protocols/operator-action.md) lines 47-49):

```jsonc
{ "action_type": "agent_branch",  "parameters": { "source_agent_id": "...", "at_turn_id": "...", "new_agent_id": "...", "cell_id": "..." } }
{ "action_type": "agent_revert",  "parameters": { "agent_id": "...", "target_turn_id": "...", "cell_id": "..." } }   // [revert-agent] uses `target_turn_id`; protocol catalogue line 48 uses `to_turn_id` — drift flagged in §6
{ "action_type": "agent_stop",    "parameters": { "agent_id": "...", "cell_id": "..." } }
```

K-class additions (BSP-002 §7):
- **K20** (existing) — agent not found.
- **K21** (`cell_directive_invalid_branch_source`) — branch source has no head.
- **K22** (`cell_directive_invalid_revert_target`) — turn not in ancestry. Shared between branch (Case B target) and revert.
- **K3C** / **K3E** (existing per [PLAN-S5.0.1 §3.9](PLAN-S5.0.1-cell-magic-injection-defense.md)) — running / contaminated cell blocks the structural op. Branch/revert/stop count as structural ops at the Cell Manager surface.

### Driver invariance

Post-S5.0.3, `llm_client.driver` consumes the same Family-A `operator.action` envelopes for `agent_branch`, `agent_revert`, `agent_stop`. Branch/revert/stop semantics are kernel-side enrichments of those wires: the driver ships the action; the kernel walks the turn DAG, mutates refs, and emits event-log entries. Drivers (VS Code extension, `llmnb execute` CLI, future Rust/Go clients) need no S5-specific changes — the §4 wire shapes are the public contract per [discipline/wire-as-public-api](../atoms/discipline/wire-as-public-api.md). Hash mode is invisible at the wire (canonical un-hashed names) and at the driver (driver never sees pin).

## §5. Test surface

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_fork_case_a_at_head` — `--fork-session` invoked; new session id minted.
- `test_fork_case_b_at_ancestor` — replay over stdin verified via stdin-mock.
- `test_fork_unknown_source_raises_k21`.
- `test_fork_at_turn_not_in_ancestry_raises_k22`.
- `test_revert_moves_head` — `head_turn_id` updated; pre-revert turns survive in `turns[]`.
- `test_revert_terminates_alive_process` — SIGTERM observed; `runtime_status: idle`.
- `test_revert_invalid_turn_raises_k22`.
- `test_revert_assigns_fresh_session_on_next_continue` — first continuation after revert uses a new `claude_session_id`.
- `test_stop_signals_alive_agent` — SIGTERM observed; `update_agent_session` intent submitted.
- `test_stop_grace_timeout_escalates_to_sigkill_marks_exited`.

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_fork_agent_intent_round_trip`.
- `test_move_agent_head_intent_round_trip`.
- `test_revert_event_log_records_agent_ref_move`.

In `vendor/LLMKernel/tests/test_magic_registry.py`:

- `test_branch_revert_stop_line_magics_active` — `status="active"`, no longer stubs.
- `test_branch_args_parse_positional_and_named` — `@branch alpha at t_3 as beta` produces `(("alpha","beta"), {"at": "t_3"})` (or whichever positional shape the handler chooses).
- `test_revert_in_hash_mode_dispatches` — pin-aware parser recovers `revert` from `@<HMAC>:revert ...`.

In `vendor/LLMKernel/tests/test_cell_manager.py`:

- `test_branch_on_running_cell_raises_k3c`.
- `test_revert_on_contaminated_cell_raises_k3e`.

Expected count: 10 supervisor + 3 writer + 3 magic-registry + 2 cell-manager = 18 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Slash-form back-compat — original PLAN-S5 + KB cite `/branch`, `/revert`, `/stop`, but PLAN-S5.0 §3.9 only enumerates `/spawn` and `@<id>:` as preserved aliases | **Open ambiguity**: do operators retain slash forms for these three? If yes, add to S5.0's column-0 alias rewriter. If no, document the migration. Flagged for operator review before code lands. |
| Wire-payload field naming drift — `revert-agent.md` says `target_turn_id`; `protocols/operator-action.md` line 48 says `to_turn_id` | Pick one (recommend `target_turn_id` to match the atom that other atoms cross-reference) and update the other; verify `_rfc_schemas.py` matches. Flagged. |
| Case B replay diverges from Case A by claude version drift | Both invocations pin to the same claude binary version per [contracts/agent-supervisor §"Pre-spawn validation"](../atoms/contracts/agent-supervisor.md). |
| SIGTERM race during revert (turns mid-stream) | Watchdog handles `process_died_mid_turn` (K23); revert reuses that exit path. |
| `at_turn_id` ancestry walk slow for long agents | Acceptable for V1; ancestry chains rarely exceed 100 turns. V2 may add an index. |
| Hashed-magic emission ban interaction | All three magics are line-magic; in hash mode the canonical text is `@<HMAC>:<name> …`. The bidirectional strip ([PLAN-S5.0.1 §3.4](PLAN-S5.0.1-cell-magic-injection-defense.md)) keeps agents from seeing hashes; the emission ban prevents agents from typing valid hashed forms back into outputs. K3A on violation. |
| Operator runs `@revert` on a cell that is itself executing | K3C (running-cell freeze) — operator must wait or `@stop` first. K3E if contaminated. |
| K-class numbering collision check | K20-K23 already taken; K30-K3G taken by S5.0/S5.0.1; K-AS slice has K24-K26. K21/K22 reserved here from BSP-002 §7 — verify no S5.0/S5.0.1 collision before landing. |

## §7. Atoms touched + Atom Status fields needing update

- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `fork`, `revert`, `stop` move from "Spec'd but not yet present" to public methods; update Status / "Code drift vs spec".
- [operations/branch-agent.md](../atoms/operations/branch-agent.md) — Status flips to `V1 shipped (data + mechanics; branch-switching UX V2+)`. Operation signature line replaces `/branch <…>` with `@branch <…>`; legacy slash form noted as "not preserved as alias in V1" pending §6 resolution.
- [operations/revert-agent.md](../atoms/operations/revert-agent.md) — Status `V1 shipped`. Same signature swap. Resolve `target_turn_id` vs `to_turn_id` drift.
- [operations/stop-agent.md](../atoms/operations/stop-agent.md) — Status remains `V1 shipped`; signature line updates from `/stop <agent_id>` to `@stop <agent_id>`. The idle-timeout path was already shipped; this slice adds the explicit operator-issued path.
- [concepts/magic.md](../atoms/concepts/magic.md) — line-magic registry table: `revert / stop / branch` row flips from `stub (S5)` to `active`.
- [concepts/agent.md](../atoms/concepts/agent.md) — verify `runtime_status` enum values reflect the explicit `idle` path on `stop`.
- [protocols/operator-action.md](../atoms/protocols/operator-action.md) — `agent_branch`, `agent_revert`, `agent_stop` rows lose any "V2 ship" caveat; field names normalized to match atom layer.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `fork_agent`, `move_agent_head` rows: handlers now wired in code (G4 closed).

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 6](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — `kind` field used by overlay-commit ops underneath these magics.
- [PLAN-S4-cross-agent-handoff.md](PLAN-S4-cross-agent-handoff.md) — `last_seen_turn_id` is reset to `to_turn_id` on revert; the next handoff path consumes the new state.
- [PLAN-S5.0-cell-magic-vocabulary.md §3.4](PLAN-S5.0-cell-magic-vocabulary.md) — line-magic registry where `branch / revert / stop` were registered as S5 stubs (lines 124-126).
- [PLAN-S5.0.1-cell-magic-injection-defense.md §3.4 + §3.10](PLAN-S5.0.1-cell-magic-injection-defense.md) — bidirectional hash-strip discipline that governs branch/revert/stop emission and dispatch; precondition gates (running / contaminated) that apply.
- [PLAN-S5.0.3-driver-extraction-and-external-runnability.md §9](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — confirms drivers consume the wire only; branch/revert/stop semantics stay kernel-side.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section overlay-commit machinery shares the writer path used by `move_agent_head`.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrames pin `turn_head_before` / `turn_head_after` across these magics' state changes.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G4 (`fork_agent`, `move_agent_head` writer handlers) closes here.

## §9. Definition of done

- [ ] All 18 new tests pass.
- [ ] `magic_registry.py`: `branch`, `revert`, `stop` line-magics have `status="active"`; `pending_slice` field cleared.
- [ ] `AgentSupervisor.fork / revert / stop` present, covered by tests, callable from operator-action dispatch.
- [ ] Writer `fork_agent` / `move_agent_head` intent handlers active; G4 closed in PLAN-substrate-gap-closure.
- [ ] Round-trip smoke: `@@spawn alpha task:"plan"` → 3 turns → `@branch alpha at t_2 as beta` → `@@agent beta\nalt` → `@revert alpha to t_1` → `@@agent alpha\ncontinue` → close → reopen → notebook restores both alpha (head=`t_1` + new continuation, fresh session id) and beta (head=`t_2 + alt`).
- [ ] Inspect-mode dry-run: `metadata.rts.event_log` contains an `agent_ref_move` entry with `reason: "operator_revert"`.
- [ ] Hash-mode smoke: enable hash mode; `@<HMAC>:branch alpha at t_2 as beta` dispatches identically; agents receive `@branch …` plain via `strip_hashes_from_text`; emission of any hashed form back through agent stdout flags K3A.
- [ ] Cell Manager gate smoke: `@revert` issued in a running cell → K3C; in a contaminated cell → K3E.
- [ ] Driver invariance smoke: same `agent_branch` / `agent_revert` / `agent_stop` envelope shape consumed by `llm_client.driver` and the VS Code extension; no driver-side branch logic.
- [ ] Atom Status fields updated per §7.
- [ ] §6 ambiguities resolved before merge: (a) slash-form aliasing decision; (b) `target_turn_id` vs `to_turn_id` field-name normalization.
- [ ] BSP-005 changelog updated with slice commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
