# Webviews — map view (Stage 5 S3)

This directory hosts the host-side and webview-side code for the **map view**
panel introduced in Stage 5 S3. The map view renders the layout-tree storage
structure described in `docs/dev-guide/07-subtractive-fork-and-storage.md`
(§"Layout tree") and is wired to the kernel via the RFC-003 `layout.update` /
`layout.edit` envelope pair (see
`docs/rfcs/RFC-003-custom-message-format.md` §"Family B — Layout").

## Files

| File | Side | Purpose |
|---|---|---|
| `map-view-panel.ts` | host | Singleton `vscode.WebviewPanel` lifecycle + message bridge |
| `map-view-html.ts` | host | HTML+CSP+nonce template injected into the panel |
| `map-view-renderer.ts` | webview | DOM/SVG renderer; bundled by esbuild as `dist/map-view.js` |
| `map-view-types.ts` | shared | Discriminated host↔webview message shapes |

## V1 scope

- Layout tree only. Workspaces, zones, files, viewpoints render as nested SVG
  rectangles using a deterministic grid pass (no D3 dependency).
- Drag-and-drop for zones emits `layout.edit` with
  `operation: "update_render_hints"`.
- Agent-graph overlay is partial: agents render as small circles on top of
  their `in_zone` zones; edges render as faint lines. Full force-directed
  layout is V1.5.
- One panel per workspace; reopening the command focuses the existing panel.

## V1.5+ deferrals

These are documented in chapter 07 §"What carries forward / what defers":

- `// TODO(V1.5):` D3 force-directed layout for the agent-graph overlay.
- `// TODO(V1.5):` time-travel scrubbing (the layout tree captures current
  state only; chat-flow time-travel is the chapter-07 cap).
- `// TODO(V1.5):` annotations on the map (drawing arrows, manual labels).
- `// TODO(V1.5):` multi-layout views (code-review / debug / presentation).
- `// TODO(security):` tighten CSP (drop `'unsafe-inline'` once the
  webview script is fully out-of-line bundled).

## How to test

1. Build the extension: `pixi run -e kernel npm --prefix extension run build`.
2. Open VS Code with the workspace.
3. Open a `.llmnb` file (creates a notebook editor + activates the extension).
4. Run command **LLMNB: Open map view** from the command palette.
5. The panel opens beside the editor with `layout: waiting…` until the kernel
   emits a `layout.update` envelope; then the tree renders. Drag a zone to
   post a `layout.edit` back to the kernel.

## Dependencies

- The renderer assumes `dist/map-view.js` is emitted by the build pipeline
  (esbuild target similar to `dist/run-renderer.js`). The bundle entry is
  `src/webviews/map-view-renderer.ts`. The build script update lives in
  `package.json`; this directory does not own that file.
