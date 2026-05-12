// BSP-008 Inspect mode — extension activation glue.
//
// Wires the per-cell status-bar provider, the per-manifest detail-view
// command, and the metadata source that feeds them. Called from
// extension.ts::activate so the existing controller / serializer / router
// graph stays the orchestrator and Inspect mode is one bolt-on slice.

import * as vscode from 'vscode';
import {
  InspectCellStatusBarProvider,
  DocumentBackedInspectMetadataSource
} from './cell-status-provider.js';
import {
  registerOpenManifestDetailCommand,
  type NotebookMetadataAccessor
} from './manifest-detail-command.js';
import type { NotebookMetadataLike } from './run-frame-reader.js';
import type { MessageRouter } from '../messaging/router.js';

/** Public entry point. Returns a Disposable that cleans up everything we
 *  registered (the caller adds it to `context.subscriptions`).
 *
 *  Inputs:
 *   - `notebookType`: the registered notebook type string ('llmnb').
 *   - `router`: the RFC-006 MessageRouter, so the metadata source can
 *     subscribe to Family F snapshots and refresh the badge when a new
 *     RunFrame lands.
 *   - `logger`: shared output channel; we log warns/info on missing
 *     metadata, command misuse, and subscription wiring. */
export function activate(args: {
  context: vscode.ExtensionContext;
  notebookType: string;
  router: MessageRouter;
  logger: vscode.LogOutputChannel;
}): vscode.Disposable {
  const { context, notebookType, router, logger } = args;
  logger.info('[inspect] activating BSP-008 Inspect mode (read-only)');

  // The DocumentBackedInspectMetadataSource reads metadata.rts straight off
  // the live vscode.NotebookDocument. The metadata-applier (RFC-006 Family F
  // consumer) has already mutated the document by the time the provider's
  // `provideCellStatusBarItems` runs, so we don't need a parallel cache.
  // We DO subscribe to router metadata snapshots so the source's
  // onDidChange event fires and the provider re-collects items
  // immediately — VS Code's own document-change event also fires for
  // metadata edits but the cell-toolbar refresh cadence depends on the
  // event firing crisply.
  const source = new DocumentBackedInspectMetadataSource(notebookType);
  context.subscriptions.push({ dispose: () => source.dispose() });
  context.subscriptions.push(router.registerMetadataObserver(source));

  // Provider. Sibling to CellBadgeStatusBarProvider /
  // ContaminationBadgeStatusBarProvider / InterruptButtonStatusBarProvider.
  const provider = new InspectCellStatusBarProvider(source);
  context.subscriptions.push({ dispose: () => provider.dispose() });
  context.subscriptions.push(
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(notebookType, provider)
  );

  // Command. The cell-status item's `command` field references this id so
  // a click opens the per-manifest detail QuickPick.
  const accessor: NotebookMetadataAccessor = {
    getActiveMetadata: () => {
      const active = vscode.window.activeNotebookEditor?.notebook;
      if (active && active.notebookType === notebookType) {
        return {
          metadata: active.metadata as NotebookMetadataLike,
          notebookUri: active.uri.toString()
        };
      }
      // Fallback: scan all open notebooks for the registered type. V1
      // supports a single attached notebook per kernel session; if multiple
      // are open the first match wins (matches metadata-applier's
      // WindowActiveNotebookProvider).
      for (const nb of vscode.workspace.notebookDocuments) {
        if (nb.notebookType === notebookType) {
          return {
            metadata: nb.metadata as NotebookMetadataLike,
            notebookUri: nb.uri.toString()
          };
        }
      }
      return { metadata: undefined, notebookUri: undefined };
    }
  };
  context.subscriptions.push(
    registerOpenManifestDetailCommand(accessor, logger)
  );

  // Return a no-op composite Disposable. We've already pushed each
  // piece into `context.subscriptions`; double-disposing through a
  // composite would just trigger the (idempotent) emitter.dispose()
  // paths a second time. The composite exists so the caller's API
  // (`context.subscriptions.push(inspect.activate(...))`) reads
  // consistently with the sibling activation modules.
  return new vscode.Disposable(() => { /* no-op; subscriptions own teardown */ });
}
