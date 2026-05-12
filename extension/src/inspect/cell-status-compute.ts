// BSP-008 Inspect mode — pure compute for the per-cell status item.
//
// This module is INTENTIONALLY pure (no vscode imports). The unit tier
// imports from here; the vscode-bound provider class
// (cell-status-provider.ts) re-uses the same compute under the hood.
//
// Engineering Guide §11.3 ("Premature abstraction"): the split between
// pure-compute and vscode-bound provider mirrors the existing
// `cell-badge.ts` / `contamination-badge.ts` discipline. computeXxx
// returns a typed render shape; the provider class wraps it into a
// NotebookCellStatusBarItem.

import {
  latestRunFrameForCell,
  runCountForCell,
  manifestById
} from './run-frame-reader.js';
import type { NotebookMetadataLike } from './run-frame-reader.js';
import { renderCellRunSummary } from './manifest-detail-view.js';
import type { OpenManifestDetailArgs } from './manifest-detail-view.js';
import type { ContextManifest, RunFrame } from './types.js';

/** Render shape consumed by the provider (and asserted by unit tests). */
export interface InspectCellStatus {
  cell_id: string;
  /** Final rendered text for the status-bar item. */
  text: string;
  /** Tooltip text — multi-line summary of the manifest contents. */
  tooltip: string;
  /** Args carried by the click command. */
  command_args: OpenManifestDetailArgs;
}

/** Emoji-free prefix character for the status-bar item. We avoid emojis
 *  in source files (project discipline) and use the ASCII triangle so
 *  the badge stays readable at any font. */
export const INSPECT_BADGE_PREFIX = '▶'; // ▶

/** Pure compute: derive the inspect status item for a cell from the
 *  notebook's metadata blob. Returns `undefined` when the cell has no
 *  recorded RunFrame (no badge to show). The `cellId` argument is the
 *  resolved cell id (caller is responsible for the resolution; the
 *  provider class delegates to `candidateCellIds`). */
export function computeInspectCellStatus(args: {
  cellId: string;
  metadata: NotebookMetadataLike | undefined;
}): InspectCellStatus | undefined {
  const { cellId, metadata } = args;
  if (!cellId) return undefined;
  const latest = latestRunFrameForCell(metadata, cellId);
  if (!latest) return undefined;
  const runCount = runCountForCell(metadata, cellId);
  const manifest = manifestById(metadata, latest.context_manifest_id);
  return {
    cell_id: cellId,
    text: shortBadgeText(latest, manifest),
    tooltip: renderCellRunSummary({ runCount, latest, manifest }),
    command_args: {
      cell_id: cellId,
      manifest_id: latest.context_manifest_id,
      run_id: latest.run_id
    }
  };
}

/** Short status-bar form: `▶ run_<short> (status) · N cells / K excluded`.
 *  We surface a short prefix of the run_id (first 8 chars) so the badge
 *  doesn't dominate the cell toolbar; the full id is in the tooltip and
 *  in the manifest detail QuickPick. */
function shortBadgeText(latest: RunFrame, manifest: ContextManifest | null): string {
  const idShort = shortRunId(latest.run_id);
  // Status segment: BSP-008 §7 statuses are
  // running | complete | failed | interrupted.
  const statusSeg = `${INSPECT_BADGE_PREFIX} ${idShort} (${latest.status})`;
  if (!manifest) {
    return `${statusSeg} · manifest unavailable`;
  }
  const includedCells = manifest.inclusion_rules_applied.reduce(
    (acc, r) => acc + r.cells.length,
    0
  );
  const excludedCells = manifest.exclusions_applied.reduce(
    (acc, r) => acc + r.cells.length,
    0
  );
  return `${statusSeg} · ${includedCells} cells / ${excludedCells} excluded`;
}

/** Short prefix of a ULID/UUID run_id for the status-bar text. Falls
 *  back to the raw id for short ids. */
export function shortRunId(run_id: string): string {
  if (run_id.length <= 10) return run_id;
  return run_id.slice(0, 8);
}
