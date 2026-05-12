// BSP-008 Inspect mode — per-cell status bar item (vscode-bound).
//
// Renders a NotebookCellStatusBarItem on every code cell summarizing the
// most-recent recorded run + its manifest. Click → opens the per-manifest
// detail view (manifest-detail-command.ts).
//
// Engineering Guide §11.1 "use the clean primitive": this is a
// vscode.NotebookCellStatusBarItemProvider, the same kind already used by
// CellBadgeStatusBarProvider, ContaminationBadgeStatusBarProvider, and
// InterruptButtonStatusBarProvider. The provider subscribes to a
// notebook-metadata-change event so the item re-renders when a new
// RunFrame lands on the wire (Family F snapshot) or when the document's
// own metadata mutates (the applier's NotebookEdit path).
//
// Engineering Guide §11.4 "no silent drops": when a RunFrame references a
// manifest that is missing from the on-disk metadata (e.g. a run from a
// prior session whose manifest was pruned), the badge text falls back to
// the missing-manifest sentinel rather than hiding silently.

import * as vscode from 'vscode';
import { computeInspectCellStatus } from './cell-status-compute.js';
import { OPEN_MANIFEST_DETAIL_COMMAND_ID } from './manifest-detail-view.js';
import type { NotebookMetadataLike } from './run-frame-reader.js';
import type { NotebookMetadataObserver } from '../messaging/router.js';
import type { NotebookMetadataPayload } from '../messaging/types.js';

// Re-export the pure-compute API so callers that import the provider
// can also reach the compute helpers and constants without a second
// import line. (Direct imports from cell-status-compute.js still work
// — the unit tier uses that path to stay vscode-free.)
export {
  shortRunId,
  INSPECT_BADGE_PREFIX,
  type InspectCellStatus
} from './cell-status-compute.js';
export { computeInspectCellStatus };

// ---------------------------------------------------------------------------
// Cell-id resolution — same algorithm as contamination-badge.ts. Tries the
// kernel-assigned id first, then falls back to the document URI.
// ---------------------------------------------------------------------------

/** Return the candidate cell ids for a NotebookCell, in priority order.
 *  The cell_id used by RunFrame records is whatever the kernel writes —
 *  today the controller passes `cell.document.uri.toString()` as the
 *  cell id when invoking the supervisor; future work may sync the
 *  kernel-assigned id back into `metadata.id`. */
export function candidateCellIds(cell: vscode.NotebookCell): string[] {
  const out: string[] = [];
  const meta = cell.metadata as
    | { id?: unknown; rts?: { cell?: { id?: unknown } } }
    | undefined;
  if (meta && typeof meta.id === 'string' && meta.id.length > 0) {
    out.push(meta.id);
  }
  if (
    meta?.rts?.cell &&
    typeof meta.rts.cell.id === 'string' &&
    meta.rts.cell.id.length > 0
  ) {
    out.push(meta.rts.cell.id);
  }
  // The URI is always present.
  out.push(cell.document.uri.toString());
  return out;
}

// ---------------------------------------------------------------------------
// Metadata source — the provider asks the active notebook for metadata.rts
// rather than holding its own copy. Mirrors the contamination registry's
// observer pattern but for read-side use only.
// ---------------------------------------------------------------------------

/** A handle the provider uses to (a) read a cell's owning notebook
 *  metadata and (b) be notified when new metadata.rts snapshots land
 *  (so the badge re-renders). */
export interface InspectMetadataSource extends NotebookMetadataObserver {
  /** Fires when a new `notebook.metadata` snapshot updates the in-memory
   *  view. The provider re-fires its `onDidChangeCellStatusBarItems`
   *  event off this. */
  readonly onDidChange: vscode.Event<void>;
  /** Lookup the metadata for a particular notebook by its uri. The
   *  provider passes the cell's owning notebook uri. */
  getMetadataFor(notebookUri: string): NotebookMetadataLike | undefined;
}

