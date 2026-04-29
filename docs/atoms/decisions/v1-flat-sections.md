# Decision: V1 sections are flat (no nesting)

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [PLAN-atom-refactor.md §4 rows D3, D5](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms), [KB-notebook-target.md §0.1](../../notebook/KB-notebook-target.md#01-naming-reconciliation), [BSP-002 §13.1.1](../../notebook/BSP-002-conversation-graph.md#1311-schema--metadatartszonesections)
**Related atoms**: [section](../concepts/section.md), [decisions/v1-no-nesting](v1-no-nesting.md), [operations/move-cell](../operations/move-cell.md), [operations/merge-cells](../operations/merge-cells.md)

## The decision

**V1 [sections](../concepts/section.md) are flat. `parent_section_id` MUST be `null` in V1.** The schema field exists from day one (additive) but non-null values are rejected. V1.5+ unlocks nesting.

Two related rows from the V1 deconfliction pass land here:

- **D3** — Section nesting depth: confirmed flat. `parent_section_id` field exists but rejected if non-null.
- **D5** — Cell-merge "compatible parent section": same section only. With no nesting, there is no parent ambiguity to resolve.

## Rationale

1. **The merge-correctness rule [KB-target §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) requires "same zone or compatible parent zone."** With a single level, "compatible parent" reduces to "same section" — no ambiguity. Nesting introduces "merge cell from `Architecture > Runtime` with cell from `Architecture > Storage`?" — a question we don't want to answer in V1.

2. **Section UI surface is small in V1.** Operators see a flat strip of section headers. Adding indentation, fold-state per level, and nested drag/drop in V1 multiplies the UX surface for marginal value when most notebooks won't have ≥4 sections in V1.

3. **The schema slot is reserved.** Producers MUST emit `parent_section_id: null` and consumers MUST reject non-null. When V1.5 ships nesting, no schema migration is needed; only validator rules relax.

4. **Avoid premature abstraction.** Per [Engineering Guide §11.3](../../../Engineering_Guide.md#113-premature-abstraction): if one level of section is enough for V1's notebooks, build that. Nesting can be added once we see real notebooks asking for it.

## Operational consequences

| Operation | V1 behavior |
|---|---|
| `create_section(parent_section_id=null)` | Allowed; default. |
| `create_section(parent_section_id="sec_xyz")` | **Rejected** with K-class error. (Decision D3.) |
| `merge_cells(c_a, c_b)` where `c_a.section_id != c_b.section_id` | **Rejected** with K-class error. Same section only. (Decision D5.) |
| `move_cell(c, target_section_id)` | Allowed across sections. (Decision M1.) See [move-cell](../operations/move-cell.md). |
| Validator on hydrate / load | Reject any section with `parent_section_id != null`. |

## What unlocks in V1.5+

When nesting unlocks:

- `create_section(parent_section_id="sec_xyz")` becomes allowed.
- `merge_cells` precondition extends: same section OR same parent section (configurable).
- Renderer indents nested sections; collapse can cascade.
- The reserved `flow_policy` field on sections may interact with parent inheritance (V2+ design question).

The schema doesn't change. Only the validator rule and the renderer.

## Cross-references this decision pins

- [section](../concepts/section.md) invariants explicitly cite this decision.
- [merge-cells](../operations/merge-cells.md) precondition "same section" cites D5.
- [decisions/v1-no-nesting](v1-no-nesting.md) is the umbrella decision; this atom records the section-specific application.

## See also

- [section](../concepts/section.md) — the concept this constrains.
- [operations/create-section](../operations/create-section.md) — where the rejection is enforced.
- [operations/merge-cells](../operations/merge-cells.md) — uses this for the same-section precondition.
- [decisions/v1-no-nesting](v1-no-nesting.md) — the broader umbrella.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table this is row D3 + D5.
