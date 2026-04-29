# Turn

**Status**: V1 shipped
**Source specs**: [BSP-002 §2.1](../../notebook/BSP-002-conversation-graph.md#21-turn), [BSP-002 §2](../../notebook/BSP-002-conversation-graph.md#2-data-model--git-for-the-notebooks-turn-dag) (DAG model), [KB-notebook-target.md §0.2](../../notebook/KB-notebook-target.md#02-sub-turns-are-merge-artifacts-not-fundamental) (sub-turns are NOT native), [KB-notebook-target.md §3](../../notebook/KB-notebook-target.md#3-the-central-architectural-split) (turn DAG vs cell overlay)
**Related atoms**: [cell](cell.md), [sub-turn](sub-turn.md), [agent](agent.md), [span](span.md), [run-frame](run-frame.md)

## Definition

A **turn** is one operator-or-agent message contributed to the notebook. Immutable once persisted. Turns are the agent-truth substrate — what was actually said, by whom, when. The whole turn DAG forms an append-only graph; `agent.head_turn_id` is the mutable ref into it. This is git for the conversation: turns are commits, agents are branch refs.

Turns are NOT cells. Cells are operator-arranged issuance scopes that bind to turns; a turn typically maps to one cell, but reorganizing cells (split, merge, move) does not move or modify turns.

## Schema

Stored at `metadata.rts.zone.agents.<agent_id>.turns[]`:

```jsonc
{
  "id": "t_01HZX7K3...",
  "parent_id": "t_01HZX7J9..." | null,        // null for root turn
  "agent_id": "alpha" | null,                  // null = "most recent agent"
  "provider": "claude-code",                   // V1: only claude-code
  "claude_session_id": "9d4f-..." | null,
  "role": "operator" | "agent" | "system",
  "body": "the text typed into the cell, or the agent's response",
  "spans": [...],                              // OTLP spans for tool calls etc
  "cell_id": "vscode-notebook-cell:.../#abc",
  "created_at": "2026-04-27T17:30:00Z"
}
```

`parent_id: null` denotes the zone's root turn. The linear "mainline" is the chain reachable from the document's last cell by following `parent_id` backward. Multiple turns sharing one parent are sibling branches.

## Invariants

- **Turns are immutable.** Once persisted, `id`, `parent_id`, `role`, `body`, and `claude_session_id` never change. Re-running a cell creates a NEW turn.
- **Turns form a DAG, not a tree.** Branches share ancestors. Reverts move the agent ref; turns are never deleted.
- **`agent_id` is resolved at execution time.** Operator turns may persist with a resolved `agent_id` (the kernel rewrites null to the resolved target on persistence).
- **`spans[]` carries tool calls.** Agent-internal tool calls live as spans on the parent turn — they are NOT separate turns and NOT separate cells. See [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md).
- **Sub-turns are NOT native.** A freshly created cell containing one operator turn has no sub-turn numbering. Sub-turn structure emerges only when [merge-cells](../operations/merge-cells.md) folds two cells into one. See [sub-turn](sub-turn.md).
- **`cell_id` is a back-reference**, not a primary key. Splitting/merging cells does not modify turns; the back-reference is updated at split/merge time.
- **Each turn knows its claude session.** Reverts assign a NEW session to the agent on its next continuation; pre-revert turns keep their original `claude_session_id`. This is why the field lives on `turn`, not (only) on `agent`.

## V1 vs V2+

- **V1**: providers limited to `claude-code`; one trust boundary (operator → kernel → agents); branches preserved in the DAG but no UX for switching the rendered branch.
- **V2+**: additional providers (`gpt-cli`, `gemini`, `ollama`); branch-switching UX (pick a fork point in a sidebar / picker per [BSP-002 §11.2](../../notebook/BSP-002-conversation-graph.md#112-v2--graph-dag-with-branches)).

## See also

- [cell](cell.md) — the operator-side overlay that binds to turns.
- [sub-turn](sub-turn.md) — addressing inside merged cells.
- [agent](agent.md) — the mutable ref pointing into the turn DAG.
- [span](span.md) — what lives inside `turn.spans[]`.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — turn DAG immutable, overlay mutable.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — tool calls are spans on the parent turn, not new turns.
