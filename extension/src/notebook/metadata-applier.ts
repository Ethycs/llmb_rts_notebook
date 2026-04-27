// RFC-006 Family F consumer — applies `notebook.metadata` snapshots to the
// open VS Code notebook document.
//
// Per RFC-006 §8 + RFC-005 §"Persistence strategy":
//   - The kernel is the single logical writer of `metadata.rts`.
//   - The kernel ships snapshots over the `llmnb.rts.v2` Comm.
//   - This module receives `notebook.metadata` envelopes from the router,
//     validates them per RFC-006 §"Failure modes" W7/W8, and applies via
//     `vscode.NotebookEdit.updateNotebookMetadata`.
//   - VS Code's normal save flow then persists the document to disk.
//
// Validation rules (all per RFC-006 §"Failure modes"):
//   - W7: `snapshot.schema_version` major MUST match RFC-005 (`"1"`); on
//     mismatch, log + discard + emit a wire-failure event.
//   - W8: `snapshot_version` MUST be monotonic (>= last seen); non-monotonic
//     emissions are logged + discarded (the receiver retains its current
//     state).
//   - V1 only supports `mode == "snapshot"`; `mode == "patch"` (V1.5+) is
//     rejected with a "not yet supported" log.
//   - Unknown keys in the snapshot are preserved verbatim (RFC-005 §"Top-level
//     structure" — old readers MUST ignore unknown keys; the applier's job is
//     to round-trip them so future kernels and replay harnesses see them).

import * as vscode from 'vscode';
import {
  NotebookMetadataPayload,
  RtsMetadataSnapshot,
  RFC005_SCHEMA_MAJOR
} from '../messaging/types.js';
import { NotebookMetadataObserver } from '../messaging/router.js';

/** Optional surface used by the extension to look up the active notebook
 *  document. In production this is a thin wrapper over
 *  `vscode.window.activeNotebookEditor` plus a fallback that scans
 *  `vscode.workspace.notebookDocuments` for the `llmnb` notebook type. */
export interface ActiveNotebookProvider {
  /** Returns the currently-attached `.llmnb` notebook document, or `undefined`
   *  if no editor is active. */
  getActiveLlmnbNotebook(): vscode.NotebookDocument | undefined;
}

/** Wire-level diagnostic emitted when an applier rejects an envelope. The
 *  router's outbound surface (TBD V2) will eventually carry these back to
 *  the kernel as `notebook.metadata.error`; for V1 the applier just logs.
 *  See RFC-006 §"Failure modes" rows W7/W8. */
export interface MetadataApplierFailure {
  reason: 'schema_version_major_mismatch' | 'non_monotonic_snapshot' | 'unsupported_mode' | 'no_active_notebook' | 'apply_failed';
  /** Snapshot version that triggered the failure (best-effort). */
  snapshot_version?: number;
  /** Receiver's RFC-005 schema major (always RFC005_SCHEMA_MAJOR for V1). */
  expected_schema_major?: string;
  /** The producer's schema major as observed on the wire. */
  observed_schema_major?: string;
  /** Last accepted snapshot_version (for W8 audit). */
  last_accepted_version?: number;
  /** Free-form detail. */
  detail?: string;
}

/** Default `ActiveNotebookProvider` driven by VS Code's editor APIs. */
export class WindowActiveNotebookProvider implements ActiveNotebookProvider {
  public constructor(private readonly notebookType: string) {}

  public getActiveLlmnbNotebook(): vscode.NotebookDocument | undefined {
    const active = vscode.window.activeNotebookEditor?.notebook;
    if (active && active.notebookType === this.notebookType) {
      return active;
    }
    // Fallback: scan all open notebook documents for the registered type.
    // V1 supports a single attached notebook per kernel session; if multiple
    // are open the first match wins (the kernel routes to "the" notebook).
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType === this.notebookType) {
        return nb;
      }
    }
    return undefined;
  }
}

/** Applier for `notebook.metadata` envelopes (RFC-006 Family F). */
export class NotebookMetadataApplier implements NotebookMetadataObserver {
  private lastAcceptedVersion: number | undefined;
  private readonly failureEmitter = new vscode.EventEmitter<MetadataApplierFailure>();

  /** Subscribe to wire-failure events (RFC-006 W7/W8). The router stub for
   *  the operator-acknowledgment surface will subscribe here in V2. */
  public readonly onFailure = this.failureEmitter.event;

  public constructor(
    private readonly active: ActiveNotebookProvider,
    private readonly logger: vscode.LogOutputChannel
  ) {}

  public dispose(): void {
    this.failureEmitter.dispose();
  }

