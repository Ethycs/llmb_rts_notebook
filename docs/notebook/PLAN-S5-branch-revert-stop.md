# Plan: S5 — Cell directive grammar expansion (`/branch`, `/revert`, `/stop`)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship the three git-style operator directives end-to-end — `/branch`, `/revert`, `/stop` — including the kernel state mutations, the wire envelopes, and the extension-side directive parsing. Materialize `metadata.rts.zone.agents.<id>.turns[]` so the DAG is real data, not just an in-process notion.
**Time budget**: 2 days. Cross-layer (kernel + extension). One-agent feasible; two-agent (K-AS-S5 + X-EXT-S5) is faster.

---

## §1. Why this work exists

[BSP-002 §3](BSP-002-conversation-graph.md) defines the three git-style operations on agent histories:

- `/branch <source> [at <turn_id>] as <new_id>` — fork an agent at any ancestor turn.
- `/revert <agent> to <turn_id>` — move HEAD backward; future turns build from the new head.
- `/stop <agent>` — clean SIGTERM; record `runtime_status: idle`.

The data-model groundwork for all three lives in [BSP-002 §2](BSP-002-conversation-graph.md), but today the supervisor has no `fork(...)` method, no explicit `stop(agent_id)`, and the per-turn DAG is not materialized in `metadata.rts.zone.agents.<id>.turns[]` — it is only tracked in-process.

Driver: [BSP-005 §"S5"](BSP-005-cell-roadmap.md). Atoms: [branch-agent](../atoms/operations/branch-agent.md), [revert-agent](../atoms/operations/revert-agent.md), [stop-agent](../atoms/operations/stop-agent.md), [agent](../atoms/concepts/agent.md).

Hard dependencies:
- S2 (resume) and S3 (multi-turn) shipped.
- S4 (handoff) shipped — this slice's revert assigns a fresh session, and the next continuation triggers handoff replay against the newly-shorter ancestry.
- Substrate gap G4 (`fork_agent`, `move_agent_head` writer handlers) MUST land here or before.

## §2. Goals and non-goals

### Goals

- `metadata.rts.zone.agents.<id>.turns[]` is a real persisted array; every turn append (since S3) writes through `append_turn` intent.
- `/branch alpha at t_3 as beta` produces a new agent ref; both Case A (head) and Case B (ancestor) mechanics work per [branch-agent](../atoms/operations/branch-agent.md) §"Two cases".
- `/revert alpha to t_2` SIGTERMs alpha (if alive), sets `agent.head_turn_id = t_2`, records a `ref-move` event, and the next `@alpha:` triggers Case B replay.
- `/stop alpha` SIGTERMs cleanly and records `runtime_status: idle`.
- All three directives parse in the extension's directive grammar.
- S8 (inline approval `vscode.diff`) folds in here as a renderer-side enhancement (see §3 step 7).

### Non-goals

- Branch-switching UX in the notebook view (sidebar/picker per [BSP-002 §11.2](BSP-002-conversation-graph.md)) is V2+. V1 just appends new cells; the operator reads cell decorations + directives to follow the branch.
- Conflict resolution between simultaneous reverts and turn appends (V3+ multi-kernel territory).
- This slice does NOT change the section model — sections land in [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md).

## §3. Concrete work

1. **Materialize the turn DAG.** Update `vendor/LLMKernel/llm_kernel/agent_supervisor.py`'s response handler so every emitted turn submits an `append_turn` intent per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md). This was deferred during S3; ratify here. The persisted shape matches [concepts/turn](../atoms/concepts/turn.md) §"Schema".

2. **`AgentSupervisor.fork(source_agent, at_turn_id, new_agent_id)`** per [contracts/agent-supervisor §"Spec'd but not yet present"](../atoms/contracts/agent-supervisor.md):
   - Validate `source_agent` exists and has a head; else K21.
   - Validate `at_turn_id` is in the source's ancestry; else K22.
   - Case A (`at_turn_id == source.head_turn_id`): spawn claude with `--resume=<source_session> --fork-session`; mint a fresh `claude_session_id` for the new agent.
   - Case B (`at_turn_id` is an ancestor): spawn claude with a fresh `--session-id`; replay turns from root to `at_turn_id` over stdin (user/assistant JSON lines).
   - Persist via `fork_agent` intent.

