# Operation: merge-cells

**Status**: V1 spec'd (lands with overlay-commit infrastructure in BSP-005 S5.5+)
**Source specs**: [BSP-007 §3.2](../../notebook/BSP-007-overlay-git-semantics.md#32-cell-structural-new-in-this-bsp) (operation), [BSP-007 §6](../../notebook/BSP-007-overlay-git-semantics.md#6-merge-correctness-rules-cell-merge) (correctness rules), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (split/merge invariants), [BSP-002 §13.2.3](../../notebook/BSP-002-conversation-graph.md#1323-cell-kind-merge-invariants-kb-target-221-forward-reference) (kind invariants), [PLAN-atom-refactor.md §4 rows D5, D6, M1](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [cell](../concepts/cell.md), [sub-turn](../concepts/sub-turn.md), [overlay-commit](../concepts/overlay-commit.md), [split-cell](split-cell.md), [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md)

## Definition

`merge_cells(cell_a, cell_b)` is the overlay operation that combines two adjacent cells into one. `cell_a` survives; `cell_b` is removed. `cell_b`'s turns are appended to `cell_a` in display order, producing [sub-turns](../concepts/sub-turn.md) addressed `cell:c_a.1 ... cell:c_a.(N+M)`. The underlying [turn](../concepts/turn.md) DAG is unchanged; the merge is recorded as one [overlay commit](../concepts/overlay-commit.md). Merge is the inverse of [split-cell](split-cell.md) — but only structurally; many merges are forbidden by the provenance invariants below.

> Merge preserves provenance or it is not a merge. (KB-target §22.1)

## Operation signature

```jsonc
{
  op: "merge_cells",
  cell_a: "<surviving cell>",
  cell_b: "<absorbed cell>"
}
```

Resulting state: `cell_a` carries `[t_a..., t_b...]` in `cell_range[]`; `cell_b`'s metadata entry is deleted; sub-turn addresses `cell:c_a.k` (1-indexed) become valid. RunFrames pointing at either original cell remain immutable historical records.

## Invariants / Preconditions (BSP-007 §6.1 + decisions M1, D5, D6, F1)

Merge is allowed only if **all** the following hold:

- **Same primary cell kind** (BSP-002 §13.2.3, decision D5). `c_a.kind == c_b.kind`. Reserved kinds (`tool | artifact | control | native`) error in V1.
- **Same agent provenance** when `kind == "agent"`: `c_a.bound_agent_id == c_b.bound_agent_id`.
- **Same section** (decision D5; flat-section corollary of [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — no nesting means no parent-section ambiguity).
- **No pin / exclude / checkpoint boundary** between them in materialized order (KB-target §22.1; checkpoints are unmergeable boundaries per decision M2's sibling rule).
- **Neither cell is currently executing** (KB-target §22.7; decision F1's adjacent rule).
- **Append preserves turn ordering**: `c_a`'s last turn must be the parent of `c_b`'s first turn, or they share the same parent and `c_b` is the chronologically later sibling.
- **Bindings remain unambiguous** — no two turns in the merged cell may bind the same artifact span ambiguously.

If any precondition fails → **K93** (`overlay_merge_rejected` with `cell_a`, `cell_b`, `reason`).

### Forbidden across hard provenance boundaries (BSP-007 §6.3)

Independently of the above, merge is rejected unconditionally for: agent + tool, agent + native, tool output + checkpoint, cells from different `claude_session_id` without explicit bridge, cells separated by pin/exclude/checkpoint, cells from incompatible DAG branches, currently executing or partial cells.

### Re-merging an already-merged cell (decision D6)

Forbidden in V1. **K94**. The operator must split first if they need to re-arrange.

## What it produces (BSP-007 §6.4)

Sub-turn addressing per BSP-002 §13.3: `cell:c_a` resolves to the whole merged cell; `cell:c_a.1` ... `cell:c_a.(N+M)` resolve to individual turns in display order. `cell:c_b` becomes invalid and returns a "merged into c_a" hint per BSP-007 ref-resolution.

## V1 vs V2+

- **V1**: same-section, same-kind, same-agent merges only. Re-merge forbidden.
- **V2+**: cross-section merges if both cells share a compatible parent section (unblocked when [decisions/v1-no-nesting](../decisions/v1-no-nesting.md) lifts in V1.5+).

## See also

- [split-cell](split-cell.md) — the inverse operation.
- [cell](../concepts/cell.md) — the entity being merged.
- [sub-turn](../concepts/sub-turn.md) — the addressing artifact merge produces.
- [overlay-commit](../concepts/overlay-commit.md) — how the merge is recorded.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — why "same section" is unambiguous.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — same-agent, tool-call atomicity reasoning.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — merge always goes through the Cell Manager.