  /** RunLifecycleObserver-style hook invoked by `MessageRouter` for inbound
   *  `notebook.metadata` envelopes. Validates per W7/W8, then applies. */
  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    // V1 only accepts snapshot mode. Patch mode (V1.5+) is reserved per
    // RFC-006 §8 / RFC-005 §"Open issues queued for amendment".
    if (payload.mode !== 'snapshot') {
      this.logger.warn(
        `[metadata-applier] unsupported mode "${payload.mode}" (V1 supports "snapshot" only) — discarding`
      );
      this.fail({
        reason: 'unsupported_mode',
        snapshot_version: payload.snapshot_version,
        detail: `mode=${payload.mode}`
      });
      return;
    }
    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      this.logger.warn('[metadata-applier] snapshot mode but no `snapshot` field; discarding');
      this.fail({
        reason: 'apply_failed',
        snapshot_version: payload.snapshot_version,
        detail: 'snapshot field is missing or non-object'
      });
      return;
    }
    // RFC-006 W7: schema_version major must match RFC-005's major.
    const observedMajor = String(snapshot.schema_version ?? '').split('.')[0];
    if (observedMajor !== RFC005_SCHEMA_MAJOR) {
      this.logger.error(
        `[metadata-applier] W7 schema_version major mismatch: expected="${RFC005_SCHEMA_MAJOR}" observed="${observedMajor}" (full="${snapshot.schema_version}")`
      );
      this.fail({
        reason: 'schema_version_major_mismatch',
        snapshot_version: payload.snapshot_version,
        expected_schema_major: RFC005_SCHEMA_MAJOR,
        observed_schema_major: observedMajor
      });
      return;
    }
    // RFC-006 W8: snapshot_version must be monotonic (>= last seen).
    if (
      this.lastAcceptedVersion !== undefined &&
      payload.snapshot_version < this.lastAcceptedVersion
    ) {
      this.logger.error(
        `[metadata-applier] W8 non-monotonic snapshot_version: received=${payload.snapshot_version} last=${this.lastAcceptedVersion}`
      );
      this.fail({
        reason: 'non_monotonic_snapshot',
        snapshot_version: payload.snapshot_version,
        last_accepted_version: this.lastAcceptedVersion
      });
      return;
    }
    void this.apply(snapshot, payload.snapshot_version);
  }

  /** Apply a validated snapshot to the active notebook. RFC-005 §"Persistence
   *  strategy" — only `metadata.rts` is owned by the kernel; everything else
   *  in `metadata` is preserved verbatim on round-trip. */
  private async apply(
    snapshot: RtsMetadataSnapshot,
    snapshotVersion: number
  ): Promise<void> {
    const notebook = this.active.getActiveLlmnbNotebook();
    if (!notebook) {
      this.logger.warn(
        `[metadata-applier] no active llmnb notebook to apply snapshot v=${snapshotVersion}`
      );
      this.fail({
        reason: 'no_active_notebook',
        snapshot_version: snapshotVersion
      });
      return;
    }
    // Preserve unknown keys verbatim. The kernel owns `rts`; everything else
    // (e.g. `kernelspec`, `language_info` from the ipynb header) is kept.
    const currentMetadata = (notebook.metadata ?? {}) as Record<string, unknown>;
    const nextMetadata: Record<string, unknown> = {
      ...currentMetadata,
      rts: snapshot
    };
    try {
      const edit = new vscode.WorkspaceEdit();
      const notebookEdit = vscode.NotebookEdit.updateNotebookMetadata(nextMetadata);
      edit.set(notebook.uri, [notebookEdit]);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        this.logger.error(
          `[metadata-applier] applyEdit returned false (v=${snapshotVersion} uri=${notebook.uri.toString()})`
        );
        this.fail({
          reason: 'apply_failed',
          snapshot_version: snapshotVersion,
          detail: 'vscode.workspace.applyEdit returned false'
        });
        return;
      }
      this.lastAcceptedVersion = snapshotVersion;
      this.logger.debug(
        `[metadata-applier] applied snapshot v=${snapshotVersion} (uri=${notebook.uri.toString()})`
      );
    } catch (err) {
      this.logger.error(
        `[metadata-applier] applyEdit threw: ${String(err)}`
      );
      this.fail({
        reason: 'apply_failed',
        snapshot_version: snapshotVersion,
        detail: String(err)
      });
    }
  }

  /** Test-only accessor; production code never calls this. */
  public getLastAcceptedVersion(): number | undefined {
    return this.lastAcceptedVersion;
  }

  private fail(failure: MetadataApplierFailure): void {
    try {
      this.failureEmitter.fire(failure);
    } catch (err) {
      this.logger.warn(`[metadata-applier] failure emitter threw: ${String(err)}`);
    }
  }
}
