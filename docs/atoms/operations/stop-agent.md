# Operation: stop-agent

**Status**: V1 shipped (idle-timeout path: BSP-002 K-AS slice; explicit operator path: S5c, submodule commit `4461794`, 2026-04-30; `AgentSupervisor.stop` present; `@stop` line-magic active)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.3](../../notebook/BSP-002-conversation-graph.md#43-idle-exit) (idle exit lifecycle)
**Related atoms**: [agent](../concepts/agent.md), [continue-turn](continue-turn.md), [spawn-agent](spawn-agent.md)

## Definition

`@stop <agent_id>` is a **clean shutdown** of the agent's runtime process. After stop, the agent's `runtime_status` is `idle` and the conversation is **resumable** — the next [continue-turn](continue-turn.md) re-spawns claude with `--resume <claude_session_id>` (or, if claude has lost the session, falls back to full transcript replay).

Stop is one of three causes of an agent process exiting (BSP-002 §4.3): explicit `@stop`, idle timeout (default 30 minutes; configurable via `LLMNB_AGENT_IDLE_SECONDS`), or kernel shutdown. Only the first two leave the agent `idle`; kernel shutdown's SIGTERM/SIGKILL also leaves `idle` if grace was honored.

## Operation signature

```
@stop <agent_id>
```

Kernel envelope:

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_stop",
    parameters: {
      agent_id: "alpha",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `agent_id` MUST exist; else **K20**.
- The cell that issues `@stop` produces no turn (control directive; same family as `@branch` and `@revert` per BSP-002 §6 binding table).
- After successful stop:
  - `runtime_status: "idle"`
  - `pid: null`
  - `claude_session_id` preserved (resume key)
  - `head_turn_id` and `last_seen_turn_id` unchanged
  - The agent survives notebook close → reopen via the `metadata.rts` snapshot.
- Stop SHOULD complete within `shutdown_grace_seconds`; if the process refuses SIGTERM, the kernel escalates to SIGKILL and marks `runtime_status: "exited"` instead of `idle`.

### `idle` vs `exited`

| State | Meaning | Resumability |
|---|---|---|
| `idle` | Process exited gracefully; claude session survives | `claude --resume <session_id>` |
| `exited` | Process was killed or claude lost the session (K24) | Full transcript replay rebuilds via Case B mechanics |

Both are compatible with [continue-turn](continue-turn.md); the kernel chooses the resume path automatically.

## V1 vs V2+

- **V1**: explicit `@stop` and idle-timeout-based clean shutdown both produce `runtime_status: "idle"`. Simple; no per-agent timeout overrides.
- **V2+**: per-agent timeout overrides; explicit "evict to disk" affordances; an operator-facing notion of "this agent is parked" vs "this agent is gone."

## See also

- [continue-turn](continue-turn.md) — resumes a stopped agent transparently.
- [spawn-agent](spawn-agent.md) — stop's analog for first-time creation.
- [agent](../concepts/agent.md) — the entity whose `runtime_status` is mutated.
