# Operation: continue-turn

**Status**: V1 shipped (BSP-002 K-AS slice)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.2](../../notebook/BSP-002-conversation-graph.md#42-continuation) (continuation lifecycle), [BSP-002 §4.6](../../notebook/BSP-002-conversation-graph.md#46-cross-agent-context-handoff) (cross-agent handoff)
**Related atoms**: [agent](../concepts/agent.md), [turn](../concepts/turn.md), [spawn-agent](spawn-agent.md), [stop-agent](stop-agent.md)

## Definition

`@<agent_id>: <message>` (or a plain-text cell with no directive when at least one agent already exists) appends one operator [turn](../concepts/turn.md) targeting the named [agent](../concepts/agent.md), receives the agent's response as the next turn, and advances the agent's `head_turn_id`. If other agents have contributed turns since this agent's `last_seen_turn_id`, the kernel performs a **cross-agent context handoff** before sending `<message>`.

## Operation signature

Cell directive forms:

```
@<agent_id>: <message body>      # explicit
<plain text with no prefix>      # implicit; targets the most-recent agent in the zone
```

Kernel envelope:

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_continue",
    parameters: {
      agent_id: "alpha",
      message: "<body>",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `agent_id` MUST resolve to an existing agent in the zone, else **K20** (`cell_directive_unknown_agent`).
- A plain-text cell with no prior agent in the zone raises **K25** (`cell_directive_no_agent_in_zone`); use [spawn-agent](spawn-agent.md) first.
- The handoff rule (BSP-002 §4.6): for every turn `t` where `t` is after `agent.last_seen_turn_id` on the notebook's mainline, the kernel feeds `t` to the agent's claude session as a synthesized prefix message before sending the new operator `<message>`. The handoff messages are **not separate turns in the DAG** — they are transient context injection. Replay is deterministic.
- If the agent's process is `idle`, the kernel re-spawns it via `claude --resume <claude_session_id>` first. If `exited`, full transcript replay rebuilds the session.
- After commit: agent's `head_turn_id = last_seen_turn_id =` the new response turn id.
- Handoff messages are NOT text-tagged (BSP-002 §6 Issue 3 resolution). The cell-as-agent-identity decoration is the attribution surface.
- Re-running a cell produces a NEW turn (new `id`); the previous turn stays in the DAG but is no longer this cell's `cell_id` target.

## V1 vs V2+

- **V1**: linear continuation; same `claude_session_id` across many turns; handoff via stdin replay.
- **V2+**: branch-aware continuation UX (rendering side-branches inline), plus partial-handoff strategies when `missed_turn_count` would exceed budget.

## See also

- [spawn-agent](spawn-agent.md) — how the agent first comes into existence.
- [stop-agent](stop-agent.md) — clean shutdown; the next continue-turn auto-resumes.
- [revert-agent](revert-agent.md) — moves head backward; subsequent continues build from the new head.
- [agent](../concepts/agent.md) — the ref this operation advances.
- [turn](../concepts/turn.md) — the unit produced.
