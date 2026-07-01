# Operation: merge-cells

**Status**: V1 shipped — the `merge_cells` op kind ships as one of the overlay-applier's 17 op kinds ([PLAN-substrate-gap-closure G8](../../../07%20-%20Status%20Reports/PLAN-substrate-gap-closure.md), submodule `bf0cf16`); consumers dispatch via `apply_overlay_commit` with `op.kind == "merge_cells"`
**Source specs**: [BSP-007 §3.2](../../../03%20-%20Blueprint/BSP-007-overlay-git-semantics.md#32-cell-structural-new-in-this-bsp) (operation), [BSP-007 §6](../../../03%20-%20Blueprint/BSP-007-overlay-git-semantics.md#6-merge-correctness-rules-cell-merge) (correctness rules), [KB-notebook-target.md §22.1](../../../03%20-%20Blueprint/KB-notebook-target.md#221-splitmerge-invariants) (split/merge invariants), [BSP-002 §13.2.3](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#1323-cell-kind-merge-invariants-kb-target-221-forward-reference) (kind invariants), [PLAN-atom-refactor.md §4 rows D5, D6, M1](../../../07%20-%20Status%20Reports/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
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
- **Section-status gate** (per [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md)): the shared section MUST have `status ∈ {open, complete}`. `in_progress` or `frozen` → **K95**. `complete` requires `operator_confirmed: true` on the intent envelope.

If any precondition fails → **K93** (`overlay_merge_rejected` with `cell_a`, `cell_b`, `reason`); section-status failures specifically surface as **K95** (`overlay_section_status_blocks`).

### Forbidden across hard provenance boundaries (BSP-007 §6.3)

Independently of the above, merge is rejected unconditionally for: agent + tool, agent + native, tool output + checkpoint, cells from different `claude_session_id` without explicit bridge, cells separated by pin/exclude/checkpoint, cells from incompatible DAG branches, currently executing or partial cells.

### Re-merging an already-merged cell (decision D6)

Forbidden in V1. **K94**. The operator must split first if they need to re-arrange.

## What it produces (BSP-007 §6.4)

Sub-turn addressing per BSP-002 §13.3: `cell:c_a` resolves to the whole merged cell; `cell:c_a.1` ... `cell:c_a.(N+M)` resolve to individual turns in display order. `cell:c_b` becomes invalid and returns a "merged into c_a" hint per BSP-007 ref-resolution.

### Writer-owned metadata stamps (V1 decision — writer-owned)

On a successful `merge_cells(cell_a, cell_b)`, the overlay applier (`llm_kernel/overlay_applier.py`) stamps the following **writer-owned** fields on `cell_a`'s metadata record (inside `metadata.rts.cells[cell_a]`):

- **`merged_from: [cell_b, ...]`** — ordered list of absorbed cell-ids. Allows the operator UI to explain "c_b was merged into c_a" without re-walking `commits[]`. Persists across serialize/deserialize.
- **`sub_turn_addressing: True`** — signals to the renderer that `cell:c_a.k` (1-indexed) addressing is now valid for this cell.

**Ownership decision**: these fields are **writer-owned** (not renderer-derived). The trade-off:
- *Benefit*: the operator UI can surface merge history without growing the renderer's overlay-walk complexity.
- *Cost*: writer-owned fields that future renderers must respect; they cannot be ignored.

A renderer-derived alternative (walking `commits[]` at render time) was considered but rejected for V1 because overlay history depth may be unbounded. Writer-owned stamps keep the renderer O(1) for merge history.

See BSP-007 §6.4 for the sub-turn addressing semantics.

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
