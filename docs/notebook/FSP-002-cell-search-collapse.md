# FSP-002: In-cell search + collapse/expand all

**Status**: Future Spec, Issue 1, 2026-04-27
**Targeting**: V2 (UI/utility push) per VERSIONING.md
**Related**: BSP-002 (conversation graph — cell metadata cache §6), RFC-005 (`metadata.rts` zone format)

## 1. Scope

Two coupled operator-UX features:

1. **Search inside cells.** A search bar (Ctrl+F when notebook is focused, or a dedicated `Find in cells` toolbar button) that searches across all cell content — directive prompts, agent outputs, tool-call payloads, and rendered text — and highlights matches with next/previous navigation.
2. **Collapse all / expand all.** Two toolbar buttons that bulk-collapse or bulk-expand every cell in the notebook. Per-cell collapse state remains operator-controllable (existing VS Code notebook UX); the new buttons are a "do all of them at once" affordance.

Both features are pure operator-UX with no kernel runtime impact in V1 or V2. The wire is unchanged. The data model gets one optional additive field for persistence (§4).

## 2. UX

### 2.1 Search

| Element | Behavior |
|---|---|
| Trigger | `Ctrl+F` when the notebook editor is focused, or a `Find in cells` toolbar button. (`Ctrl+Shift+F` remains workspace search; this is a notebook-scoped find.) |
| Search bar | Floats at the top of the notebook editor. Contains: search input, match-count `M of N`, prev/next arrows, close button, options popover (case sensitivity, whole word, regex, scope). |
| Scope options | `All cells` (default) / `Inputs only` / `Outputs only` / `Tool calls only` / `Selected cells only`. |
| Match highlighting | Cells with matches are highlighted in the cell-list gutter; the active match scrolls into view. Matches inside collapsed cells trigger an auto-expand of those cells. |
| Keyboard | `Enter` = next match, `Shift+Enter` = previous, `Esc` = close. |

### 2.2 Collapse / expand all

| Element | Behavior |
|---|---|
| `Collapse all` button | Sets every cell to the collapsed state (header visible, body hidden). Idempotent. |
| `Expand all` button | Sets every cell to the expanded state. Idempotent. |
| Mixed state indicator | If some cells are collapsed and some expanded, the toolbar's "collapse-all" button glyph shows a mixed-state indicator (a small dot). Clicking it collapses all. |
| Per-cell override | The existing VS Code per-cell collapse chevron continues to work. Bulk operations don't disable per-cell controls. |
| Persistence | See §4 — V1 ships with VS Code workspace state (operator-local); V2 promotes to `metadata.rts` for collaborative scenarios. |

## 3. Search semantics

- **Default:** plain substring, case-insensitive.
- **Match scope:** the cell content union — directive text, outputs (rendered text + tool-call args), and any agent badge labels (per BSP-002 §6 "Cell as agent identity"). Excludes blob bodies (RFC-005 §F-blobs) — only blob *references* are searchable, not the resolved content (avoids loading large blobs at search time).
- **Regex:** opt-in via the options popover. JavaScript `RegExp` syntax. Errors surface as a tooltip on the search input.
- **Case sensitivity / whole word:** standard VS Code conventions.
- **Performance bound:** search must remain interactive for notebooks up to 5000 cells (V2 target). For larger, the search debounces to 200ms and shows a "searching..." spinner. V3+ may add an on-disk index per RFC-005 future work.

## 4. Persistence of collapse state

Two storage options. V1 of this FSP picks **A**; V2.5+ promotes to **B** when collaborative scenarios mature.

### A. Extension-side workspace state (V2 default)

Per-cell collapse state lives in VS Code's `Memento` (workspace-scoped). The state map is `{ cellId: collapsed }`. Survives reload; does not travel between operators or machines.

Pros: zero impact on `metadata.rts`; operator-local UX state stays operator-local.
Cons: opening the same notebook on a second machine resets all cells to default (expanded).

### B. `metadata.rts` cell metadata cache (V2.5+, additive)

Per-cell collapse state lives in `metadata.rts.cells[<cell_id>].metadata.rts.cell.collapsed: bool`. Per BSP-002 §6, cell metadata cache is the right home for render-time hints. Survives across machines and operators.

