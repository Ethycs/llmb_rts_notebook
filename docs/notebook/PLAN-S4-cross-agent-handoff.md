# Plan: S4 — Persistent Claude Phase 3 (cross-agent context handoff)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: thread `last_seen_turn_id` through `AgentHandle` and `send_user_turn`, walk the turn DAG between an agent's last-seen point and the notebook head, and inject missed turns from other agents into the addressed agent's session before the operator's new message reaches it.
**Time budget**: 1.5 days. Single-agent. Depends on S2 (resume), S3 (multi-turn), S3.5 (manifest output). Blocks S5's branch/revert (turn DAG materialization is sister work).

---

## §1. Why this work exists

After S3, an operator can keep a conversation going with one agent. After S3.5, each turn has a deterministic context manifest. But in a notebook with cells targeting alpha, beta, gamma, when the operator sends `@alpha` after beta has produced 3 turns, alpha's claude session has not seen any of beta's output. Currently the operator has to manually paste beta's responses into alpha's prompt — an unbearable failure of the multi-agent vision.

S4 fixes this. The kernel walks the turn DAG between `agent.last_seen_turn_id` and the notebook's current head, generates synthesis messages for each missed turn ("Beta replied: …"), and injects them into alpha's session over stdin before the operator's `<message>` is sent. After alpha responds, `last_seen_turn_id` advances to the new turn.

Driver: [BSP-002 §4.6](BSP-002-conversation-graph.md). Slice spec: [BSP-005 §"S4 — Persistent Claude Phase 3"](BSP-005-cell-roadmap.md). Atom: [continue-turn](../atoms/operations/continue-turn.md) §"Invariants / Preconditions" — the handoff rule already specifies the desired semantics.

## §2. Goals and non-goals

### Goals

- `AgentHandle` carries `last_seen_turn_id: str | None` across spawn / resume / handoff.
- `send_user_turn(agent_id, message)` walks `last_seen_turn_id → notebook_head`, synthesizes prefix messages for each missed turn, and injects them before the operator message.
- Handoff messages are NOT separate turns in the DAG (they are transient context injection per [continue-turn](../atoms/operations/continue-turn.md)).
- After a successful turn, `last_seen_turn_id == head_turn_id`.
- Determinism: replay produces equivalent injected context for the same DAG state.

### Non-goals

- This slice does NOT implement partial-handoff strategies (drop oldest, summarize) when `missed_turn_count` exceeds budget. That is V2+ per [continue-turn](../atoms/operations/continue-turn.md) §"V1 vs V2+".
- This slice does NOT alter cell rendering to show "[handoff]" markers — the handoff messages stay invisible per [BSP-002 §6 Issue 3 resolution](BSP-002-conversation-graph.md).
- This slice does NOT implement `/branch` or `/revert` — those land in [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md).
- This slice does NOT change the `agent_continue` wire format.

## §3. Concrete work

1. **Schema extension on `AgentHandle`.** Add `last_seen_turn_id: Optional[str]` to the dataclass in `vendor/LLMKernel/llm_kernel/agent_supervisor.py`. Default `None` for fresh spawns; populated to the spawn's first response turn id after S2's resume completes.

2. **Persistence.** Mirror `last_seen_turn_id` into `metadata.rts.zone.agents.<id>.session.last_seen_turn_id` per [agent atom schema](../atoms/concepts/agent.md). The field already exists in the atom schema; this slice wires it. Updates flow through the existing `update_agent_session` intent kind in [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md).

3. **Turn-DAG walker.** New private helper `AgentSupervisor._missed_turns(agent_id, head_turn_id) → list[Turn]`:
   - Read `metadata.rts.zone.agents.<*>.turns[]` for ALL agents in the zone (cross-agent walk).
   - Construct the chain from `head_turn_id` backward via `parent_id` until `agent.last_seen_turn_id` is reached.
   - Filter to turns NOT authored by `agent_id` (those are the handoff candidates).
   - Return chronologically ordered (root → head).

4. **Synthesis prefix.** New private helper `_synthesize_handoff_prefix(turns) → list[dict]`:
   - One JSON-line per missed turn in `claude` stream-json input format: `{"type":"user","message":{"role":"user","content":"<role> <agent_id> said: <body>"}}`.
   - The exact wording is operator-side narrative; preserve verbatim across runs for determinism.

