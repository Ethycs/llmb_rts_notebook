# Agent

**Status**: V1 shipped (the `claude-code` provider; persistent lifecycle; `/spawn`, `@<agent>:`, `/stop` directives — `/branch` and `/revert` are V1 spec'd, may slip to V2)
**Source specs**: [BSP-002 §2.2](../../notebook/BSP-002-conversation-graph.md#22-agent), [BSP-002 §4](../../notebook/BSP-002-conversation-graph.md#4-persistent-agent-lifecycle), [BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) (cell-as-agent-identity), [KB-notebook-target.md §10](../../notebook/KB-notebook-target.md#10-agents-as-executors)
**Related atoms**: [turn](turn.md), [zone](zone.md), [cell](cell.md), [run-frame](run-frame.md)

## Definition

An **agent** is a named, mutable ref pointing into the [turn](turn.md) DAG, plus the runtime state of the underlying executor process (claude-code in V1). Like a git branch ref: `head_turn_id` is mutable; moving it backward IS the revert operation; forking it IS the branch operation. Agents are per-[zone](zone.md) — all agent refs live within one notebook; there is no notion of "agent alpha across notebooks." Agents are **registered semantic executors**, not ambient intelligence: each agent has an id, a provider, a session, a runtime status, and a head pointing at one specific turn in the zone's DAG.

## Schema

```jsonc
// metadata.rts.zone.agents.<id>.session
{
  "id":                 "alpha",
  "head_turn_id":       "t_01HZX7K3...",       // mutable — the git-branch-ref pointer
  "provider":           "claude-code",         // V1: only claude-code
  "claude_session_id":  "9d4f-...",            // current bound session; changes on /branch or /revert
  "runtime_status":     "alive | idle | exited",
  "pid":                32856,                 // null when idle/exited
  "last_seen_turn_id":  "t_01HZX7K3...",       // the most recent turn this agent's session has been fed
  "work_dir":           "/.llmnb-agents/alpha",
  "created_at":         "...",
  "model":              "claude-haiku-4-5-20251001"
}
```

`runtime_status`:
- `alive` — process running, accepting turns over stdin.
- `idle` — process exited gracefully; resumable via `claude --resume <claude_session_id>`.
- `exited` — process exited and cannot be resumed; the conversation rebuilds from turn replay if re-engaged.

## Invariants

- **`head_turn_id` is mutable; the [turn](turn.md) it points at is immutable.** Moving the head is how revert works. Turns are never deleted.
- **`claude_session_id` is owned by the kernel.** Each agent gets a session at spawn or fork; reverts assign a NEW session at the next continuation. Pre-revert turns keep their original `claude_session_id`; new turns get the new session id. This is why `claude_session_id` lives on the [turn](turn.md), not (only) on the agent.
- **Per-[zone](zone.md).** One agent ref lives in exactly one notebook's `metadata.rts.zone.agents`. Cross-notebook agents do not exist in V1.
- **`last_seen_turn_id` may lag `head_turn_id`.** If another agent contributed turns in the same zone, this agent's session has not seen them; the kernel performs a cross-agent context handoff ([BSP-002 §4.6](../../notebook/BSP-002-conversation-graph.md#46-cross-agent-context-handoff)) before the next continuation.
- **Cell-as-agent-identity.** A [cell](cell.md) of `kind: "agent"` carries `bound_agent_id`; the cell renders a decoration showing `agent_id` + `provider` + `runtime_status` ([BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity)). The notebook itself is the attribution surface — handoff messages are NOT text-tagged because the operator can SEE which cells produced which turns.
- **Idle agents survive notebook close → reopen.** `runtime_status: "idle"` + `claude_session_id` round-trip through `metadata.rts`. Re-engaging spawns `claude --resume <session>`.
- **Provider is sticky** ([BSP-002 §10](../../notebook/BSP-002-conversation-graph.md#10-open-questions) Q5 recommendation). `/spawn beta provider:<other>` creates a separate agent; switching mid-conversation is a footgun.

## V1 vs V2+

- **V1**: providers limited to `claude-code`; persistent lifecycle (spawn → stays alive → accepts turns via stdin → idle exit on timeout or `/stop`); idle resume via `--resume`; `/branch` and `/revert` data-model ratified; full UX for branch-switching deferred to V2+.
- **V2+**: additional providers (`gpt-cli`, `gemini`, `ollama`); branch-switching UX (sidebar / picker for switching the rendered branch per [BSP-002 §11.2](../../notebook/BSP-002-conversation-graph.md#112-v2--graph-dag-with-branches)); richer Inspect-mode integration with the agent's session lineage.

## See also

- [turn](turn.md) — the DAG the agent points into.
- [zone](zone.md) — the per-notebook scope.
- [cell](cell.md) — `bound_agent_id` makes the cell visibly attribute to one agent.
- [run-frame](run-frame.md) — `executor_id` matches `agent.id`.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — agent ref mutable, turn DAG immutable.