Pros: collaborative-safe (V3/V4 forward-compat); follows the file.
Cons: every collapse-toggle becomes a writer intent (BSP-003 `set_cell_metadata` registry entry — already specified). For "collapse all" of a 1000-cell notebook, that's 1000 intents in flight; the writer's queue can absorb it but the snapshot churn is real. Mitigation: batch the bulk operation as a single `set_cell_metadata_bulk` intent.

V2.5+ amendment of BSP-003 adds `set_cell_metadata_bulk` to the intent registry.

## 5. Wire impact

**V2.0 (option A):** zero. Pure extension-side state.

**V2.5+ (option B):** one new envelope (additive to RFC-006 Family B `layout.edit` family):

```jsonc
// extension → kernel
{
  "type": "layout.edit",
  "payload": {
    "operation": "set_cell_metadata_bulk",
    "parameters": {
      "updates": [
        { "cell_id": "...", "key": "rts.cell.collapsed", "value": true },
        ...
      ]
    },
    "intent_id": "01...",
    "expected_snapshot_version": 42
  }
}
```

The kernel's writer applies as one intent; emits one `layout.update` snapshot.

## 6. Failure modes

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| F70 | Search regex is invalid | `search_regex_invalid` with `pattern` | Surface inline tooltip; do not raise. |
| F71 | Collapse-all bulk intent rejected (CAS K41 in option B) | `bulk_collapse_cas_rejected` | Re-fetch zone snapshot; retry once; on second rejection surface to operator. |

V1 search has no kernel-side failure modes (extension-only). Bulk collapse in option B inherits BSP-003's K-class numbering for the underlying intent.

## 7. Forward-compat with V3+

- **V3 RTS:** the search bar gains a "live filter" mode — cells matching the search pattern stay visible; non-matching cells dim. Useful for incident response on a notebook full of agents.
- **V3 collapse:** bulk-collapse becomes a per-zone broadcast intent. Operator on machine A collapses all; operator on machine B sees the change reflected (when option B is in effect).
- **V4 multi-everything:** search across notebooks (workspace-scoped) is a separate FSP; this one stays notebook-scoped.

## 8. What this is NOT

- Not workspace search. Workspace search remains `Ctrl+Shift+F` and operates on file content, not cell semantics.
- Not search of historical (overlaid / reverted) cell content — V2 searches the current view; V3+ may add an "include history" toggle.
- Not a replacement for the existing per-cell collapse chevron. Bulk operations augment, not replace.

## 9. Implementation slice (when V2 reaches this FSP)

V2.x slice X-FIND:

1. Extension: search bar UI component + Memento for collapse state (~3 days, includes options popover, prev/next nav, scope filters).
2. Extension: bulk collapse/expand toolbar buttons + mixed-state glyph (~1 day).
3. Extension: search index over cell content (in-memory, debounced; ~2 days).
4. Tests: search behavior across all scopes; bulk collapse round-trip; regex edge cases (~2 days).

Estimate: ~8 working days for V2.0 (option A).

V2.5 promotion to option B adds:

1. K-MW: `set_cell_metadata_bulk` intent registry entry + apply function (~1 day).
2. Extension: route bulk collapse through hydrate envelope (~1 day).
3. Migration: read the Memento on first launch with option B; apply as one bulk intent; clear the Memento (~0.5 day).

## 10. Why this is V2, not V1

V1's `metadata.rts` is being shaped by BSP-002 and BSP-003 right now — adding cell-metadata writes for collapse state would expand the V1 surface unnecessarily. The substrate decisions (turn graph, agent refs, overlay graph, writer registry) need to land before optional UX polish hangs off them.

V2 ships option A first because it's pure extension work and validates the UX before paying the writer-registry cost. V2.5 promotes to option B once the multi-machine use case is real.

## Changelog

- **Issue 1, 2026-04-27**: initial. Search semantics specified for V2.0; option A (Memento) chosen as V2.0 default; option B (`metadata.rts` cache) deferred to V2.5+. No V1 surface impact.