3. **`AgentSupervisor.revert(agent_id, to_turn_id)`** per [revert-agent](../atoms/operations/revert-agent.md):
   - Validate agent exists; else K20.
   - Validate `to_turn_id` is in the agent's ancestry; else K22.
   - SIGTERM the agent process if alive (treat exit code 0 as expected; let the watchdog observe).
   - Submit `move_agent_head` intent: `agent.head_turn_id = to_turn_id`; `agent.last_seen_turn_id = to_turn_id`.
   - Submit `record_event` with kind `ref-move` (event log per [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md)) for Inspect-mode replay.
   - Mint a fresh `claude_session_id` for the next continuation. Pre-revert turns keep their original session id per [agent atom](../atoms/concepts/agent.md) invariants.

4. **`AgentSupervisor.stop(agent_id)`** per [stop-agent](../atoms/operations/stop-agent.md):
   - Validate agent exists; else K20.
   - SIGTERM cleanly with grace; on grace timeout SIGKILL (Engineering Guide pattern).
   - Submit `update_agent_session` intent: `runtime_status: "idle"`, `pid: null`.

5. **Extension parser.** In `extension/src/notebook/cell-directive.ts`, extend the grammar:
   - `/branch <source_agent> [at <turn_id>] as <new_agent_id>` → `action_type: "agent_branch"`.
   - `/revert <agent> to <turn_id>` → `action_type: "agent_revert"`.
   - `/stop <agent>` → `action_type: "agent_stop"`.
   - All three envelope shapes are already in [protocols/operator-action](../atoms/protocols/operator-action.md). Wire them.

6. **Kernel routing.** In `vendor/LLMKernel/llm_kernel/custom_messages.py`, add handlers for the three action types that dispatch to `AgentSupervisor.fork / revert / stop`.

7. **S8 fold-in (inline approval `vscode.diff`).** When an agent emits a `propose_edit` span ([protocols/mcp-tool-call](../atoms/protocols/mcp-tool-call.md) — `propose` tool), the renderer creates a clickable `vscode.diff` view URI. Approve/Reject buttons post `approval_response` action_type back. This is a one-day extension piece; lives here because it shares the operator-action wire path.

8. **Event log entries.** Every `/branch`, `/revert`, `/stop` writes a `record_event` intent so Inspect mode can show "alpha was reverted to t_2 at 14:03." See [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md).

## §4. Interface contracts

`AgentSupervisor` additions:

```python
def fork(self, source_agent: str, at_turn_id: Optional[str], new_agent_id: str) -> AgentHandle: ...
def revert(self, agent_id: str, to_turn_id: str) -> None: ...
def stop(self, agent_id: str) -> None: ...
```

Wire envelopes (rides Family D, already in [protocols/operator-action](../atoms/protocols/operator-action.md)):

```jsonc
{ "action_type": "agent_branch",  "parameters": { "source_agent_id": "...", "at_turn_id": "...", "new_agent_id": "...", "cell_id": "..." } }
{ "action_type": "agent_revert",  "parameters": { "agent_id": "...", "to_turn_id": "...", "cell_id": "..." } }
{ "action_type": "agent_stop",    "parameters": { "agent_id": "...", "cell_id": "..." } }
```

K-class additions (BSP-002 §7 — already enumerated):
- K21 (`cell_directive_invalid_branch_source`) — branch source has no head.
- K22 (`cell_directive_invalid_revert_target`) — turn not in ancestry. Shared between branch (Case B target) and revert.

