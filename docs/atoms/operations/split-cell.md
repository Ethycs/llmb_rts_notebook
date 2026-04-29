# Operation: split-cell

**Status**: V1 spec'd (lands with overlay-commit infrastructure in BSP-005 S5.5+)
**Source specs**: [BSP-007 §3](../../notebook/BSP-007-overlay-git-semantics.md) (overlay operation enumeration), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (split/merge invariants), [BSP-002 §13.3.3](../../notebook/BSP-002-conversation-graph.md#1333-splitting-back) (split as merge inverse), [PLAN-atom-refactor.md §4 rows S1-S6](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [cell](../concepts/cell.md), [span](../concepts/span.md), [sub-turn](../concepts/sub-turn.md), [overlay-commit](../concepts/overlay-commit.md), [merge-cells](merge-cells.md)

## Definition

`split_cell(cell_id, at)` is the overlay operation that divides one cell into two adjacent cells along a span boundary OR a character offset inside a text span. The underlying [turn](../concepts/turn.md) DAG is unchanged; the split is recorded as an [overlay commit](../concepts/overlay-commit.md). Split is the inverse of [merge-cells](merge-cells.md) — but only structurally; some splits are forbidden by the cell-role invariant.

Split preserves valid cell roles or it is not a split.

## Operation signature

```jsonc
{
  op: "split_cell",
  cell_id: "<source cell>",
  at: { kind: "span_boundary",  before_span_index: int }
     | { kind: "char_offset",   span_index: int, char_offset: int }
}
```

Resulting state: `cell_id` keeps the prefix; a new cell `cell_id_b` is inserted immediately after, same section, same kind, same flag inheritance. RunFrames pointing at the original `cell_id` keep pointing at it (decision S5).

## Invariants

### Where you may split (decision S1)

| Boundary | Allowed |
|---|---|
| Between any two spans | **Yes** |
| Inside a `text` / `prose` span at a character offset | **Yes** (overlay records `char_offset`) |
| Inside a `tool_use` span | **No** — tool calls are atomic ([discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md)) |
| Inside a `tool_result` span | **No** — same reason |
| Inside a `system_message` span | **No** |
| Inside a `result` span (terminal) | **No** |

### Cell-level preconditions (decisions S2 + S5 + KB-target §22.7)

- **Source cell must have ≥2 turns OR ≥2 spans worth splitting.** Forbidden on a single-turn, single-span cell. K-class error (decision S2). The merge invariants ([KB-target §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants)) make this symmetric with merge.
- **Cell must not be currently executing.** No split during execution; stop the run first.
- **No pin/exclude/checkpoint boundary may lie at the split point** without an explicit flag-handling decision by the operator.

### What the split produces (decisions S3, S4, S6)

- **Sub-turn renumbering**: reset to flat. Both halves drop sub-index numbering. The underlying turn DAG is unchanged; the split is overlay-only. (Decision S3.)
- **Flag inheritance**: both halves inherit `kind`, `section_id`, `pinned`, `excluded`, `scratch` from the original. The operator may adjust after. (Decision S4.)
- **Position**: the new cell `cell_id_b` lands immediately after the original, in the same section. (Decision S6.)
- **RunFrames**: stay pointing at the original `cell_id`. Inspect mode renders "this run was on c_5 (since split into c_5a + c_5b)." RunFrames are immutable historical records. (Decision S5.)

### What split forbids

- Splitting inside `tool_use` / `tool_result` / `system_message` / `result` spans (decision S1; keeps tool calls atomic).
- Splitting a single-turn cell with no internal span structure (decision S2).
- Splitting a currently-executing cell ([KB-target §22.7](../../notebook/KB-notebook-target.md#227-conflict-resolution)).

## V1 vs V2+

- **V1**: overlay records the split as one commit per [BSP-007](../../notebook/BSP-007-overlay-git-semantics.md); flat sub-turn renumbering; no operator UI yet for selecting char offsets inside spans (CLI / programmatic only).
- **V2+**: char-offset selection in the cell editor; bulk-split affordances; conflict resolution if a split overlaps an active overlay edit.

## See also

- [merge-cells](merge-cells.md) — the inverse operation.
- [cell](../concepts/cell.md) — the entity being divided.
- [span](../concepts/span.md) — the granular unit split operates on.
- [overlay-commit](../concepts/overlay-commit.md) — how the split is recorded.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — why splitting inside tool spans is forbidden.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — split goes through Cell Manager, not raw editing.
