# Decision: V1 has no nesting — neither sections nor merge re-merge

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [PLAN-atom-refactor.md §4 rows D3, D6](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms), [BSP-002 §13.1.1](../../notebook/BSP-002-conversation-graph.md#1311-schema--metadatartszonesections), [KB-notebook-target.md §0.1](../../notebook/KB-notebook-target.md#01-naming-reconciliation)
**Related atoms**: [decisions/v1-flat-sections](v1-flat-sections.md), [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md), [operations/merge-cells](../operations/merge-cells.md), [concepts/section](../concepts/section.md)

## The decision

**V1 forbids two kinds of nesting** at the overlay layer (Decisions D3 + D6 from PLAN-atom-refactor.md §4):

1. **No section nesting.** `parent_section_id` MUST be `null`. The schema slot exists; non-null values are rejected. See sibling atom [v1-flat-sections](v1-flat-sections.md) for the section-specific decision (D3 + D5).
2. **No re-merge of an already-merged cell.** Once `merge_cells(c_a, c_b)` produces a cell with sub-turns, that cell cannot itself participate in another merge. K94. (Decision D6.)

Together these form the **flat-overlay invariant** for V1: the operator-side overlay graph is one level deep — sections are flat, merged cells are leaves.

## Rationale

1. **Merge correctness reduces to identity.** [BSP-007 §6](../../notebook/BSP-007-overlay-git-semantics.md) merge precondition checks `same kind, same agent, no boundary between them, neither is currently executing`. With no nested sections and no re-merge, the precondition is finite and statically decidable; nested cases would force "merge-of-merges" which compounds sub-turn addressing ([sub-turn](../concepts/sub-turn.md) is already 1-indexed within a single merge — re-merge would either re-index or introduce a hierarchy of indices).

2. **Operator splits first if needed.** The escape hatch from D6 is `split_cell` then `merge_cells`. Splitting an already-merged cell removes its sub-turn structure (sub-index resets per Decision S3) so the resulting cells are merge-eligible again.

3. **Schema slots are reserved.** Producers MUST emit `parent_section_id: null`; the future V1.5 unlock is a validator change, not a schema migration. Same applies to a future `parent_merged_from` slot if V2+ wants merge hierarchies.

4. **Avoid premature abstraction.** Per [Engineering Guide §11.3](../../../Engineering_Guide.md#113-premature-abstraction): one level of nesting handles every notebook the V1 operator will write. The hierarchy comes only after we see real notebooks asking for it.

## Operational consequences

| Operation | V1 behavior | Reference |
|---|---|---|
| `create_section(parent_section_id="sec_xyz")` | **Rejected**, K-class error | [v1-flat-sections](v1-flat-sections.md) |
| `merge_cells(c_a, c_b)` where `c_a.section_id != c_b.section_id` | **Rejected** (D5; same section only) | [v1-flat-sections](v1-flat-sections.md) |
| `merge_cells(c_a, c_b)` where `c_a` already has sub-turns from a prior merge | **Rejected** with K94 (D6) | [merge-cells](../operations/merge-cells.md) |
| `merge_cells(c_a, c_b)` where `c_b` already has sub-turns from a prior merge | **Rejected** with K94 (D6) | [merge-cells](../operations/merge-cells.md) |
| `split_cell(c_5)` where `c_5` has sub-turns | Allowed; sub-turn indices reset (Decision S3) | [split-cell](../operations/split-cell.md) |
| Validator on hydrate | Reject `parent_section_id != null` AND reject any merged cell pointing at another merged cell as merge participant | [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) |

## V1 vs V1.5+ vs V2+

- **V1**: flat-overlay invariant locked. Both nesting forms rejected.
- **V1.5+**: section nesting unlocks; `parent_section_id` becomes a validated reference instead of a forced-null. Re-merge stays forbidden.
- **V2+**: re-merge MAY unlock if a real notebook needs "merge three cells in two passes." Until then, the operator's escape hatch is split-then-merge.

The schema doesn't change at any of these unlocks — only validator rules relax.

## See also

- [decisions/v1-flat-sections](v1-flat-sections.md) — the section-specific application (D3 + D5).
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — the Cell Manager enforces both rules.
- [operations/merge-cells](../operations/merge-cells.md) — where K94 fires on re-merge attempt.
- [operations/split-cell](../operations/split-cell.md) — the operator's escape hatch.
- [concepts/sub-turn](../concepts/sub-turn.md) — sub-turns are 1-indexed within ONE merge; re-merge would multiply that.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — rows D3 + D6.