## §5. Test surface

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_fork_case_a_at_head` — `--fork-session` invoked.
- `test_fork_case_b_at_ancestor` — replay over stdin verified by stdin-mock.
- `test_fork_unknown_source_raises_k21`.
- `test_fork_at_turn_not_in_ancestry_raises_k22`.
- `test_revert_moves_head` — head_turn_id updated; pre-revert turns survive.
- `test_revert_terminates_alive_process`.
- `test_revert_invalid_turn_raises_k22`.
- `test_revert_assigns_fresh_session_on_next_continue` — first continuation after revert uses new session id.
- `test_stop_signals_alive_agent` — SIGTERM observed.
- `test_stop_marks_idle_in_writer` — `update_agent_session` intent submitted with `runtime_status: "idle"`.

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_append_turn_persists_to_zone` — turns now visible in `metadata.rts.zone.agents.<id>.turns[]`.
- `test_fork_agent_intent_round_trip`.
- `test_move_agent_head_intent_round_trip`.

In `extension/test/notebook/`:

- `cell-directive-branch.test.ts`, `cell-directive-revert.test.ts`, `cell-directive-stop.test.ts` — directive parsing.
- `propose-edit-renderer.test.ts` — S8 inline diff view URI generated correctly.

Expected count: 10 supervisor + 3 writer + 4 extension = 17 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Materializing the turn DAG retroactively for in-flight notebooks | The hydrate path lazily fills `turns[]` on first persist; pre-S5 cells appear under their resolved `agent_id` key with their original `created_at` preserved. |
| Case B replay diverges from Case A by claude version drift | Both invocations are pinned to the same claude binary version per [contracts/agent-supervisor §"Pre-spawn validation"](../atoms/contracts/agent-supervisor.md). |
| SIGTERM race during revert (turns mid-stream) | The watchdog already handles `process_died_mid_turn` (K23); revert reuses that exit path. |
| `at_turn_id` validation requires walking the DAG — slow for large agents | Acceptable for V1; ancestry chains rarely exceed 100 turns. V2 may add an index. |
| Operator types `/revert alpha to t_2` while alpha is still mid-response | Per [revert-agent](../atoms/operations/revert-agent.md), the SIGTERM is the explicit semantic — abort the in-flight turn. |

## §7. Atoms touched + Atom Status fields needing update

- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `fork`, `stop` move from "Spec'd but not yet present" to public methods; update Status / "Code drift vs spec".
- [operations/branch-agent.md](../atoms/operations/branch-agent.md) — Status flips from `V1 spec'd ... data model in BSP-002 §2; full UX V2+` to `V1 shipped (data + mechanics; branch-switching UX V2+)`.
- [operations/revert-agent.md](../atoms/operations/revert-agent.md) — same direction; Status `V1 shipped`.
- [operations/stop-agent.md](../atoms/operations/stop-agent.md) — Status `V1 shipped`.
- [concepts/agent.md](../atoms/concepts/agent.md) — verify the schema's `runtime_status` values reflect actual writes.
- [protocols/operator-action.md](../atoms/protocols/operator-action.md) — `agent_branch`, `agent_revert`, `agent_stop` rows now point at real handlers; remove any "V2 ship" caveats from the catalogue.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `fork_agent`, `move_agent_head` rows now wired in code.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 6](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — `kind` field used by overlay-commit ops underneath these directives.
- [PLAN-S4-cross-agent-handoff.md](PLAN-S4-cross-agent-handoff.md) — `last_seen_turn_id` is reset on revert; handoff path consumes the new state.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section overlay-commit machinery sits on top of the same writer path.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrames pin `turn_head_before` / `turn_head_after` across these directives' state changes.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G4 (writer handlers for `fork_agent`, `move_agent_head`) lands here.

## §9. Definition of done

- [ ] All 17 new tests pass.
- [ ] Round-trip smoke: `/spawn alpha task:"plan"` → 3 turns → `/branch alpha at t_2 as beta` → `@beta: alt` → `/revert alpha to t_1` → `@alpha: continue` → close → reopen → notebook restores both alpha (head=`t_1` + new continuation) and beta (head=`t_2 + alt`).
- [ ] Inspect-mode dry-run: `metadata.rts.event_log` contains a `ref-move` entry for the revert.
- [ ] S8 smoke: an agent emits a `propose` tool call; the cell renders a clickable diff view; clicking Approve posts `approval_response`.
- [ ] BSP-005 changelog updated with slice commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
