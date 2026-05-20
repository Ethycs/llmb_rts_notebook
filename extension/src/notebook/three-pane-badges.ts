// PLAN-S10 §3.1 (reduced) — Three-pane status-bar badges.
//
// V1 scope (verified against VS Code v1.92 surface):
//   - "Streaming" badge   — a cell with an active RunFrame
//                            (`status: "running"`, `ended_at: null`).
//   - "Artifact" badge    — a cell with `metadata.rts.cell.kind == "artifact"`
//                            (promoted span; cell-kinds atom).
//
// Out of scope vs. PLAN-S10 as written:
//   - Per-cell gutter color / focused-cell border — VS Code v1.92 exposes
//     no `NotebookCellDecorationProvider` API. The native cell-focus
//     highlight already covers the "current" pane visually.
//   - Animated pulse — PLAN-S10 §3.1 step 3 names this, but
//     `NotebookCellStatusBarItem` does not support animation. We render
//     a static prefix character that's visually distinct (`◉` for
//     streaming so the operator can spot in-flight runs).
//
// Implementation mirrors the S1 CellBadgeStatusBarProvider pattern:
//   - Pure compute exported separately (`computeThreePaneBadges`) for
//     tests.
//   - Provider class subscribes to a SidebarMetadataSource (sharing the
//     change signal with PLAN-S7's sidebar trees) so RunFrame state
//     transitions re-trigger the badge per cell.

import * as vscode from 'vscode';
import type { SidebarMetadataSource } from '../sidebar/metadata-source.js';
import type {
  RawRunFrame,
  RtsSnapshot
} from '../sidebar/types.js';
import { candidateCellIds } from './contamination-badge.js';

/** Render text for the streaming badge. The leading codicon-style glyph
 *  marks the badge as in-flight so the operator can spot active runs at
 *  a glance even when the cell-toolbar / agent badge already occupies
 *  the left status-bar slot. */
export const STREAMING_BADGE_TEXT = '◉ streaming';

/** Render text for the artifact badge. Operator-facing name; the
 *  underlying `kind === "artifact"` is internal vocabulary. */
export const ARTIFACT_BADGE_TEXT = '◆ artifact';

/** Compute result the provider materialises into NotebookCellStatusBarItems.
 *  Exported so contract tests can assert on the structure without going
 *  through VS Code's status-bar collector. */
export interface ThreePaneBadges {
  streaming: boolean;
  artifact: boolean;
}

/** Read the active RunFrame (if any) for a cell. A RunFrame matches a
 *  cell when:
 *
 *    (a) its `cell_id` is one of the cell's candidate ids
 *        (per contamination-badge.candidateCellIds), AND
 *    (b) its `status === "running"` and `ended_at` is null/missing.
 *
 *  Returns the first matching RunFrame. Order is deterministic — the
 *  underlying record map is iterated in insertion order, which matches
 *  the kernel's append order. */
export function findActiveRunFrame(
  candidateIds: ReadonlyArray<string>,
  runFrames: Record<string, RawRunFrame> | undefined
): RawRunFrame | undefined {
  if (!runFrames) return undefined;
  const idSet = new Set(candidateIds);
  for (const rf of Object.values(runFrames)) {
    if (!rf || typeof rf !== 'object') continue;
    if (rf.status !== 'running') continue;
    if (rf.ended_at) continue;
    if (typeof rf.cell_id !== 'string') continue;
    if (idSet.has(rf.cell_id)) return rf;
  }
  return undefined;
}

/** Read `metadata.rts.cell.kind` off a NotebookCell. Tolerates the legacy
 *  flat shape (`metadata.rts.kind`) and the namespaced shape
 *  (`metadata.rts.cell.kind`); mirrors how the existing cell-badge /
 *  serializer modules handle the migration. */
export function readCellKind(cell: vscode.NotebookCell): string | undefined {
  const meta = cell.metadata as
    | { rts?: { kind?: unknown; cell?: { kind?: unknown } } }
    | undefined;
  const nested = meta?.rts?.cell?.kind;
  if (typeof nested === 'string') return nested;
  const flat = meta?.rts?.kind;
  if (typeof flat === 'string') return flat;
  return undefined;
}

/** Pure compute: derive the three-pane badges for a cell from a snapshot
 *  + the cell's own metadata. Returns flags; the provider class converts
 *  them to NotebookCellStatusBarItems. */
export function computeThreePaneBadges(
  cell: vscode.NotebookCell,
  snapshot: RtsSnapshot | undefined
): ThreePaneBadges {
  if (cell.kind === vscode.NotebookCellKind.Markup) {
    // Markup cells (markdown / section) never carry a streaming run nor
    // an artifact output — short-circuit per cell-kinds.md invariants.
    return { streaming: false, artifact: false };
  }
  const kind = readCellKind(cell);
  const artifact = kind === 'artifact';
  const candidateIds = candidateCellIds(cell);
  const runFrames = snapshot?.zone?.run_frames;
  const streaming = findActiveRunFrame(candidateIds, runFrames) !== undefined;
  return { streaming, artifact };
}

/** NotebookCellStatusBarItemProvider that renders the two badges on every
 *  eligible cell. Registered in extension.ts alongside the other cell-
 *  status providers (cell-badge, interrupt-button, contamination-badge,
 *  pin-status). */
export class ThreePaneBadgeStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;

  private readonly subscription: vscode.Disposable;

  public constructor(private readonly source: SidebarMetadataSource) {
    this.subscription = this.source.onChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const active = this.source.getActiveZone();
    // Only render badges for cells in the active notebook. VS Code calls
    // this provider per-cell on every open llmnb notebook; without the
    // active-zone guard we'd surface streaming state from a notebook the
    // operator isn't currently looking at (confusing).
    if (!active || active.uri.toString() !== cell.notebook.uri.toString()) {
      return [];
    }
    const { streaming, artifact } = computeThreePaneBadges(cell, active.metadata);
    const items: vscode.NotebookCellStatusBarItem[] = [];
    if (streaming) {
      const item = new vscode.NotebookCellStatusBarItem(
        STREAMING_BADGE_TEXT,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.tooltip = 'A run is in flight for this cell.';
      items.push(item);
    }
    if (artifact) {
      const item = new vscode.NotebookCellStatusBarItem(
        ARTIFACT_BADGE_TEXT,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.tooltip = 'This cell holds a promoted artifact (cell-kinds: artifact).';
      items.push(item);
    }
    return items;
  }
}
