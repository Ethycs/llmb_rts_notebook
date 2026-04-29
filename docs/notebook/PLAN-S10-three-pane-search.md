# Plan: S10 — Three-pane mental model + FSP-002 search/collapse

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship the visual three-pane mental model (streaming / current / artifacts) via cell-status decorations + CSS, and fold in [FSP-002](FSP-002-cell-search-collapse.md) (in-cell search + collapse all / expand all). Pure UX polish capping V1.
**Time budget**: 1 day. Pure extension. Single-agent (X-EXT-S10).

---

## §1. Why this work exists

V1 substrate plus S0.5 → S9 give the operator a working multi-agent notebook. What's still missing is the visual orientation:

- The operator needs to see at a glance which cell is *streaming* (in-flight output), which is *current* (the one being edited), and which carries *artifacts* (overlay outputs / attachments) — per [BSP-005 §"S10"](BSP-005-cell-roadmap.md).
- Search across cell content. Currently the operator has to scroll. FSP-002 specifies the in-cell search bar with `M of N` navigation and the collapse/expand-all bulk affordances.

Driver: [BSP-005 §"S10"](BSP-005-cell-roadmap.md), folding [FSP-002](FSP-002-cell-search-collapse.md). Atoms: [concepts/cell-kinds](../atoms/concepts/cell-kinds.md), [concepts/section](../atoms/concepts/section.md), [concepts/output-kind](../atoms/concepts/output-kind.md).

Hard dependencies:
- All prior slices shipped — this is pure UX polish and does not introduce wire changes.

## §2. Goals and non-goals

### Goals

- Visual three-pane treatment: a cell in `streaming` state has a distinct gutter color + "streaming" badge; the `current` (selected) cell has a focused border; cells with `artifact` outputs show a small badge in the cell decoration area.
- FSP-002 §2.1 search bar: `Ctrl+F` opens an in-cell-scoped search bar with options popover, `M of N` count, prev/next, scope selector (`All cells | Inputs only | Outputs only | Tool calls only | Selected cells only`).
- FSP-002 §2.2 collapse/expand all: two toolbar buttons; mixed-state indicator dot when the notebook is partially collapsed.
- Per-FSP-002 §3: default plain-substring case-insensitive match; opt-in regex; auto-expand cells when match is inside a collapsed body.
- Per-FSP-002 §4: V1 ships option-A persistence (extension-side workspace state) — collapse state lives in VS Code's `WorkspaceState`, not in `metadata.rts`. V2 promotes to `metadata.rts` per [decisions/v1-flat-sections](../atoms/decisions/v1-flat-sections.md) discipline.

### Non-goals

- Cross-notebook search (FSP-002 §"What this is NOT").
- Indexed search for >5000-cell notebooks (FSP-002 §3 performance bound; V3+).
- Promoting collapse state into `metadata.rts.zone` (V2.5+ per FSP-002 §4 option B).
- New wire envelopes — this slice is pure extension.

## §3. Concrete work

### 3.1 Three-pane mental model

1. **State enum.** Add `extension/src/types/cell-display-state.ts`:
   ```ts
   export type CellDisplayState = "streaming" | "current" | "artifact" | "default";
   ```
   `streaming` is derived from the cell's RunFrame having `status: "running"`. `current` is `vscode.window.activeNotebookEditor.selection`. `artifact` is set when the cell carries an `output_kind` of `vnd.rts.artifact+json` per [output-kind atom](../atoms/concepts/output-kind.md).

2. **Decoration provider.** Extend the existing `vscode.NotebookCellDecorationProvider` from S1 to layer the three-pane CSS classes per cell. Color tokens defined in `extension/media/three-pane.css`.

3. **Streaming badge.** Status-bar item per cell: when state is `streaming`, render an animated pulse + "streaming" label. Tied to RunFrame status from [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md).

### 3.2 In-cell search (FSP-002 §2.1)

