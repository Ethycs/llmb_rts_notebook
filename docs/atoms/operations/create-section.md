# Operation: create-section

**Status**: V1 spec'd (lands with BSP-005 S5.5)
**Source specs**: [BSP-007 §3.3](../../notebook/BSP-007-overlay-git-semantics.md#33-section-level-new-per-kb-target-01-kb-target-6) (operation), [BSP-002 §13.1.1](../../notebook/BSP-002-conversation-graph.md#1311-schema--metadatartszonesections) (section schema), [PLAN-atom-refactor.md §4 rows D3, SD3](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [section](../concepts/section.md), [overlay-commit](../concepts/overlay-commit.md), [delete-section](delete-section.md), [rename-section](rename-section.md)

## Definition

`create_section(section_id, title, parent_section_id?, position?)` adds a new operator-side [section](../concepts/section.md) over the cell overlay graph. Sections are operator state, not agent state — creating one does not touch the immutable [turn](../concepts/turn.md) DAG. The new section starts empty (no cells); cells migrate in via [move-cell](move-cell.md) or `move_cells_into_section`.

## Operation signature

```jsonc
{
  op: "create_section",
  section_id: "sec_<ULID>",
  title: "Architecture",
  parent_section_id: null,            // V1: MUST be null per decision D3
  position: 7                         // optional; defaults per decision SD3
}
```

The full section payload populated on creation matches BSP-002 §13.1.1:

```jsonc
{
  id: "sec_...",
  title: "...",
  parent_section_id: null,
  cell_range: [],                     // empty at creation
  summary: null,
  status: "open",
  collapsed: false,
  flow_policy: null                   // V2+ reserved slot; MUST be null in V1
}
```

## Invariants / Preconditions

### Decision D3 — flat in V1
`parent_section_id` MUST be `null`. The field exists in the schema for forward compat; non-null values are rejected (W4 wire-failure equivalent). Nesting unlocks in V1.5+. See [decisions/v1-no-nesting](../decisions/v1-no-nesting.md) and [decisions/v1-flat-sections](../decisions/v1-flat-sections.md).

### Decision SD3 — explicit position; default = root, end of notebook
`position` is the index in the parent's section list at which to insert the new section. Default: append at the end of the root section list (`position = len(root.section_list)`). Operators MAY specify a position; the kernel does not auto-place into "the right" section.

### Other preconditions
- `section_id` MUST be unique within the zone. Re-using an id raises **K90** (commit-invalid).
- `title` MUST be a non-empty string.
- `id` is **immutable** post-creation (decision SD2; see [rename-section](rename-section.md) for the title-only mutation path).

## What it produces

- A new entry in `metadata.rts.zone.sections[]` with the schema above.
- No cells are moved into the new section by the create commit alone — that requires a follow-up [move-cell](move-cell.md) or a `move_cells_into_section` op (which BSP-007 §3.3 allows in the same commit for atomicity).

## V1 vs V2+

- **V1**: flat sections only (decision D3); explicit position (SD3); status `"open" | "in_progress" | "complete" | "frozen"`.
- **V2+**: nested sections (lifts D3); section-level `flow_policy` (BSP-002 §13.5.4); auto-section heuristics ("when this section grows past N cells, suggest splitting").

## See also

- [section](../concepts/section.md) — the entity being created.
- [delete-section](delete-section.md) — the inverse, with non-empty restriction (decision SD1).
- [rename-section](rename-section.md) — title-only mutation (decision SD2).
- [overlay-commit](../concepts/overlay-commit.md) — how the create is recorded.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — flat-section corollary.
- [decisions/v1-no-nesting](../decisions/v1-no-nesting.md) — why `parent_section_id: null` in V1.
