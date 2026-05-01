# Operation: branch-agent

**Status**: V1 shipped (data + mechanics; branch-switching UX V2+)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.4](../../notebook/BSP-002-conversation-graph.md#44-branch) (branch lifecycle), [BSP-002 §5](../../notebook/BSP-002-conversation-graph.md#5-claude-session-id-strategy) (session-id strategy)
**Related atoms**: [agent](../concepts/agent.md), [turn](../concepts/turn.md), [revert-agent](revert-agent.md), [spawn-agent](spawn-agent.md)

## Definition

`/branch <source_agent> [at <turn_id>] as <new_agent_id>` creates a new [agent](../concepts/agent.md) ref whose `head_turn_id` is `turn_id` (default: `source_agent.head_turn_id`). The new agent gets its own `claude_session_id`; both source and new agent coexist in the zone. The underlying turn DAG is not modified — branching is a ref-creation event, like `git branch`.

## Operation signature

```
/branch <source_agent> [at <turn_id>] as <new_agent_id>
```

Kernel envelope:

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_branch",
    parameters: {
      source_agent_id: "alpha",
      at_turn_id: "t_3",            // optional; defaults to source.head_turn_id
      new_agent_id: "beta",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `source_agent` MUST exist and have a head; otherwise **K21** (`cell_directive_invalid_branch_source`).
- `new_agent_id` MUST be unique in the zone (same rule as [spawn-agent](spawn-agent.md)).
- `at_turn_id`, if specified, MUST be in `source_agent`'s ancestry; otherwise **K22** (`cell_directive_invalid_revert_target`) — branch and revert share the ancestry-resolution path.
- Branching is **ref-creation only** — the cell that issues `/branch` produces no turn (BSP-002 §6 binding table).
- Provider is inherited from `source_agent` (provider is sticky per BSP-002 §10 Q5). No `provider:` arg on `/branch`.

### Two cases (BSP-002 §4.4)

| Case | Condition | Mechanism |
|---|---|---|
| **A** | `at_turn_id` is `source.head_turn_id` (the current head) | `claude --resume=<source_session> --fork-session`; new session id minted for `new_agent_id`; full conversation copied up to head |
| **B** | `at_turn_id` is an ancestor (not the head) | claude has no native fork-from-arbitrary-past. Synthesize: new claude process with fresh `--session-id`, replay turns `t_root..at_turn_id` over stdin as user/assistant JSON lines. Replay is internal, not visible to the operator. |

The new agent's `claude_session_id` is fresh in both cases; the source's session is unaffected.

## V1 vs V2+

- **V1**: data model + Case A + Case B mechanics ratified. Branch coexists with source as siblings; the operator follows `/branch` with `@<new_agent>` to address it.
- **V2+**: branch-switching UX in the notebook view (sidebar/picker per BSP-002 §11.2). V1 just appends new cells; the operator reads cell decorations + directives to follow the branch.

## See also

- [spawn-agent](spawn-agent.md) — branch is the fork analogue of spawn.
- [revert-agent](revert-agent.md) — same ancestry-resolution path, but mutates `head_turn_id` instead of creating a ref.
- [agent](../concepts/agent.md) — branching produces a new one.
- [turn](../concepts/turn.md) — `at_turn_id` references one in the DAG.
