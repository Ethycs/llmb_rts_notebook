# Operation: delete-section

**Status**: V1 spec'd (lands with BSP-005 S5.5)
**Source specs**: [BSP-007 §3.3](../../notebook/BSP-007-overlay-git-semantics.md#33-section-level-new-per-kb-target-01-kb-target-6) (operation), [BSP-007 §9](../../notebook/BSP-007-overlay-git-semantics.md#9-test-surface) (`test_section_delete_requires_empty`), [PLAN-atom-refactor.md §4 row SD1](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [section](../concepts/section.md), [overlay-commit](../concepts/overlay-commit.md), [create-section](create-section.md), [move-cell](move-cell.md)

## Definition

`delete_section(section_id)` removes an empty operator-side [section](../concepts/section.md) entry from `metadata.rts.zone.sections[]`. Like all section ops, this is overlay-only — no [turn](../concepts/turn.md) is touched. Deleting a non-empty section is **forbidden** in V1; the operator must first [move-cell](move-cell.md) every cell out (or include the moves in the same overlay commit per BSP-007's `move_cells_into_section` op).

## Operation signature

```jsonc
{ op: "delete_section", section_id: "sec_..." }
```

For atomic empty-and-delete, BSP-007 §3.3 allows packaging moves and the delete in one commit:

```jsonc
{
  message: "fold Architecture into Runtime",
  operations: [
    { op: "move_cells_into_section",
      cell_ids: ["c_4", "c_5", "c_6"],
      target_section_id: "sec_runtime",
      position: 12 },
    { op: "delete_section", section_id: "sec_arch" }
  ]
}
```

The whole commit applies atomically per BSP-007 §4.1: if the move-out fails preconditions, the delete is also rejected and `HEAD` does not advance.

## Invariants / Preconditions

### Decision SD1 — non-empty deletion forbidden
If `metadata.rts.zone.sections[<id>].cell_range.length > 0`, the delete operation fails. Per BSP-007 §9 (`test_section_delete_requires_empty`) the failure surfaces as **K90** (`overlay_commit_invalid` with `failed_operation_index`, `reason: "section_not_empty"`).

This is a deliberate K-class error, not a soft warning. The operator's options:
1. Move every cell out first (separate commits or one combined commit), then delete.
2. If the section's cells are obsolete, [move-cell](move-cell.md) them to a `sec_archive` (the operator's choice; not a special section in V1).

### Other preconditions
- `section_id` MUST exist; otherwise K90 with `reason: "unknown_section"`.
- The section MUST NOT be the root section (the root has no `id` in V1; this is implicit).

## What it produces

- The matching entry in `metadata.rts.zone.sections[]` is removed.
- No cells are affected (precondition guaranteed empty).
- The dual-representation invariant (decision **D8**) is trivially preserved — there were no cells claiming `section_id` to update.

## V1 vs V2+

- **V1**: hard non-empty restriction; explicit move-then-delete workflow.
- **V2+**: soft delete with operator confirmation ("this section has 14 cells; move them where?"); section recycle bin; cascade-delete with explicit opt-in.

## See also

- [create-section](create-section.md) — the inverse.
- [section](../concepts/section.md) — the entity being removed.
- [move-cell](move-cell.md) — the prerequisite for emptying a section.
- [overlay-commit](../concepts/overlay-commit.md) — how the delete is recorded.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — flat-section context for SD1.
