# Discipline: tool calls atomic, text I/O not

**Status**: discipline (V1 invariant)
**Source specs**: [BSP-002 §13.4](../../notebook/BSP-002-conversation-graph.md#134-tool-calls-live-in-their-parent-turn-kb-target-03), [KB-notebook-target.md §0.3](../../notebook/KB-notebook-target.md#03-tool-calls-live-in-their-parent-turn), [PLAN-atom-refactor.md §4 row S1](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [tool-call](../concepts/tool-call.md), [span](../concepts/span.md), [turn](../concepts/turn.md), [operations/split-cell](../operations/split-cell.md), [operations/promote-span](../operations/promote-span.md)

## The rule

**Tool calls are atomic; text I/O is not.**

A tool call (`tool_use` + matching `tool_result`) is one indivisible unit — the operator may not split inside it, may not merge across it, may not edit half of it without the other half. Text spans (operator prose, agent prose, `agent_emit` output) are divisible — they may be split at character offsets, merged across, edited piecewise.

The taxonomy:

| Span kind | Atomic? | Operator may split inside it? |
|---|---|---|
| `text` (operator prose) | No | **Yes** (char offset) |
| `agent_emit` (agent prose) | No | **Yes** (char offset) |
| `tool_use` | **Yes** | No |
| `tool_result` | **Yes** | No |
| `system_message` | **Yes** | No |
| `result` (terminal) | **Yes** | No |

## Why

A tool call is a transactional record: the agent asked for `X`, the tool returned `Y`. Splitting between `tool_use` and `tool_result` would create a cell with a request and no response, or a response with no request — meaningless for replay, broken for [run-frame](../concepts/run-frame.md) reconstruction, dishonest as provenance.

Text I/O is a different kind of artifact: it's narrative, not transactional. Splitting a 500-word agent response in half because the operator wants to checkpoint at the midpoint is benign; the agent's sentence is not a contract.

## Where the rule applies

- **[Split](../operations/split-cell.md)**: forbidden inside `tool_use` / `tool_result` / `system_message` / `result` spans. Allowed inside `text` / `agent_emit` spans at character offsets, and at any inter-span boundary. Decision row S1.
- **[Merge](../operations/merge-cells.md)**: cells containing tool calls may be merged whole-cell-wise (the tool call moves with its parent turn), but the rule that disallows splitting inside a tool call also blocks "merge then re-split inside the tool call" as a sneak path.
- **[Promote-span](../operations/promote-span.md)**: a `tool_use` + matching `tool_result` may be promoted as a unit (atomic). Promoting half of a tool call is forbidden.
- **Cell kind**: agent-internal tool calls do NOT spawn child cells. They live as spans on the parent agent turn. The reserved [`tool` cell kind](../concepts/cell-kinds.md) is for the *operator-explicit* future case (a `/run tests` directive that calls a registered tool without dispatching to any agent), not for agent-internal calls.

## Why text is different

Operator prose and agent prose are the textual surface the human can read and rewrite. Splitting `"Here is the schema for users... and here is the schema for orders"` into two cells preserves the meaning (each cell holds one schema's narrative). The same operation on a `tool_use` span — splitting `read_file(path="src/foo.py")` between `read_file` and `(path=...)` — destroys the call.

The principle: **respect the protocol-level boundaries** (tool call request/response is a protocol). Edit the narrative freely; do not reach inside the wire.

## Failure mode

A V1 implementation that allows splitting inside a `tool_use` span produces:

- Replay divergence: the new cell ordering doesn't reproduce the original tool exchange.
- Render breakage: the cell shows a `tool_use` with no `tool_result`, or vice versa.
- ContextPacker corruption: subsequent turns see "broken" tool spans and the agent context becomes ambiguous.

## See also

- [tool-call](../concepts/tool-call.md) — the concept this discipline protects.
- [span](../concepts/span.md) — the granular unit the rule is enforced on.
- [turn](../concepts/turn.md) — agent-internal tool calls live in the parent turn's `spans[]`.
- [operations/split-cell](../operations/split-cell.md) — invariants S1.
- [operations/merge-cells](../operations/merge-cells.md) — same-kind, same-agent precondition.
- [operations/promote-span](../operations/promote-span.md) — atomic tool-call promotion.
