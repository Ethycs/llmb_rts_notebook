# Cell

**Status**: V1 shipped
**Source specs**: [BSP-002 §2.1](../../notebook/BSP-002-conversation-graph.md#21-turn) (turn schema), [BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) (binding rule), [KB-notebook-target.md §4](../../notebook/KB-notebook-target.md#4-what-a-cell-is) (philosophical frame), [KB-notebook-target.md §0.4](../../notebook/KB-notebook-target.md#04-cell-kinds-typed-in-v1) (typed kind)
**Related atoms**: [cell-kinds](cell-kinds.md), [turn](turn.md), [section](section.md), [sub-turn](sub-turn.md)

## Definition

A **cell** is an operator-scoped issuance unit in the notebook overlay. It is the unit of human intentionality — a single semantic dispatch (one operator turn → optional agent response) bound to a single cell kind, optionally to a single agent, and addressable as a stable handle. The cell IS the turn-issuance site; everything else (turns, spans, tool calls, context) is reachable from it.

A cell is **not** a chat message, **not** equal to one execution event, and **not** allowed to mix system roles within itself.

## Schema

The cell's identity lives in `vscode.NotebookCellData.metadata.rts.cells[<cell_id>]`:

```jsonc
{
  cell_id: string,                  // VS Code's notebook-cell URI
  kind: "agent" | "markdown" | "scratch" | "checkpoint"
       | "tool" | "artifact" | "control" | "native",   // §13.2.1; V1 ships first 4
  bound_agent_id: string | null,    // for kind=agent only
  section_id: string | null,        // operator-side section membership
  capabilities: [],                 // V2+ slot, MUST be [] in V1
  // flags
  pinned?:     boolean,
  excluded?:   boolean,
  scratch?:    boolean,
  checkpoint?: boolean,
  read_only?:  boolean
}
```

Per-cell turn-bindings live under `metadata.rts.zone.agents.<id>.turns[]`; the cell's `cell_id` appears as a back-reference on each turn (`turn.cell_id`).

## Invariants

- **One cell, one kind.** Set at create, mutable only via overlay commit. The kind is enforced at metadata level so [merge invariants](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (`same primary cell kind`) work from V1.
- **One cell, one role.** Cells do not mix agent reasoning and human prose; mixing requires split. See [discipline/one-cell-one-role](../discipline/one-cell-one-role.md).
- **One cell, one bound agent (when `kind=agent`).** Multi-agent transcripts require multiple cells. Cell-as-agent-identity ([BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity)) renders the badge so the operator never has to read the directive to know who ran here.
- **Cell metadata is operator state; turn records are agent state.** Editing a cell's flags, kind, or section is an [overlay commit](overlay-commit.md). Turns themselves are [immutable](turn.md).
- **A cell with no merges has no sub-turn structure.** [Sub-turns](sub-turn.md) emerge only from merge commits; addressing `cell:c_5.1` is invalid until at least one merge has happened.
- **Re-running a cell creates a NEW turn.** The cell's previous turn stays in the DAG; `cells[<id>].metadata` may rebind to the new turn but the old `cell_id → turn_id` history is recoverable from the [run-frame](run-frame.md) records.

## V1 vs V2+

- **V1**: `kind` ∈ {`agent`, `markdown`, `scratch`, `checkpoint`}. `capabilities[]` reserved as empty. Sections are flat (no `parent_section_id`; see [decisions/v1-flat-sections](../decisions/v1-flat-sections.md)).
- **V2+**: kinds `tool`, `artifact`, `control`, `native` activate. `capabilities[]` populated with permission tokens per [KB-notebook-target.md §20](../../notebook/KB-notebook-target.md#20-security-and-capabilities). Section nesting unlocks.

## See also

- [cell-kinds](cell-kinds.md) — the typed enum and per-kind constraints.
- [section](section.md) — the operator-narrative range a cell may belong to.
- [turn](turn.md) — what the cell binds to in the immutable substrate.
- [operations/split-cell](../operations/split-cell.md) — how cells divide.
- [operations/merge-cells](../operations/merge-cells.md) — how cells combine.
- [discipline/one-cell-one-role](../discipline/one-cell-one-role.md) — the rule against mixing roles.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — split/merge always go through Cell Manager.