/** Default InspectMetadataSource: subscribes to the router's metadata
 *  observer surface and caches the most-recent snapshot keyed by session.
 *  V1 supports a single attached notebook per kernel session (matches
 *  the metadata-applier's WindowActiveNotebookProvider discipline), so
 *  the cache is a single most-recent blob keyed loosely by session_id. */
export class RouterBackedInspectMetadataSource
  implements InspectMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  /** The most-recent applied snapshot. V1 keeps one snapshot — the
   *  metadata-applier already enforces W8 monotonic versioning, so we
   *  always overwrite. */
  private latest: NotebookMetadataLike | undefined;

  public dispose(): void {
    this.emitter.dispose();
  }

  /** RFC-006 §8 Family F observer hook: capture the latest snapshot. */
  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) {
      return;
    }
    // The Family F snapshot payload IS the metadata.rts blob (the applier
    // strips one level of nesting before mutation). Wrap it in our reader
    // shape: { rts: <snapshot> } so the readers' path lookups work.
    this.latest = { rts: payload.snapshot } as NotebookMetadataLike;
    this.emitter.fire();
  }

  /** V1: ignores the notebookUri argument and returns the most-recent
   *  applied snapshot. Multi-notebook support is V2. */
  public getMetadataFor(_notebookUri: string): NotebookMetadataLike | undefined {
    return this.latest;
  }

  /** Test seam: directly inject a snapshot. Contract tests use this
   *  rather than wiring a fake router. */
  public setSnapshot(metadata: NotebookMetadataLike | undefined): void {
    this.latest = metadata;
    this.emitter.fire();
  }
}

/** A simpler accessor: read straight off the live NotebookDocument's
 *  metadata. This is the production path when the metadata-applier has
 *  already called `vscode.NotebookEdit.updateNotebookMetadata` — the
 *  provider sees the up-to-date blob without an extra subscription. */
export class DocumentBackedInspectMetadataSource
  implements InspectMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly notebookType: string) {
    // Re-render whenever the document metadata changes. VS Code v1.92's
    // notebook API doesn't expose a per-document onDidChangeMetadata event;
    // we listen on the workspace surface and filter by notebook type.
    this.subscription = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType !== this.notebookType) {
        return;
      }
      // Fire on any change. The provider's compute is cheap (object reads
      // + map lookups) so we accept the over-fire rather than diff the
      // metadata blob.
      this.emitter.fire();
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  /** RFC-006 §8 Family F observer hook: re-fires onDidChange so the
   *  badge refreshes when the applier writes a new snapshot. We don't
   *  cache — the live document IS the source of truth. */
  public onNotebookMetadata(_payload: NotebookMetadataPayload): void {
    this.emitter.fire();
  }

  public getMetadataFor(notebookUri: string): NotebookMetadataLike | undefined {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== this.notebookType) continue;
      if (nb.uri.toString() !== notebookUri) continue;
      return nb.metadata as NotebookMetadataLike;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// vscode.NotebookCellStatusBarItemProvider implementation.
// ---------------------------------------------------------------------------

export class InspectCellStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly source: InspectMetadataSource) {
    this.subscription = source.onDidChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    // Markdown cells never carry runs — no status item.
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      return [];
    }
    const metadata = this.source.getMetadataFor(cell.notebook.uri.toString());
    // Try each candidate cell id; the first that yields a RunFrame wins.
    for (const cellId of candidateCellIds(cell)) {
      const status = computeInspectCellStatus({ cellId, metadata });
      if (!status) continue;
      const item = new vscode.NotebookCellStatusBarItem(
        status.text,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.tooltip = status.tooltip;
      item.command = {
        command: OPEN_MANIFEST_DETAIL_COMMAND_ID,
        title: 'Inspect: show context manifest for this run',
        arguments: [status.command_args]
      };
      return [item];
    }
    return [];
  }
}
