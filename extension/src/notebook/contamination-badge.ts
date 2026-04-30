// PLAN-S5.0.1 §3.8 — cell contamination badge (extension half).
//
// A status-bar item provider sibling to cell-badge.ts and interrupt-button.ts.
// Surfaces an amber `⚠ contamination (N)` chip on every cell whose
// `metadata.rts.cells[<id>].contaminated === true` (Layer 1 detector in
// vendor/LLMKernel sets this on agent output that contains a magic-name
// pattern). Clicking the chip invokes `llmnb.resetContamination` with the
// cell id; the command (registered in extension.ts) opens the operator
// confirmation flow + emits the operator-action envelope.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.10 K3F
//
// This module is the cell-level surface for the contamination workflow. The
// matching pure-DOM `renderers/components/contamination-badge.ts` is reserved
// for V1.5+ when we expand the chip into a webview panel that lists every
// `contamination_log` entry inline; for V1 we use a status-bar chip + a
// VS Code information modal to keep the surface area minimal.

import * as vscode from 'vscode';
import type {
  NotebookMetadataObserver
} from '../messaging/router.js';
import type { NotebookMetadataPayload } from '../messaging/types.js';

/** Command id registered in extension.ts activation. The badge's
 *  status-bar item points at this command; clicking the chip invokes it
 *  with `{cell_id}` in the args. */
export const RESET_CONTAMINATION_COMMAND_ID = 'llmnb.resetContamination';

/** Visible badge text. The leading `⚠` is unicode "warning sign"; reads
 *  cleanly in both light and dark VS Code themes. The trailing parenthetical
 *  is filled with the contamination_log length (see `formatBadgeText`). */
export const CONTAMINATION_BADGE_PREFIX = '⚠ contamination';

/** PLAN-S5.0.1 §3.8 — one entry of `cells[<id>].contamination_log`. */
export interface ContaminationLogEntry {
  line: string;
  source: string;
  ts: string;
  layer: string;
}

/** Per-cell shape under `notebook.metadata.rts.cells[<id>]` (PLAN-S5.0.1
 *  §3.7 schema). The applier mirrors notebook-level metadata into per-cell
 *  metadata via vscode.NotebookEdit; the badge reads from there. */
export interface RtsCellsSlot {
  contaminated?: boolean;
  contamination_log?: ContaminationLogEntry[];
}

/** Notebook-scoped registry of contamination state. Drives the badge
 *  visibility per cell; updated whenever a `notebook.metadata` snapshot
 *  arrives (Family F). Observable so the status-bar provider re-renders
 *  on snapshot delivery without polling. */
export class ContaminationRegistry implements NotebookMetadataObserver {
  private readonly byCellId = new Map<string, RtsCellsSlot>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires every time a snapshot mutates the cells map. Status-bar
   *  provider subscribes so chips appear/disappear on snapshot delivery. */
  public readonly onDidChange = this.changeEmitter.event;

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Read-only lookup by cell id. */
  public get(cell_id: string): RtsCellsSlot | undefined {
    return this.byCellId.get(cell_id);
  }

  /** Test/seam helper: directly upsert a cell row. */
  public upsert(cell_id: string, slot: RtsCellsSlot): void {
    this.byCellId.set(cell_id, { ...slot });
    this.changeEmitter.fire();
  }

  /** Test/seam helper: clear all rows. */
  public clear(): void {
    if (this.byCellId.size === 0) return;
    this.byCellId.clear();
    this.changeEmitter.fire();
  }

  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) {
      return;
    }
    const cells = (payload.snapshot as { cells?: Record<string, unknown> }).cells;
    if (!cells || typeof cells !== 'object') {
      return;
    }
    let changed = false;
    const seenIds = new Set<string>();
    for (const [id, raw] of Object.entries(cells)) {
      seenIds.add(id);
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const r = raw as Record<string, unknown>;
      const next: RtsCellsSlot = {
        contaminated: r['contaminated'] === true,
        contamination_log: Array.isArray(r['contamination_log'])
          ? (r['contamination_log'] as ContaminationLogEntry[])
          : []
      };
      const prev = this.byCellId.get(id);
      if (
        !prev ||
        prev.contaminated !== next.contaminated ||
        (prev.contamination_log?.length ?? 0) !== (next.contamination_log?.length ?? 0)
      ) {
        this.byCellId.set(id, next);
        changed = true;
      }
    }
    // Drop rows the latest snapshot no longer mentions.
    for (const id of [...this.byCellId.keys()]) {
      if (!seenIds.has(id)) {
        this.byCellId.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.changeEmitter.fire();
    }
  }
}

