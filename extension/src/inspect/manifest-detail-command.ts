// BSP-008 Inspect mode — vscode QuickPick host for the per-manifest detail
// view. Pure render lives in `manifest-detail-view.ts`; this module is the
// thin vscode-bound shell that turns rendered lines into a QuickPick.
//
// Engineering Guide §11.3 ("Premature abstraction"): we deliberately ship a
// QuickPick first. If a third surface needs the same render (a webview, a
// hover, a tree view), promote then. Today's V1 has exactly one consumer
// (the cell-status item click target), so a webview would be over-served.

import * as vscode from 'vscode';
import {
  renderManifestDetail,
  MISSING_MANIFEST_DETAIL_LINES,
  OPEN_MANIFEST_DETAIL_COMMAND_ID,
  type OpenManifestDetailArgs
} from './manifest-detail-view.js';
import { manifestById } from './run-frame-reader.js';
import type { NotebookMetadataLike } from './run-frame-reader.js';

/** Accessor used by the command handler to fetch the metadata blob for
 *  the active notebook. The extension's existing metadata-applier path
 *  already keeps a reference to the active document; we re-use it here
 *  rather than building a parallel reader (per the brief: "do NOT write
 *  a parallel reader"). */
export interface NotebookMetadataAccessor {
  /** Returns the metadata.rts blob for the active notebook (if any) plus
   *  the notebook URI for telemetry/logging. */
  getActiveMetadata(): {
    metadata: NotebookMetadataLike | undefined;
    notebookUri: string | undefined;
  };
}

/** Register the `llmnb.inspect.openManifestDetail` command. Returns a
 *  Disposable that the caller (index.ts) puts in
 *  `context.subscriptions`. */
export function registerOpenManifestDetailCommand(
  accessor: NotebookMetadataAccessor,
  logger?: vscode.LogOutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    OPEN_MANIFEST_DETAIL_COMMAND_ID,
    async (args: OpenManifestDetailArgs | undefined) => {
      if (!args || typeof args.manifest_id !== 'string') {
        logger?.warn('[inspect] openManifestDetail called without manifest_id');
        return;
      }
      const { metadata } = accessor.getActiveMetadata();
      const manifest = manifestById(metadata, args.manifest_id);
      const lines: string[] = manifest
        ? renderManifestDetail(manifest)
        : [...MISSING_MANIFEST_DETAIL_LINES];
      const items: vscode.QuickPickItem[] = lines.map((line) => ({
        label: line
      }));
      const title =
        `Inspect — manifest for run ${args.run_id || '(unknown)'}` +
        ` on cell ${args.cell_id || '(unknown)'}`;
      // showQuickPick is read-only: the operator can browse the lines but
      // not mutate anything. Picking dismisses the panel. V1 deliberately
      // declines to graduate to a webview — Engineering Guide §11.3
      // "premature abstraction": ship the QuickPick first; promote to a
      // webview only when a third surface needs the same render.
      await vscode.window.showQuickPick(items, {
        title,
        canPickMany: false,
        ignoreFocusOut: false,
        matchOnDescription: false,
        matchOnDetail: false
      });
    }
  );
}
