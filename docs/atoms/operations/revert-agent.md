# Operation: revert-agent

**Status**: V1 spec'd (data model ratified; lands with K-AS slice)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.5](../../notebook/BSP-002-conversation-graph.md#45-revert) (revert lifecycle), [BSP-002 §5](../../notebook/BSP-002-conversation-graph.md#5-claude-session-id-strategy) (session-id strategy)
**Related atoms**: [agent](../concepts/agent.md), [turn](../concepts/turn.md), [branch-agent](branch-agent.md), [continue-turn](continue-turn.md)

## Definition

`/revert <agent_id> to <turn_id>` mutates `agent.head_turn_id = turn_id`, terminating the agent's currently-bound claude process if alive. Subsequent continue-turn ops on this agent build from `turn_id`; turns after `turn_id` remain in the DAG (still visible to [branch-agent](branch-agent.md)). HEAD moves backward; nothing is destroyed at the turn level.

## Operation signature

```
/revert <agent_id> to <turn_id>
```

Kernel envelope:

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_revert",
    parameters: {
      agent_id: "alpha",
      target_turn_id: "t_2",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `agent_id` MUST exist; else **K20**.
- `target_turn_id` MUST be in `agent`'s ancestry (reachable by walking `parent_id` from current head); else **K22** (`cell_directive_invalid_revert_target`). If the target is in another lineage, the operator wants [branch-agent](branch-agent.md), not revert.
- Revert sends SIGTERM to the agent's claude process (if alive); `runtime_status` becomes `idle`. The previous `claude_session_id` is preserved on the now-historical turns; **a new `claude_session_id` is assigned at the next continue-turn** when Case B replay (per [branch-agent](branch-agent.md)) synthesizes a new session.
- Records a `agent_ref_move` event in `metadata.rts.event_log` with `reason: "operator_revert"` (BSP-002 §8.5).
- The cell that issues `/revert` produces no turn (ref-move cell per BSP-002 §6 binding table).
- **Non-destructive at the turn level**: turns between `target_turn_id` and the prior head remain in `metadata.rts.zone.agents.<id>.turns[]`. They are no longer reachable from `head_turn_id` but ARE reachable via `/branch <agent> at <orphaned_turn>`.

### Why each turn carries `claude_session_id`

After revert + continue, the new turns have a different `claude_session_id` than the pre-revert turns. Storing it on the turn (not only the agent) keeps replay deterministic — the kernel knows exactly which session each turn ran in.

## V1 vs V2+

- **V1**: revert is operator-intuitive (HEAD moves; process restarts on next continue). Replay synthesizes a fresh session.
- **V2+**: a "soft revert" affordance that keeps the existing session alive when the target is reachable via claude's own resume mechanism (avoiding the SIGTERM cost).

## See also

- [branch-agent](branch-agent.md) — same ancestry resolution; creates a new ref instead of moving HEAD.
- [continue-turn](continue-turn.md) — the next op after revert; triggers session re-spawn.
- [agent](../concepts/agent.md) — the ref being mutated.
- [turn](../concepts/turn.md) — DAG nodes are immutable; only the ref moves.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — turns immutable; refs mutable.
