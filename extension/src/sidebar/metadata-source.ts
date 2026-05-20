// PLAN-S7 — Sidebar metadata source.
//
// A thin handle the three TreeDataProviders share for reading
// `metadata.rts` snapshots out of open llmnb notebook documents.
// Mirrors the `DocumentBackedSectionMetadataSource` pattern from
// section-header-provider.ts: the document is the single source of
// truth, and `onLastAcceptedVersion` (slice 1) is the change signal.

import * as vscode from 'vscode';
import type { NotebookMetadataApplier } from '../notebook/metadata-applier.js';
import type { RtsSnapshot } from './types.js';

/** Per-notebook snapshot the providers consume. */
export interface NotebookSnapshot {
  uri: vscode.Uri;
  /** File-system label (basename of the .llmnb file). */
  label: string;
  /** Parsed `metadata.rts` shape; `undefined` if the notebook has no
   *  RTS metadata yet (newly created from template). */
  metadata: RtsSnapshot | undefined;
}

/** Read-only handle the providers consume. Production wires the
 *  document-backed implementation below; tests inject a fake. */
export interface SidebarMetadataSource {
  readonly onChange: vscode.Event<void>;
  /** All open llmnb notebooks in the workspace, in workspace insertion
   *  order. Empty when no llmnb is open. */
  getAllZones(): NotebookSnapshot[];
  /** The currently active llmnb notebook (window focus); `undefined`
   *  when the active editor is non-llmnb or no editor is focused. */
  getActiveZone(): NotebookSnapshot | undefined;
}

function basename(uri: vscode.Uri): string {
  const path = uri.path;
  const slashAt = path.lastIndexOf('/');
  return slashAt >= 0 ? path.slice(slashAt + 1) : path;
}

function readRtsMetadata(notebook: vscode.NotebookDocument): RtsSnapshot | undefined {
  const meta = notebook.metadata as { rts?: unknown } | undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  const rts = meta.rts;
  if (!rts || typeof rts !== 'object' || Array.isArray(rts)) return undefined;
  return rts as RtsSnapshot;
}

/** Default source — reads off live `vscode.NotebookDocument` metadata.
 *
 *  Change signal sources (all OR'd together):
 *    - `onLastAcceptedVersion` from the metadata applier (slice 1)
 *      — fires after each accepted kernel snapshot apply.
 *    - `vscode.workspace.onDidChangeNotebookDocument` — local edits.
 *    - `vscode.workspace.onDidOpenNotebookDocument` / `onDidCloseNotebookDocument`
 *      — workspace-wide zone changes.
 *    - `vscode.window.onDidChangeActiveNotebookEditor` — active-zone shifts.
 *
 *  All signals are coalesced through a single 200ms throttle so bursty
 *  turn arrivals don't thrash the trees (PLAN-S7 §6 "Live-update storm"). */
export class DocumentBackedSidebarMetadataSource
  implements SidebarMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onChange = this.emitter.event;

  private readonly subscriptions: vscode.Disposable[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly notebookType: string,
    applier: NotebookMetadataApplier,
    private readonly throttleMs: number = 200
  ) {
    this.subscriptions.push(
      applier.onLastAcceptedVersion(() => this.scheduleFire()),
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (e.notebook.notebookType === this.notebookType) this.scheduleFire();
      }),
      vscode.workspace.onDidOpenNotebookDocument((nb) => {
        if (nb.notebookType === this.notebookType) this.scheduleFire();
      }),
      vscode.workspace.onDidCloseNotebookDocument((nb) => {
        if (nb.notebookType === this.notebookType) this.scheduleFire();
      }),
      vscode.window.onDidChangeActiveNotebookEditor(() => this.scheduleFire())
    );
  }

  public dispose(): void {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    for (const d of this.subscriptions) d.dispose();
    this.emitter.dispose();
  }

  public getAllZones(): NotebookSnapshot[] {
    const out: NotebookSnapshot[] = [];
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== this.notebookType) continue;
      out.push({
        uri: nb.uri,
        label: basename(nb.uri),
        metadata: readRtsMetadata(nb)
      });
    }
    return out;
  }

  public getActiveZone(): NotebookSnapshot | undefined {
    const ed = vscode.window.activeNotebookEditor;
    if (!ed || ed.notebook.notebookType !== this.notebookType) return undefined;
    return {
      uri: ed.notebook.uri,
      label: basename(ed.notebook.uri),
      metadata: readRtsMetadata(ed.notebook)
    };
  }

  /** Test seam — force-fire the change event immediately. */
  public fireNow(): void {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.emitter.fire();
  }

  private scheduleFire(): void {
    if (this.pendingTimer !== undefined) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.emitter.fire();
    }, this.throttleMs);
  }
}

/** Test-only in-memory source. Tests `set()` snapshots and the
 *  providers re-render. */
export class InMemorySidebarMetadataSource
  implements SidebarMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onChange = this.emitter.event;

  private zones: NotebookSnapshot[] = [];
  private activeIndex: number = -1;

  public dispose(): void {
    this.emitter.dispose();
  }

  public getAllZones(): NotebookSnapshot[] {
    return this.zones.slice();
  }

  public getActiveZone(): NotebookSnapshot | undefined {
    if (this.activeIndex < 0 || this.activeIndex >= this.zones.length) {
      return undefined;
    }
    return this.zones[this.activeIndex];
  }

  /** Replace all zones; index 0 becomes the active zone. */
  public set(zones: NotebookSnapshot[], activeIndex: number = 0): void {
    this.zones = zones.slice();
    this.activeIndex = zones.length > 0 ? activeIndex : -1;
    this.emitter.fire();
  }
}
