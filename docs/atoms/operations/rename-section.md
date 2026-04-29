# Operation: rename-section

**Status**: V1 spec'd (lands with BSP-005 S5.5)
**Source specs**: [BSP-007 §3.3](../../notebook/BSP-007-overlay-git-semantics.md#33-section-level-new-per-kb-target-01-kb-target-6) (operation), [BSP-002 §13.1.1](../../notebook/BSP-002-conversation-graph.md#1311-schema--metadatartszonesections) (section schema), [PLAN-atom-refactor.md §4 row SD2](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [section](../concepts/section.md), [overlay-commit](../concepts/overlay-commit.md), [create-section](create-section.md), [delete-section](delete-section.md)

## Definition

`rename_section(section_id, title)` updates the operator-facing label on an existing [section](../concepts/section.md). The section's `id` is **immutable** — only `title` may be changed. The change is recorded as one [overlay commit](../concepts/overlay-commit.md). No [turn](../concepts/turn.md) is touched; no cell moves.

## Operation signature

```jsonc
{
  op: "rename_section",
  section_id: "sec_...",
  title: "Architecture (revised)"
}
```

## Decision SD2 — id immutable, title mutable

The section id (`sec_<ULID>`) is the operator-stable identifier. It survives reordering, rename, collapse, and the eventual V1.5+ nesting. Renaming changes only the human-facing title.

This split exists because:

- **Stable refs**: every cell carries `metadata.rts.cells[<id>].section_id` (BSP-002 §13.2.1). A mutable id would break the [decisions/v1-no-nesting](../decisions/v1-no-nesting.md) sibling decision **D8** (dual-representation invariant) the moment an operator renamed.
- **Human flexibility**: titles change as the work evolves ("Architecture" → "Architecture (revised)" → "Architecture v2"). The title is presentational; the id is structural.
- **Audit trail**: history mode (KB-target §18) walks overlay commits and shows readable rename diffs; stable ids let history present "this section was renamed" instead of "this section disappeared and a new one appeared."

## Invariants / Preconditions

- `section_id` MUST exist; else **K90** with `reason: "unknown_section"`.
- `title` MUST be a non-empty string. Empty / null titles are rejected.
- The section MUST NOT be currently being mutated by another in-flight commit (CAS protection per BSP-003's snapshot-version mechanism).
- No cell movements occur. `cell_range[]` is unchanged. `parent_section_id`, `summary`, `status`, `collapsed`, `flow_policy` are unchanged.

## What it produces

- `metadata.rts.zone.sections[<id>].title` is updated to the new value.
- Open notebook UIs re-render the section header on the next snapshot.
- History mode shows the rename as a single commit op with the before/after titles.

## V1 vs V2+

- **V1**: title only.
- **V2+**: bulk-rename across patterns; rename with redirect-link in history; per-section status enum expansion (decision **D1** lift — V1 ships `collapsed: bool` + `summary?: string` only, no status enum yet).

## See also

- [create-section](create-section.md) — initial title is set there.
- [delete-section](delete-section.md) — the way to "rename to nothing."
- [section](../concepts/section.md) — the entity being relabeled.
- [overlay-commit](../concepts/overlay-commit.md) — how the rename is recorded.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — sibling SD-class decisions.
