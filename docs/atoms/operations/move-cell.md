# Operation: move-cell

**Status**: V1 spec'd (lands with BSP-005 S5.5)
**Source specs**: [BSP-007 §3.2](../../notebook/BSP-007-overlay-git-semantics.md#32-cell-structural-new-in-this-bsp) (operation), [BSP-007 §6](../../notebook/BSP-007-overlay-git-semantics.md#6-merge-correctness-rules-cell-merge) (boundary rules), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (provenance boundaries), [PLAN-atom-refactor.md §4 rows M1-M3](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [cell](../concepts/cell.md), [section](../concepts/section.md), [overlay-commit](../concepts/overlay-commit.md), [merge-cells](merge-cells.md), [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md)

## Definition

`move_cell(cell_id, target_section_id, position_index)` relocates a cell into a (possibly different) [section](../concepts/section.md) at an explicit position. The cell carries its boundary semantics with it (a checkpoint cell remains a checkpoint after the move). The underlying [turn](../concepts/turn.md) DAG is unchanged; the move is recorded as one [overlay commit](../concepts/overlay-commit.md).

## Operation signature

```jsonc
{
  op: "move_cell",
  cell_id: "<cell-uri>",
  target_section_id: "sec_...",
  position: 3                     // 0-indexed insertion index in target_section.cell_range[]
}
```

For bulk moves, BSP-007 §3.3 also defines `move_cells_into_section(cell_ids[], target_section_id, position)` — equivalent to a sequence of `move_cell` ops, applied atomically inside one commit.

## Invariants / Preconditions

### Decision M1 — cross-section allowed
Moving a cell from one section to another is **allowed**. Sections are operator overlays; cells migrate freely across them subject to the boundary rules below.

### Decision M2 — cross-checkpoint forbidden
Moving a cell across a **checkpoint boundary** is forbidden. Checkpoints are unmergeable boundaries (KB-target §22.1) and the same provenance reasoning forbids relocation across them. **K93**-class rejection (the validator surfaces `reason: "checkpoint_boundary"`).

The same rule applies to pin and exclude boundaries when the target position would place the cell on the wrong side of an active pin/exclude that was previously protecting it.

### Decision M3 — explicit destination required
Both `target_section_id` AND `position_index` MUST be specified. **No auto-tail.** Convenience wrappers in the extension UI may compute the position, but the kernel-side intent envelope rejects ambiguous moves.

### Other preconditions
- `cell_id` MUST exist.
- `target_section_id` MUST exist (use [create-section](create-section.md) first if needed).
- `position` MUST be in `[0, len(target_section.cell_range)]` (insertion index).
- The cell MUST NOT be currently executing (KB-target §22.7).
- The move MUST NOT split a turn from its required tool-call children (mirrored from [split-cell](split-cell.md) preconditions / [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md)).

## What it produces

- The cell's `metadata.rts.cells[<id>].section_id` is updated to `target_section_id`.
- The source section's `cell_range[]` removes `cell_id`; the target section's `cell_range[]` inserts it at `position`.
- The dual-representation invariant ([decisions/v1-flat-sections](../decisions/v1-flat-sections.md), decision D8) — `cells[].section_id` ↔ `sections[].cell_range[]` — is enforced by the MetadataWriter at submit-intent time.
- RunFrames are unaffected (decision F1's spirit: history records are immutable).

## V1 vs V2+

- **V1**: explicit `(target_section_id, position_index)` only; no cross-checkpoint moves.
- **V2+**: drag-handle UX in the notebook view; smart "move with neighbors" affordance for span-grouped cells; soft cross-checkpoint move with operator confirmation.

## See also

- [merge-cells](merge-cells.md) — the same boundary rules govern merge.
- [section](../concepts/section.md) — the container being changed.
- [cell](../concepts/cell.md) — the entity being relocated.
- [overlay-commit](../concepts/overlay-commit.md) — how the move is recorded.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — moves never go around the Cell Manager.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — why `target_section_id` is unambiguous in V1.
