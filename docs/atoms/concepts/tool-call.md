# Tool call

**Status**: V1 shipped (as a span on the parent turn; the `tool` cell kind is V2+ reserved)
**Source specs**: [BSP-002 §13.4](../../notebook/BSP-002-conversation-graph.md#134-tool-calls-live-in-their-parent-turn-kb-target-03), [KB-notebook-target.md §0.3](../../notebook/KB-notebook-target.md#03-tool-calls-live-in-their-parent-turn), [KB-notebook-target.md §11](../../notebook/KB-notebook-target.md#11-tools-as-devices) (tools as devices)
**Related atoms**: [turn](turn.md), [span](span.md), [cell-kinds](cell-kinds.md), [cell](cell.md)

## Definition

A **tool call** is one invocation of a registered tool/device (read_file, run_tests, propose_diff, etc.) by an agent during its reasoning. In V1 it is recorded as one or more OTLP [spans](span.md) on the parent agent [turn's](turn.md) `spans[]` array — NOT as a separate turn and NOT as a separate cell. A single agent turn can carry an arbitrary number of tool-call spans without spawning child cells; the cell↔turn binding from [BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) is preserved (one cell, one turn, many spans).

The reserved `tool` [cell-kind](cell-kinds.md) (V2+) is a separate concept — it represents an operator-explicit tool invocation outside any agent's reasoning (e.g., a future `/run tests` directive). V1 ships only the agent-internal form.

## Schema (V1 — span shape on the parent turn)

```jsonc
// metadata.rts.zone.agents.<id>.turns[N].spans[]
{
  "name": "read_file",                 // tool method name
  "spanId": "abc123def456...",         // 16-hex; doubles as Jupyter display_id
  "kind": "SPAN_KIND_INTERNAL",
  "startTimeUnixNano": "...",
  "endTimeUnixNano":   "...",
  "attributes": {
    "llmnb.run_type":  "tool_call",
    "llmnb.agent_id":  "alpha",
    "llmnb.cell_id":   "vscode-notebook-cell:.../#def",
    "llmnb.tool_name": "read_file"
    // OpenInference / GenAI semconv attributes per RFC-005
  },
  "events": [...]
}
```

The span inherits cell + agent attribution from the parent turn via `llmnb.agent_id` and `llmnb.cell_id` ([RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md)).

## Invariants

- **Tool calls are spans, not turns.** They do not appear in `agents.<id>.turns[]`. They appear in `agents.<id>.turns[N].spans[]`.
- **Tool calls do not get their own cell in V1.** A cell is the operator's issuance unit ([cell](cell.md)); tool calls are part of an agent's response to one operator issuance. See [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md).
- **Tool calls are atomic.** A `tool_use` / `tool_result` / `system_message` / `result` span MUST NOT be split mid-span by [split-cell](../operations/split-cell.md) (decision S1). Splitting between spans is fine; splitting inside is forbidden. K94 if attempted.
- **Cell discipline holds.** A cell whose role is `agent` does not become multi-role when alpha reads a file, runs a search, and proposes an edit during one turn. The role is `agent`; the tool spans are alpha's reasoning artifacts.
- **Splits cannot orphan tool calls from their parent turn.** [split-cell](../operations/split-cell.md) §6.2 rejects a boundary that would separate a tool span from its parent agent turn (K94).
- **The `tool` cell-kind is reserved.** V1 directive parser ([BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar)) does NOT recognize a `tool` directive. V1 receivers seeing a cell with `kind: "tool"` render it inert and dispatch nothing.

## V1 vs V2+

- **V1**: agent-internal tool calls live as spans on the parent turn. The `tool` cell-kind is enum-reserved but inactive. There is no operator-explicit tool-invocation directive.
- **V2+**: the `tool` cell-kind activates with a control directive (e.g., `/run tests`). The tool's invocation, arguments, and result become the cell's primary content; no parent agent turn is required. The device-call mechanism ([KB-target §11](../../notebook/KB-notebook-target.md#11-tools-as-devices)) wires through the kernel.

## See also

- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — the rule and its split-cell consequence.
- [span](span.md) — what a tool call IS at the wire level.
- [turn](turn.md) — the parent that owns the tool-call spans.
- [operations/split-cell](../operations/split-cell.md) — decision S1 forbids splitting inside a tool-call span.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — paired V1 lock keeping the cell taxonomy small.