/** Badge descriptor returned by `computeContaminationBadge`. Tests poke
 *  this directly to assert visibility / counts without reaching into VS
 *  Code's status-bar pipeline. */
export interface ContaminationBadge {
  cell_id: string;
  /** Number of entries in the cell's contamination_log. */
  count: number;
  /** Final rendered chip text (already includes the count). */
  text: string;
  /** Last 3 entries — surfaced in the status-bar tooltip per §3.8. */
  tail: ContaminationLogEntry[];
}

/** Render the badge text from a count. Single-/plural-aware. */
export function formatBadgeText(count: number): string {
  return `${CONTAMINATION_BADGE_PREFIX} (${count})`;
}

/** PLAN-S5.0.1 §3.8 — pure compute. Returns `undefined` when the cell is
 *  not contaminated (no chip). The cell id key matches the kernel's
 *  per-cell metadata namespace; the extension treats either the kernel-
 *  assigned `cell.metadata.id` (if present) or `cell.document.uri.toString()`
 *  as the lookup key. We try both. */
export function computeContaminationBadge(
  cell: vscode.NotebookCell,
  registry: ContaminationRegistry
): ContaminationBadge | undefined {
  const candidates = candidateCellIds(cell);
  for (const id of candidates) {
    const slot = registry.get(id);
    if (slot && slot.contaminated === true) {
      const log = Array.isArray(slot.contamination_log) ? slot.contamination_log : [];
      return {
        cell_id: id,
        count: log.length,
        text: formatBadgeText(log.length),
        tail: log.slice(-3)
      };
    }
  }
  return undefined;
}

/** Cell-id resolution: try the kernel-assigned id first, then fall back to
 *  the document URI. Exported for tests + the reset-contamination command. */
export function candidateCellIds(cell: vscode.NotebookCell): string[] {
  const out: string[] = [];
  const meta = cell.metadata as { id?: unknown; rts?: { cell?: { id?: unknown } } } | undefined;
  if (meta && typeof meta.id === 'string' && meta.id.length > 0) {
    out.push(meta.id);
  }
  if (meta?.rts?.cell && typeof meta.rts.cell.id === 'string' && meta.rts.cell.id.length > 0) {
    out.push(meta.rts.cell.id);
  }
  // The URI is always present, even on a freshly-created cell.
  out.push(cell.document.uri.toString());
  return out;
}

/** vscode.NotebookCellStatusBarItemProvider implementation — registered in
 *  extension.ts activation, sibling to CellBadgeStatusBarProvider and
 *  InterruptButtonStatusBarProvider. */
export class ContaminationBadgeStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** VS Code calls this when our event fires to re-collect items per cell. */
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly registry: ContaminationRegistry) {
    this.subscription = registry.onDidChange(() => {
      this.emitter.fire();
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const badge = computeContaminationBadge(cell, this.registry);
    if (!badge) {
      return [];
    }
    const item = new vscode.NotebookCellStatusBarItem(
      badge.text,
      vscode.NotebookCellStatusBarAlignment.Left
    );
    // Tooltip shows the last 3 contamination_log entries per §3.8.
    const tailLines = badge.tail
      .map((e) => `  [${e.layer}@${e.ts} ${e.source}] ${truncate(e.line, 80)}`)
      .join('\n');
    item.tooltip =
      `Contamination detected: ${badge.count} entr${badge.count === 1 ? 'y' : 'ies'}.\n` +
      `Click to review and clear.\n\n` +
      `Recent entries (most recent first):\n${tailLines}`;
    item.command = {
      command: RESET_CONTAMINATION_COMMAND_ID,
      title: 'Review contamination',
      arguments: [{ cell_id: badge.cell_id }]
    };
    return [item];
  }
}

/** Trim a string to `max` characters with an ellipsis. Pure helper. */
function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
