# Section

**Status**: V1 spec'd (S5.5 in BSP-005)
**Source specs**: [BSP-002 §13.1](../../notebook/BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept), [KB-notebook-target.md §6](../../notebook/KB-notebook-target.md#6-sections-and-zones), [KB-notebook-target.md §0.1](../../notebook/KB-notebook-target.md#01-naming-reconciliation) (the zone→section rename)
**Related atoms**: [cell](cell.md), [zone](zone.md), [overlay-commit](overlay-commit.md), [context-manifest](context-manifest.md)

## Definition

A **section** is an operator-defined narrative range over the cell overlay graph. It is an overlay object (created, renamed, recoloured, collapsed, deleted, re-membered by the operator without touching the immutable [turn](turn.md) DAG). Sections preserve flow at a larger scale than cells: cells are local issuance units, sections are workflow units (Architecture → Runtime → Tests).

The section is distinct from the kernel-side [zone](zone.md). Kernel `zone_id` = notebook session (one per `.llmnb` file); operator-side `section_id` = a narrative range across cells in one notebook. The two coexist; the rename was forced by name collision in [KB-notebook-target.md §0.1](../../notebook/KB-notebook-target.md#01-naming-reconciliation).

## Schema

```jsonc
"zone": {
  "sections": [
    {
      "id": "sec_01HZX...",                     // ULID; immutable
      "title": "Architecture",                   // mutable
      "parent_section_id": null,                 // V1: MUST be null (flat)
      "cell_range": [
        "vscode-notebook-cell:.../#abc",
        "vscode-notebook-cell:.../#def"
      ],                                         // ordered; display order
      "summary": null,                           // optional, used by ContextPacker
      "status": "open" | "in_progress" | "complete" | "frozen",
      "collapsed": false,
      "flow_policy": null                        // V2+ slot; MUST be null in V1
    }
  ]
}
```

A cell's section membership is mirrored on the cell side at `metadata.rts.cells[<id>].section_id`. The dual representation is enforced write-time consistent by the `MetadataWriter.submit_intent` ([decision D8](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)).

## Invariants

- **`id` is immutable.** Sections survive title rename and reordering. (Decision SD2.)
- **`title` is mutable**; `rename_section(id, new_title)` is an overlay commit.
- **V1 sections are flat.** `parent_section_id` field exists in the schema but MUST be `null` in V1. Non-null is rejected. See [decisions/v1-flat-sections](../decisions/v1-flat-sections.md). (Decision D3.)
- **`cell_range[]` is ordered.** Order in this array IS the section's display order; it MAY differ from notebook chronological order (operators reorder within sections via overlay commits).
- **`flow_policy` is V2+ reserved.** V1 producers MUST emit `null`; V1 consumers MUST ignore non-null values.
- **Sections don't span notebooks.** One section is wholly within one notebook; cross-notebook sections are not a concept.
- **Deleting a non-empty section is forbidden.** K-class error. Operator must move/delete cells out first. (Decision SD1.)
- **Section edits are overlay commits.** Creation, rename, collapse, deletion, membership change all flow through [apply-overlay-commit](../operations/apply-overlay-commit.md) per [BSP-007](../../notebook/BSP-007-overlay-git-semantics.md).

## V1 vs V2+

- **V1**: flat sections, `flow_policy: null`, status enum dropped — only `collapsed: bool` + optional `summary` ship. The full status enum lands in V2 (decision D1).
- **V2+**: nested sections via `parent_section_id`; `flow_policy` populated with per-section flow-control rules (e.g., "agent context bounded by this section unless pinned"); full `status` enum.

## See also

- [zone](zone.md) — the kernel-side concept this is NOT.
- [operations/create-section](../operations/create-section.md), [operations/delete-section](../operations/delete-section.md), [operations/rename-section](../operations/rename-section.md).
- [operations/move-cell](../operations/move-cell.md) — cross-section moves are allowed (M1); cross-checkpoint moves are not (M2).
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — why V1 forbids nesting.
- [context-manifest](context-manifest.md) — ContextPacker uses `section_id` to scope context.
