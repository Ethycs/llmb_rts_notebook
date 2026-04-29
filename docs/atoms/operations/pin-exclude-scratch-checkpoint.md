# Operation: pin / exclude / scratch / checkpoint flag toggles

**Status**: V1 shipped (lands with overlay-commit infrastructure)
**Source specs**: [BSP-007 §3.1](../../notebook/BSP-007-overlay-git-semantics.md#31-cell-level-existing-in-bsp-003-5-now-wrapped-in-commits) (operations), [KB-notebook-target.md §7](../../notebook/KB-notebook-target.md#7-scope-control) (visible-toggle discipline), [KB-notebook-target.md §13.4](../../notebook/KB-notebook-target.md#134-scratch-is-notebook-level-not-hidden-configuration) (scratch), [PLAN-atom-refactor.md §4 row F1](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [cell](../concepts/cell.md), [overlay-commit](../concepts/overlay-commit.md), [run-frame](../concepts/run-frame.md), [discipline/scratch-beats-config](../discipline/scratch-beats-config.md)

## Definition

The four cell-flag toggles — **pin**, **exclude**, **scratch**, **checkpoint** — are kin: each is a one-field mutation on `metadata.rts.cells[<id>]`, recorded as one [overlay commit](../concepts/overlay-commit.md) via BSP-007. They are collected in this atom because the schema, validation, and effect shape are identical; only the field name and downstream semantics differ.

## Operation signatures

```jsonc
{ op: "set_pin",        cell_id: "...", pinned: bool }
{ op: "set_exclude",    cell_id: "...", excluded: bool }
{ op: "set_scratch",    cell_id: "...", scratch: bool }
{ op: "set_checkpoint", cell_id: "...", checkpoint: bool }
```

All four wrap inside an `apply_overlay_commit` envelope per BSP-007 §8 — they may be batched in one commit (e.g., "pin all architecture cells, exclude obsolete branch").

## Per-flag semantics

| Flag | Meaning | ContextPacker effect (BSP-008) | Notes |
|---|---|---|---|
| `pinned` | Force this cell into context regardless of section / order | Always included | Boundary for [merge-cells](merge-cells.md) and [move-cell](move-cell.md) |
| `excluded` | Bar from context | Always excluded | Boundary for merge/move |
| `scratch` | Temporary workspace; not part of agent context by default | Excluded by default ([discipline/scratch-beats-config](../discipline/scratch-beats-config.md)) | Visually marked; promotable to another kind via overlay commit |
| `checkpoint` | Promote/demote to checkpoint cell | Substitutes summary for raw turns when included | Subject to **CK1** (operator-only authorship in V1), **CK2** (post-checkpoint cells overlay-frozen), **CK3** (revert via `revert_to_commit`) |

## Invariants / Preconditions

- `cell_id` MUST exist.
- The cell MUST NOT be currently executing (KB-target §22.7).
- For `set_checkpoint(true)` in V1, the operator authors the checkpoint summary (decision **CK1**); AI-summarized checkpoints are V2+. The cell carries `bound_agent_id: null` and `summary_text` + `covers_cell_ids[]` per [decisions/v1-no-nesting](../decisions/v1-no-nesting.md)'s sibling decision **D4**.
- After `set_checkpoint(true)`, the covered cell range becomes overlay-frozen (read-only via the overlay layer; underlying turns remain valid). Decision **CK2**.
- Reversibility: any of the four toggles may be reverted via [revert-overlay-commit](revert-overlay-commit.md). Specifically, an applied checkpoint is reversible per decision **CK3** (BSP-007 `revert_to_commit`), or via an explicit `uncheckpoint_section` op.

### Decision F1 — flag toggles do NOT affect existing RunFrames

A flag toggle creates new state for **future** runs. RunFrames already recorded against this cell are immutable historical records (per [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md)) and are unchanged by the toggle. Re-running the cell after a flag change produces a new RunFrame that observes the new flag state.

## V1 vs V2+

- **V1**: four flags, operator-authored only. Checkpoint summaries are operator text.
- **V2+**: AI-authored / AI-suggested checkpoint summaries (per CK1 lifting); additional flags (`obsolete`, `divergent`) become first-class toggles instead of derived state.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the envelope each toggle commits through.
- [run-frame](../concepts/run-frame.md) — what F1 protects (immutable historical records).
- [merge-cells](merge-cells.md) — pin / exclude / checkpoint flags are unmergeable boundaries.
- [move-cell](move-cell.md) — same boundaries forbid cross-checkpoint moves.
- [discipline/scratch-beats-config](../discipline/scratch-beats-config.md) — why these are visible toggles instead of policy languages.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — why F1 holds.
- [revert-overlay-commit](revert-overlay-commit.md) — how to undo any of these.
