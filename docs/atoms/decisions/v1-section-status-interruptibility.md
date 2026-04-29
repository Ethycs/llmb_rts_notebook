# Decision: section.status is the V1 interruptibility lock (supersedes D1)

**Status**: decision (V1 lock-in, 2026-04-29; supersedes PLAN §4 row D1)
**Source specs**: [PLAN-atom-refactor.md §4 row D1](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) (the row this supersedes), [BSP-002 §13.1](../../notebook/BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept), [KB-notebook-target.md §22.7](../../notebook/KB-notebook-target.md#227-conflict-resolution) (cell-level execution gate this aggregates from), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (provenance boundaries)
**Related atoms**: [section](../concepts/section.md), [operations/set-section-status](../operations/set-section-status.md), [decisions/v1-flat-sections](v1-flat-sections.md)

## The decision

**`section.status` ships in V1 as the section-level interruptibility lock.** The four-value enum (`open | in_progress | complete | frozen`) is kept in the schema as a required field, with operational semantics: each value gates structural operations on cells inside the section.

This **supersedes PLAN §4 row D1** ("Drop the enum in V1; ship `collapsed: bool` + `summary?` only. Add status enum in V2"). D1 was written under the assumption that `status` had no V1 consumer; reframing the field as interruptibility (rather than as a workflow label) gives it a real consumer in every overlay-commit operation.

## What each value means

| Value | Section state | Operations gated |
|---|---|---|
| `open` | Default. Fully editable. | Nothing blocked. |
| `in_progress` | A run is active inside this section. | All structural ops on member cells: [split-cell](../operations/split-cell.md), [merge-cells](../operations/merge-cells.md), [move-cell](../operations/move-cell.md), [promote-span](../operations/promote-span.md), [delete-section](../operations/delete-section.md). Aggregates the cell-level rules from [KB-target §22.7](../../notebook/KB-notebook-target.md#227-conflict-resolution) one level up. |
| `complete` | Operator-marked done. Editable but with confirmation. | Soft block — overlay commits prompt "this section is marked complete, proceed?" The kernel records an `operator_confirmed: true` flag on the commit. |
| `frozen` | Hard lock. | All structural ops on member cells. Only [set-section-status](../operations/set-section-status.md) (transition to `open`) lifts it. Pairs naturally with the post-checkpoint cell freeze ([CK2 from PLAN §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)). |

## Why interruptibility (not workflow labels)

The original D1 row interpreted `status` as a kanban-style workflow tag (todo / doing / done / archived). With that reading, no V1 algorithm cares — the field would be a sticky note. Drop it.

The interruptibility reading is different: `status` is a **boundary condition** the kernel checks before applying any structural commit. That ties it into existing V1 invariants:

- [KB-target §22.7](../../notebook/KB-notebook-target.md#227-conflict-resolution) already specifies cell-level "no merge during execution / no split during execution / no checkpointing a running cell." `status: "in_progress"` is the section-scoped aggregate of that rule — when a run begins inside section S, the section flips to `in_progress` and the rule auto-extends to every cell in S without per-cell bookkeeping.
- [KB-target §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) already lists checkpoints as unmergeable boundaries. `status: "frozen"` extends that to operator-declared boundaries: a section the operator has signed off on can't be quietly restructured later.
- [decision CK2 from PLAN §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) requires post-checkpoint cells to be overlay-frozen; setting the enclosing section's status to `frozen` is the natural mechanism.

## Operational consequences

- Every operation in [docs/atoms/operations/](../operations/) that mutates cells inside a section gains a "Section status precondition" check. K-class error: **K95** (`overlay_section_status_blocks` with `section_id`, `current_status`, `required_status`).
- A new operation atom: [operations/set-section-status](../operations/set-section-status.md) is the canonical way to transition. Free-form mutation of `metadata.rts.zone.sections[<id>].status` is rejected by the MetadataWriter.
- The transition rules:
  - `open ↔ complete`: free.
  - `open ↔ in_progress`: kernel-driven (a cell's run starts → flip to `in_progress`; all runs end → flip back to `open`). Operator MAY set manually.
  - `* → frozen`: operator only.
  - `frozen → open`: operator only; requires explicit unfreeze intent (no implicit transition).
- The [section atom](../concepts/section.md) V1 vs V2+ note flips: V1 ships the enum AND the precondition checks. V2+ adds lensing/filtering UI ("show only complete sections").

## What V2+ adds (unchanged)

- Lens UI: filter the rendered notebook by section status.
- Per-status visual treatment: greyed-out frozen sections, progress-bar in-progress sections, etc.
- Status-driven ContextPacker behavior (e.g., `frozen` sections collapse to summary-only inclusion).

## See also

- [section](../concepts/section.md) — the schema this updates.
- [operations/set-section-status](../operations/set-section-status.md) — the canonical mutation.
- [operations/split-cell](../operations/split-cell.md), [merge-cells](../operations/merge-cells.md), [move-cell](../operations/move-cell.md), [promote-span](../operations/promote-span.md), [delete-section](../operations/delete-section.md) — operations that gain the precondition.
- [KB-target §22.7](../../notebook/KB-notebook-target.md#227-conflict-resolution) — the cell-level execution gate this aggregates.
