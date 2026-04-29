# Sub-turn

**Status**: V1 shipped (addressing only; cells gain sub-turn structure only after a merge commit)
**Source specs**: [BSP-002 §13.3](../../notebook/BSP-002-conversation-graph.md#133-sub-turns-as-merge-artifacts-kb-target-02), [KB-notebook-target.md §0.2](../../notebook/KB-notebook-target.md#02-sub-turns-are-merge-artifacts-not-fundamental), [KB-notebook-target.md §14](../../notebook/KB-notebook-target.md#14-addressing-modes) (addressing modes)
**Related atoms**: [cell](cell.md), [turn](turn.md), [overlay-commit](overlay-commit.md)

## Definition

A **sub-turn** is the addressable position of one [turn](turn.md) inside a merged [cell](cell.md). It is NOT a native cell substructure: a freshly created cell containing one operator turn has no sub-turn numbering. Sub-turn structure emerges only when [merge-cells](../operations/merge-cells.md) folds two or more cells into one. The sub-turn handle lets inbound references survive a merge — `cell:c_5.2` continues to resolve the same underlying turn even though the cell that originally held it (`c_6`) no longer exists in the overlay.

## Schema

Sub-turns have no separate storage. The address is a derived view over `metadata.rts.zone.agents.<id>.turns[]` ordered by the merged cell's `cell_range`-equivalent ordering of the constituent turns:

```text
cell:<cell_id>          → the whole cell (one or more sub-turns combined)
cell:<cell_id>.<n>      → the n-th sub-turn within a merged cell, 1-INDEXED
                          in operator-display order
```

Index `0` is reserved (never emitted; invalid). The sub-index increments by 1 per constituent turn. There is no `cell:<id>.0` and no nesting — `cell:c_5.2.1` is not a thing.

## Invariants

- **Sub-turns are NOT native.** A cell that has never been the target of a merge has no sub-turn structure. Addressing `cell:c_5.1` against an unmerged cell is invalid and SHOULD return a "no sub-turns yet" hint.
- **1-indexed.** The first sub-turn is `.1`, never `.0`.
- **Order is operator-display order**, not chronological turn order. After `merge_cells(c_5, c_6)`, `c_5.1` is the first turn in c_5's pre-merge `cell_range` and `c_5.2` is the first turn from c_6 — even if c_6's turn is older in wall-clock time.
- **The underlying [turn](turn.md) is unchanged.** Merge is an [overlay-commit](overlay-commit.md); it touches `cell_range` and removes c_6's cell metadata only. The DAG never moves.
- **Split resets to flat.** A `split_cell` overlay commit removes sub-turn numbering from both halves; addressing `cell:c_5.2` is invalid after the split (decision S3). The freshly-named cell carries the orphaned turn under its own bare `cell:<new_id>` address.
- **No cross-cell sub-turns.** `cell:c_5.2` always refers to a turn whose cell-overlay parent is c_5; if a future operation moves t_b out of c_5, the old sub-turn handle is invalidated, not redirected.

## V1 vs V2+

- **V1**: addressing is shipped (`cell:<id>.<n>`); sub-turn structure emerges only from merge commits; split resets to flat.
- **V2+**: no schema change. Possible UX surface improvement: graphical "fold/unfold" of sub-turns inside a merged cell.

## See also

- [operations/merge-cells](../operations/merge-cells.md) — produces sub-turns.
- [operations/split-cell](../operations/split-cell.md) — undoes them (decision S3).
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — the same flat-vs-nested discipline applied to sections.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — split/merge always go through Cell Manager.
