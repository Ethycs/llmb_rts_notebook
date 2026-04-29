# Plan: S5.5 — Sections (overlay-graph narrative range)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: implement `metadata.rts.zone.sections[]` per [section atom](../atoms/concepts/section.md) and [BSP-002 §13.1](BSP-002-conversation-graph.md), including the four V1 status values as the interruptibility lock per [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md). Wire the create / rename / delete operations and the cell ↔ section dual-representation invariant.
**Time budget**: 1.5 days. Cross-layer (kernel + extension). Two-agent parallelizable (K-MW-S5.5 + X-EXT-S5.5).

---

## §1. Why this work exists

Operators currently have no way to group cells into named ranges. As notebooks grow past a dozen cells, the visual structure is just chronological order — operators cannot say "Architecture", "Runtime", "Tests" and have those become real organizing units. Worse, ContextPacker's "previous cells in current section" rule (per [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md)) has nothing to consult.

S5.5 lands the section overlay object plus the four status values that double as the interruptibility lock for structural ops on member cells.

Driver: [KB-notebook-target.md §0.1, §6](KB-notebook-target.md). Slice spec: [BSP-005 §6.3](BSP-005-cell-roadmap.md#63-s55--sections-overlay-graph-narrative-range-new). Atoms: [section](../atoms/concepts/section.md), [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md), [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md), [operations/create-section](../atoms/operations/create-section.md), [operations/rename-section](../atoms/operations/rename-section.md), [operations/delete-section](../atoms/operations/delete-section.md), [operations/set-section-status](../atoms/operations/set-section-status.md).

Hard dependencies:
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) shipped (`kind` field on cells exists).
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) shipped — this slice rides the same overlay-commit machinery.
- Substrate gaps G2 (overlay-commit intent kinds) and G8 (`OverlayApplier` module) MUST be closed first; see [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md).

## §2. Goals and non-goals

### Goals

- `metadata.rts.zone.sections[]` is real persisted state per [section atom §"Schema"](../atoms/concepts/section.md).
- Four operations land: `create_section`, `rename_section`, `delete_section`, `set_section_status` — all routed through `OverlayApplier`.
- `parent_section_id` slot exists but MUST be `null`; non-null is rejected per [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md).
- Cell ↔ section dual representation enforced write-time consistent: `cells[<id>].section_id` and `sections[<id>].cell_range[]` agree on every snapshot.
- Status enum (`open | in_progress | complete | frozen`) is the V1 interruptibility lock per [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md). Every structural op on member cells gains a status precondition gated by K95.
- Extension renders sections as collapsible headers; clicking a header expands/collapses the contained cells.

### Non-goals

- Nested sections (V1.5+; the `parent_section_id` slot is reserved but inactive per [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md)).
- `flow_policy` populated (V2+).
- Lensing/filtering UI ("show only complete sections") — V2+.
- Sidebar tree views — those land in [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md).

## §3. Concrete work

1. **Persistence schema.** In `MetadataWriter`'s zone state, add `sections: list[dict]` per [section atom §"Schema"](../atoms/concepts/section.md). Hydrate path round-trips it; snapshot path emits it under Family F.

2. **Four overlay operations** — all sub-kinds inside `apply_overlay_commit` per [overlay-commit atom](../atoms/concepts/overlay-commit.md):
   - `create_section { id, title, parent_section_id, cell_range, status: "open", collapsed: false }`. Validator: `parent_section_id == null` (else K42 with `flat_sections_only`); `id` must be unique; `cell_range[]` cells must exist and currently have `section_id == null` (else K42 with `cell_already_in_section`).
   - `rename_section { id, new_title }`. Validator: section exists; `id` unchanged.
   - `delete_section { id }`. Validator: `cell_range[]` empty (else K-class error per SD1 — surface as K42 with `delete_non_empty_section`). Operator must move/delete cells out first.
   - `move_cells_into_section { section_id, cell_ids[] }`. Validator: target section exists; `cell_ids[]` valid; respect M2 cross-checkpoint forbidding via K42.

3. **Status machinery** per [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md) and [operations/set-section-status](../atoms/operations/set-section-status.md):
   - New `set_section_status` operation (sub-kind inside `apply_overlay_commit`).
   - Transition rules:
     - `open ↔ complete`: free.
     - `open ↔ in_progress`: kernel-driven (run start/end) AND operator-allowed.
     - `* → frozen`: operator only.
     - `frozen → open`: operator only; explicit unfreeze.
   - K95 (`overlay_section_status_blocks`) raised on forbidden transitions or on member-cell structural ops while status is `in_progress` / `frozen`.
   - Auto-transition: when a run begins inside section S (per [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) RunFrame start), `AgentSupervisor` submits `set_section_status(S, "in_progress")`. On terminal status, if no other in-flight runs exist in S, flip back to `open`.

4. **Dual-representation invariant.** `MetadataWriter.submit_intent` enforces `cells[<id>].section_id` and `sections[<id>].cell_range[]` agreement at apply time. A section operation that would break agreement is rejected as K42 (`section_membership_mismatch`).

5. **Extension renderer.** A `vscode.NotebookCellDecorationProvider` renders a section header above the first cell of each section's `cell_range[]`. Click to collapse/expand. Headers carry the title + status badge color. Right-click → "Rename section", "Delete section", "Set status…".

6. **Operator commands.** New VS Code commands wire to overlay-commit envelopes:
   - `llmnb.section.create` — prompts for title and target cell range.
   - `llmnb.section.rename`.
   - `llmnb.section.delete`.
   - `llmnb.section.setStatus`.
   - All produce `apply_overlay_commit` intents per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md).