5. **`send_user_turn` updates** (the V1.1 method spec'd in [contracts/agent-supervisor §"Spec'd but not yet present"](../atoms/contracts/agent-supervisor.md)):
   ```python
   def send_user_turn(self, agent_id: str, message: str) -> AgentHandle:
       handle = self._agents[agent_id]                 # K20 if missing
       head = self._notebook_head_turn_id()
       missed = self._missed_turns(agent_id, head)
       prefix = self._synthesize_handoff_prefix(missed)
       for line in prefix:
           handle.stdin.write(json.dumps(line) + "\n")
       handle.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":message}}) + "\n")
       handle.stdin.flush()
       # response is processed by existing reader thread; on terminal:
       handle.last_seen_turn_id = handle.head_turn_id
       self._writer.submit_intent({...update_agent_session...})
       return handle
   ```

6. **Hydrate path.** On notebook reopen, `MetadataWriter.hydrate(snapshot)` restores `last_seen_turn_id` per agent. Agents whose `last_seen_turn_id` lags the snapshot's head simply trigger a handoff on the next `@<agent>:` — no migration needed.

7. **K-class plumbing.**
   - K26 (`cross_agent_handoff_failed`) — supervisor catches an exception during handoff write; agent is left in an indeterminate session state. Per [contracts/agent-supervisor §"K-class error modes"](../atoms/contracts/agent-supervisor.md). Surfaced as a `report_problem` synthetic span on the cell.
   - Existing K20 (`unknown agent`), K23 (`process died mid-turn`), K24 (`--resume failed`) propagate unchanged.

## §4. Interface contracts

`AgentSupervisor` public method addition:

```python
def send_user_turn(self, agent_id: str, message: str) -> AgentHandle:
    """Append one operator turn after replaying missed turns from siblings.
    Returns the same AgentHandle (lifecycle preserved). Raises K20/K23/K24/K26.
    """
```

Wire envelope (already shipped in S3 per [protocols/operator-action](../atoms/protocols/operator-action.md)):

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type": "agent_continue",
    "parameters": { "agent_id": "alpha", "message": "<body>", "cell_id": "<cell-uri>" }
  }
}
```

No wire change for S4 — it is purely kernel-side enrichment of the existing `agent_continue` semantics. The handoff is invisible to the extension.

The `update_agent_session` intent grows a `last_seen_turn_id` field; its parameter shape is per the atom-side schema in [agent](../atoms/concepts/agent.md):

```jsonc
{
  "intent_kind": "update_agent_session",
  "parameters": {
    "agent_id": "alpha",
    "head_turn_id": "t_...",
    "last_seen_turn_id": "t_..."
  }
}
```

## §5. Test surface

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_send_user_turn_no_missed_turns` — only one agent in zone, no handoff prefix, message goes straight through.
- `test_send_user_turn_with_one_missed_sibling_turn` — two agents, beta produced 1 turn, `@alpha:` injects 1 prefix line then operator message.
- `test_send_user_turn_with_three_missed_sibling_turns` — chronological order preserved.
- `test_send_user_turn_unknown_agent_raises_k20` — supervisor lookup miss.
- `test_send_user_turn_dead_agent_resumes_first` — idle agent → resume → handoff → message.
- `test_send_user_turn_advances_last_seen_turn_id` — after success, `last_seen_turn_id == head_turn_id`.
- `test_send_user_turn_handoff_failure_raises_k26` — stdin write fails mid-handoff.
- `test_send_user_turn_persists_last_seen_via_writer` — `update_agent_session` intent submitted with new field.

In `vendor/LLMKernel/tests/test_hydrate.py`:

- `test_hydrate_restores_last_seen_turn_id_per_agent`.
- `test_handoff_after_hydrate_replays_correctly`.

Expected count: 8 supervisor tests + 2 hydrate tests = 10 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Missed-turn count grows unbounded in long notebooks (no budget) | V1 emits all missed turns per [continue-turn V1 vs V2+](../atoms/operations/continue-turn.md); V2 layers a budget. The walker DOES terminate at `last_seen_turn_id`, so it is bounded by activity since the agent last spoke. |
| Synthesis wording drifts between runs | Pin the prefix template literal in code; test `test_send_user_turn_with_one_missed_sibling_turn` asserts exact string. |
| stdin write race with the agent's own response stream | The reader thread is on stdout; stdin writes are serialized through `_lock` per existing supervisor invariants ([contracts/agent-supervisor §"Locking / threading"](../atoms/contracts/agent-supervisor.md)). |
| Cycle in turn DAG (defensive — DAG is acyclic by construction) | The walker has a max-depth guard; exceeding it raises K26 with `reason: "cycle_detected"`. |
| `metadata.rts.zone` head_turn_id is stale during a fast cell sequence | `_notebook_head_turn_id()` reads the writer's in-memory snapshot under `_lock`; the writer's FIFO serialization keeps it consistent. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/agent.md](../atoms/concepts/agent.md) — `last_seen_turn_id` field is already in the schema; the field is now actively maintained. Status remains `V1 shipped`.
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `send_user_turn` moves from "Spec'd but not yet present" to a real method. Update the listing.
- [operations/continue-turn.md](../atoms/operations/continue-turn.md) — Status `V1 shipped` stays; the cross-agent handoff invariant is now enforced (was aspirational).
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `update_agent_session` parameter shape verified consistent with the new field.
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — no shape change; verify the `update_agent_session` handler accepts `last_seen_turn_id`.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 5](PLAN-v1-roadmap.md) — the ship-ready bullet this flips.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — manifest replay overlap; S4 reuses the deterministic walk for handoff content.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — both slices need the turn DAG materialized at `metadata.rts.zone.agents.<id>.turns[]`. S4 uses it; S5 finalizes the materialization.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrames record `turn_head_before` / `turn_head_after`; the handoff sets these correctly.
- S9 (interrupt button) lives logically here; per [PLAN-v1-roadmap.md §3](PLAN-v1-roadmap.md), S9 is folded into this PLAN's §4 wire if surfaced — `agent_interrupt` action type maps to `AgentSupervisor.interrupt(agent_id)` (SIGINT). Test: `test_supervisor_interrupt_signals_pid`.

## §9. Definition of done

- [ ] All 10 new tests pass.
- [ ] Two-agent end-to-end smoke: spawn alpha + beta, run two turns on beta, then `@alpha:` — alpha's response references beta's content, confirming handoff fired.
- [ ] Three-agent stress smoke: 5 turns each on alpha, beta, gamma in alternating order; verify each `last_seen_turn_id` advances correctly across the writer state.
- [ ] Idle-resume + handoff smoke: terminate alpha, send `@alpha:` after beta has produced 2 turns; alpha resumes, handoff fires, response correct.
- [ ] [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) `send_user_turn` listing moved to "Public method signatures" block.
- [ ] BSP-005 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
