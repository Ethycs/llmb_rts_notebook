// Host-side glue for the run-record MIME renderer.
//
// VS Code loads notebook renderers from the entrypoint declared in
// package.json under `contributes.notebookRenderer`. This module is the
// host-side counterpart: it does not register the renderer at runtime
// (the platform does that from the manifest), but it documents the
// contract and exposes constants the controller and tests share.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/webviews/extension-side/ — vscode-jupyter
// declares its renderer in package.json and the extension-side modules
// are responsible for messaging to/from the renderer rather than for
// registering it.

import { RTS_RUN_MIME } from '../notebook/controller.js';

/** The renderer id declared in package.json's notebookRenderer entry. */
export const RTS_RUN_RENDERER_ID = 'llmnb-run-renderer';

/** Re-exported from the controller so callers do not have to reach across. */
export const RTS_RUN_MIME_TYPE = RTS_RUN_MIME;

/** Sanity-check helper used by the smoke test: does a notebook output item
 *  carry the run-record MIME type? */
export function isRunRecordOutputItem(mime: string): boolean {
  return mime === RTS_RUN_MIME_TYPE;
}

/** package.json contributes.notebookRenderer entry shape. The build pipeline
 *  emits the renderer to dist/run-renderer.js (esbuild target). The
 *  manifest entry is updated additively in extension/package.json. */
export const RUN_RENDERER_CONTRIBUTION = {
  id: RTS_RUN_RENDERER_ID,
  displayName: 'LLMNB Run Renderer',
  entrypoint: './dist/run-renderer.js',
  mimeTypes: [RTS_RUN_MIME_TYPE]
} as const;