## §4. Interface contracts

Overlay operation kinds (sub-kinds inside `apply_overlay_commit.operations[]`):

```jsonc
{ "kind": "create_section",
  "id": "sec_01HZX...",
  "title": "Architecture",
  "parent_section_id": null,
  "cell_range": ["vscode-notebook-cell:.../#abc", "..."],
  "status": "open",
  "collapsed": false }

{ "kind": "rename_section", "id": "sec_...", "new_title": "..." }
{ "kind": "delete_section", "id": "sec_..." }
{ "kind": "move_cells_into_section", "section_id": "sec_...", "cell_ids": ["..."] }
{ "kind": "set_section_status", "id": "sec_...", "new_status": "in_progress" }
```

K-class additions (see [overlay-commit](../atoms/concepts/overlay-commit.md) and [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md)):
- K42 sub-reasons: `flat_sections_only`, `cell_already_in_section`, `delete_non_empty_section`, `section_membership_mismatch`.
- K95: `overlay_section_status_blocks` — applied when a structural op targets a member of an `in_progress` or `frozen` section, OR a forbidden status transition is attempted.

Extension API: a `Section` TypeScript type matching the atom schema; export from `extension/src/types/section.ts`.

## §5. Test surface

In `vendor/LLMKernel/tests/test_overlay_applier.py` (new file once gap G8 closes):

- `test_create_section_persists`.
- `test_create_section_rejects_parent` — non-null `parent_section_id` → K42 `flat_sections_only`.
- `test_create_section_rejects_already_assigned_cells`.
- `test_rename_section_keeps_id_immutable`.
- `test_delete_section_rejects_non_empty`.
- `test_move_cells_into_section_dual_representation_consistent`.
- `test_set_section_status_transitions` — parameterized on the transition matrix; valid/forbidden transitions verified.
- `test_section_status_in_progress_blocks_split` — K95 on `split_cell` for a member.
- `test_section_status_frozen_blocks_all_structural_ops`.
- `test_run_start_auto_flips_section_to_in_progress`.

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_dual_representation_invariant_enforced` — committing inconsistent state is rejected.

In `extension/test/notebook/`:

- `section-decoration.test.ts` — header rendered for a section.
- `section-collapse.test.ts` — collapse/expand toggles cell visibility.
- `section-commands.test.ts` — `llmnb.section.create` produces an `apply_overlay_commit` envelope.

Expected count: 10 applier + 1 writer + 3 extension = 14 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Section state drifts from cell state on partial writes | Dual-representation invariant enforced atomically inside `OverlayApplier.apply_commit`; one transaction. |
| Auto-transition fires from a kernel race (two runs starting in the same section nearly simultaneously) | Reference-counted: `_in_progress_run_count[section_id]` increments on run start, decrements on terminal; flip back to `open` only at zero. |
| Operator interrupts a frozen section by editing cell text directly | Cell text edits route through `cell_edit` action_type per [protocols/operator-action](../atoms/protocols/operator-action.md); the kernel rejects with K95 if section is frozen. |
| `parent_section_id` accidentally allowed via type coercion | Explicit `is None` check in the validator, not truthy comparison; covered by `test_create_section_rejects_parent`. |
| ContextPacker (S3.5) walks section.cell_range out-of-order | The atom guarantees `cell_range[]` IS the display order; the packer's section-walk consumes it directly. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/section.md](../atoms/concepts/section.md) — Status flips from `V1 spec'd (S5.5 in BSP-005)` to `V1 shipped`.
- [decisions/v1-section-status-interruptibility.md](../atoms/decisions/v1-section-status-interruptibility.md) — referenced; no shape change. Verify the K95 sub-reasons match the implementation.
- [decisions/v1-flat-sections.md](../atoms/decisions/v1-flat-sections.md) — verify the validator behavior matches; no shape change.
- [operations/create-section.md](../atoms/operations/create-section.md), [operations/rename-section.md](../atoms/operations/rename-section.md), [operations/delete-section.md](../atoms/operations/delete-section.md), [operations/set-section-status.md](../atoms/operations/set-section-status.md) — all flip to `V1 shipped`.
- [contracts/overlay-applier.md](../atoms/contracts/overlay-applier.md) — Status flips from `V1 spec'd ... NOT yet present` to `V1 shipped` (assuming gap G8 closes here or before).
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — verify dual-representation invariant added to its invariants list.
- [concepts/cell.md](../atoms/concepts/cell.md) — `section_id` field now actively used.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 7](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — section operations branch on `kind` for member cells.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — packer walks `section.cell_range` chronologically.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — overlay-commit machinery shared.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrame run start triggers the `in_progress` auto-flip.
- [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) — section nodes in the sidebar tree consume this state.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G2 (intent kinds) and G8 (OverlayApplier module) close together with this slice.

## §9. Definition of done

- [ ] All 14 new tests pass.
- [ ] Round-trip smoke: create three sections, populate with 5 cells each, rename one, set one to `frozen`, attempt to merge two cells in the frozen section → K95; close → reopen → state restored.
- [ ] Auto-transition smoke: section S has cell c; spawn an agent in c → S flips to `in_progress`; turn completes → S flips back to `open`. Two agents running in S → S flips to `in_progress`; one ends → S stays `in_progress`; both end → S returns to `open`.
- [ ] Dual-representation smoke: a snapshot's `cells[*].section_id` ↔ `sections[*].cell_range[]` agreement is asserted on a 50-cell notebook.
- [ ] Extension renders headers and collapse works; visible per cell in `vscode-notebook-cell:` URIs.
- [ ] BSP-005 §6.3 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
