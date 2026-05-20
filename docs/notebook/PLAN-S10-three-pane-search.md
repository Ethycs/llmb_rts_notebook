# Plan: S10 — Three-pane mental model + FSP-002 search/collapse

**Status**: shipped (2026-05-19, **reduced scope V1**) — streaming + artifact badges, bulk-collapse + find wrapper commands. The "floating search bar" and "per-cell gutter color" features from the original plan are deferred to V2 pending VS Code API exposure.

## Reduced-scope note (2026-05-19)

A feasibility probe before slice execution found three of PLAN-S10's mechanisms are not exposed by VS Code v1.92:

| Original PLAN-S10 step | v1.92 reality |
|---|---|
| §3.1 step 2: `vscode.NotebookCellDecorationProvider` for gutter + focus border | API does not exist. Only `NotebookCellStatusBarItemProvider` is exposed. The native cell-focus highlight already covers the "current" pane visually. |
| §3.2 step 4: "Floats a search bar above the notebook editor (uses VS Code's webview overlay)" | Webview panels open as side tabs only; there is no overlay-above-editor API and the native Ctrl+F find widget is not extension-customizable. |
| §3.3 step 8: `vscode.NotebookCellMetadata.collapsed = true` mutation | `NotebookCell.metadata` is read-only at runtime; no `collapsed` field is honored by the renderer. |

**What V1 actually ships** (this reduced scope):

- **Streaming cell badge** (right side) — fires when the cell has a RunFrame with `status === "running"` and `ended_at` null/missing, sourced from `metadata.rts.zone.run_frames.*`. Static glyph (`◉ streaming`) — no animation, since `NotebookCellStatusBarItem` doesn't support it.
- **Artifact cell badge** (right side) — fires when `metadata.rts.cell.kind === "artifact"` (the promote-span outcome). Reuses cell-kinds enum.
- **Bulk-collapse wrapper commands** — `llmnb.collapseAllInputs` / `llmnb.collapseAllOutputs` / `llmnb.expandAllInputs` / `llmnb.expandAllOutputs` each fans out to the engine's built-in `notebook.cell.{collapse,expand}AllCell{Input,Output}` command.
- **Find-in-cells wrapper command** — `llmnb.findInCells` fans out to the engine's built-in `actions.find` (the same widget Ctrl+F triggers in a focused notebook).

**Deferred to V2+ pending API exposure**:
- Three-pane gutter coloring per cell (S1's `TextEditorDecorationType` border trick covers per-agent gutter; the streaming/current/artifact PANE distinction is now informally carried by badge presence).
- Floating search bar with M-of-N counter, scope selector, regex toggle, auto-expand on collapsed-cell match.
- WorkspaceState-backed bulk-collapse persistence (the engine handles its own collapse state via the per-cell chevron; we don't try to mirror it).

The FSP-002 reference design stays normative for V2+; this slice just delivers the engine-native subset that's reachable today.

**Jupyter comparison (2026-05-19 probe)**: the vendored `vscode-jupyter` was checked for the same three mechanisms and hit identical walls — no per-cell gutter decoration inside notebook editors (their interactive-window border trick uses `TextEditorDecorationType` on a regular text editor, not on notebook cells); no custom search affordance (they rely on native Ctrl+F); and `notebook.cell.collapseAllCellInputs` for bulk collapse (same engine builtin we wrap). Critically, `vscode-jupyter`'s `package.json` enables 13 proposed APIs (`notebookMessaging`, `notebookCellExecution`, `notebookKernelSource`, etc.) but **`notebookCellDecoration` is not among them and is not currently a Microsoft proposal**. So the reduced V1 is genuinely the ceiling on the current platform; Marketplace-publishable extensions cannot do better. The full PLAN-S10 visual would require either a side-panel HTML renderer (parallel-view, not in-cell — see S10.5 deferred slice) or a future VS Code API expansion.

---

## Original plan (verbatim for reference)

**Status (originally proposed)**: ready
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

## §9. Definition of done — reduced-scope V1 (2026-05-19)

- [x] All 17 new extension tests pass (the original PLAN budgeted 16; reduced scope delivered 10 badge tests + 7 wrapper-command tests).
- [x] Streaming-badge smoke: a cell with a `status: "running"` RunFrame in `metadata.rts.zone.run_frames.*` renders `◉ streaming` (right side); turns off when the frame transitions to a terminal status.
- [x] Artifact-badge smoke: a cell with `metadata.rts.cell.kind === "artifact"` renders `◆ artifact` (right side); markup cells and non-artifact code cells render nothing.
- [x] Bulk-collapse wrapper commands registered in `extension/package.json` and fan out to the engine builtins.
- [x] Find-in-cells wrapper command registered; the operator can trigger the native notebook find from the command palette without remembering `actions.find`.
- [ ] **Deferred** (V2+ pending API): floating search bar with M-of-N, scope selector, regex toggle; auto-expand on collapsed-cell match; WorkspaceState-backed collapse persistence; performance smoke against 1000-cell synthetic.
- [x] BSP-005 changelog row updated to reflect V1 ship of the reduced scope. FSP-002 status updated to "V1 partial-ship (find + bulk collapse via engine builtins); full UX V2+".
- [x] This plan flips to `**Status**: shipped (2026-05-19, reduced scope V1)` (slice 1 commit SHA filled at commit time).