4. **Search controller.** New `extension/src/notebook/search/search-controller.ts`:
   - Trigger: `Ctrl+F` when the notebook editor is focused — registered via `package.json` keybindings.
   - Floats a search bar above the notebook editor (uses VS Code's webview overlay).
   - Holds: search input, scope selector, options popover (case sensitivity, whole word, regex), `M of N` counter, prev/next arrows, close button.

5. **Match-finding engine.** `extension/src/notebook/search/match-finder.ts`:
   - Iterates `vscode.NotebookCellData[]` from the active document.
   - For each cell, accumulates the union: cell directive text + cell outputs (rendered text + tool-call args). Excludes blob bodies per FSP-002 §3.
   - Returns a flat `Match[]` array with `{ cell_index, range, scope }`.

6. **Highlighting.** `extension/src/notebook/search/highlighter.ts` applies a `vscode.TextEditorDecorationType` per match. Active match is bolder; inactive matches are dimmer. Auto-expand collapsed cells when their match becomes active.

7. **Keyboard.** `Enter` → next, `Shift+Enter` → previous, `Esc` → close. Wired in the search bar webview's onkeydown.

### 3.3 Collapse / expand all (FSP-002 §2.2)

8. **Bulk operations.** `extension/src/notebook/collapse/bulk.ts`:
   - `llmnb.collapseAll`: iterates cells and sets `vscode.NotebookCellMetadata.collapsed = true` (or the equivalent VS Code API). Persists in WorkspaceState.
   - `llmnb.expandAll`: same with `false`.

9. **Mixed-state indicator.** A small dot glyph on the toolbar's collapse-all button when not all cells are uniformly collapsed/expanded. Computed via cells iteration.

10. **Per-cell override**: do nothing — the existing VS Code per-cell collapse chevron continues to work; bulk operations update it; the chevron updates the WorkspaceState.

### 3.4 Persistence

11. **Workspace state.** Per FSP-002 §4 option A, collapse-all state lives in `vscode.ExtensionContext.workspaceState` keyed by notebook URI. NOT promoted to `metadata.rts.zone` in V1.

## §4. Interface contracts

No wire changes. Internal extension API:

```ts
// extension/src/notebook/search/types.ts
export interface Match { cell_index: number; range: vscode.Range; scope: SearchScope; }
export type SearchScope = "all" | "inputs" | "outputs" | "tool_calls" | "selected";

export interface SearchOptions {
  query: string;
  case_sensitive: boolean;
  whole_word: boolean;
  regex: boolean;
  scope: SearchScope;
}
```

Commands registered:
- `llmnb.search.open` (Ctrl+F when notebook focused).
- `llmnb.collapseAll`.
- `llmnb.expandAll`.

## §5. Test surface

In `extension/test/notebook/`:

- `three-pane-decoration.test.ts`:
  - `test_streaming_decoration_active_during_run`.
  - `test_current_cell_focused_decoration`.
  - `test_artifact_cell_badge_renders`.
- `search-match-finder.test.ts`:
  - `test_finds_matches_in_cell_directive_text`.
  - `test_finds_matches_in_outputs`.
  - `test_finds_matches_in_tool_call_args`.
  - `test_excludes_blob_bodies`.
  - `test_scope_inputs_only_filters_correctly`.
  - `test_regex_mode_compiles_pattern`.
  - `test_regex_mode_invalid_pattern_surfaces_tooltip`.
- `search-highlighter.test.ts`:
  - `test_active_match_distinct_styling`.
  - `test_auto_expand_on_match_in_collapsed_cell`.
- `search-keyboard.test.ts`:
  - `test_enter_next_match`.
  - `test_shift_enter_previous_match`.
  - `test_escape_closes`.
- `bulk-collapse.test.ts`:
  - `test_collapse_all_idempotent`.
  - `test_expand_all_idempotent`.
  - `test_mixed_state_indicator`.
  - `test_workspace_state_persistence`.

Expected count: 16 extension tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Search performance degrades on >1000-cell notebooks | 200ms debounce on input + incremental match-finding (yield after each cell). FSP-002 §3 sets the V2 target at 5000 cells; V1 acceptable bound is 1000. |
| Three-pane CSS conflicts with VS Code theme variations | Use VS Code's theme color tokens (`var(--vscode-editor-foreground)` etc.) instead of literal hex colors. |
| FSP-002 §3 regex mode allows ReDoS | The regex compiles in a worker with a 200ms abort timeout; on timeout, fall back to plain substring with a tooltip. |
| Auto-expand on match disrupts the operator's collapse intent | Only expand cells with active match; restore previous state on search close. |
| WorkspaceState persistence diverges across multi-window scenarios | VS Code handles workspace-state replication; V1 accepts last-write-wins per window. V2.5+ promotes to `metadata.rts` for true multi-operator. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/cell-kinds.md](../atoms/concepts/cell-kinds.md) — referenced for the artifact-kind detection; no change.
- [concepts/section.md](../atoms/concepts/section.md) — sections affect "all cells" search scope; no atom change.
- [concepts/output-kind.md](../atoms/concepts/output-kind.md) — `vnd.rts.artifact+json` detection; no atom change.
- No new atoms; this slice is pure extension UX.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 11](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — `streaming` state derived from RunFrame status.
- [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) — search results coordinate with the activity tree's recent-activity entries.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — collapse-all interacts with section collapse; ensure idempotent layering.
- [PLAN-M-series.md](PLAN-M-series.md) — M2 (annotations) decorations may overlap with three-pane styling; coordinate the gutter real estate.

## §9. Definition of done

- [ ] All 16 new extension tests pass.
- [ ] Three-pane smoke: a streaming agent cell shows the streaming badge + gutter; selecting another cell flips `current` styling; an artifact cell shows the artifact badge.
- [ ] Search smoke: `Ctrl+F` opens the bar; type a substring → matches highlighted with `M of N`; navigate next/previous; matches inside a collapsed cell auto-expand it; `Esc` closes; previous collapse state restored.
- [ ] Bulk collapse smoke: with 5 cells (2 collapsed), `Collapse all` makes 5 collapsed; `Expand all` makes 0 collapsed; reload window → state preserved per WorkspaceState.
- [ ] Performance smoke: search across a 1000-cell notebook (synthetic fixture) returns within 200ms; no UI freeze.
- [ ] BSP-005 changelog updated with slice commit SHA; FSP-002 status flipped to `Shipped in V1` per [VERSIONING.md](VERSIONING.md).
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
