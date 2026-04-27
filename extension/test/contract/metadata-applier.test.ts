// Contract tests for NotebookMetadataApplier (RFC-006 §8 / RFC-005 §"Persistence
// strategy").
//
// Spec references:
//   RFC-006 §8                  — `notebook.metadata` payload + Family F
//   RFC-006 §"Failure modes" W7 — schema_version major mismatch
//   RFC-006 §"Failure modes" W8 — non-monotonic snapshot_version
//   RFC-005 §"Top-level structure" — `metadata.rts.schema_version` major == "1"

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  NotebookMetadataApplier,
  ActiveNotebookProvider,
  MetadataApplierFailure
} from '../../src/notebook/metadata-applier.js';
import type { NotebookMetadataPayload } from '../../src/messaging/types.js';

const NOTEBOOK_TYPE = 'llmnb';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'metadata-applier-test-log',
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    append: noop,
    appendLine: noop,
    replace: noop,
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
    logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

/** A provider that returns a fixed notebook (created per test). */
class FixedProvider implements ActiveNotebookProvider {
  public constructor(private readonly nb: vscode.NotebookDocument | undefined) {}
  public getActiveLlmnbNotebook(): vscode.NotebookDocument | undefined {
    return this.nb;
  }
}

async function newNotebook(initialMetadata?: Record<string, unknown>): Promise<vscode.NotebookDocument> {
  const cell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    'echo hello',
    'llmnb-cell'
  );
  const data = new vscode.NotebookData([cell]);
  data.metadata = initialMetadata ?? {};
  return vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
}

function snapshotPayload(opts: {
  schema_version?: string;
  snapshot_version: number;
  extra?: Record<string, unknown>;
}): NotebookMetadataPayload {
  return {
    mode: 'snapshot',
    snapshot_version: opts.snapshot_version,
    trigger: 'end_of_run',
    snapshot: {
      schema_version: opts.schema_version ?? '1.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      event_log: { version: 1, runs: [] },
      ...opts.extra
    }
  };
}

function captureFailures(applier: NotebookMetadataApplier): MetadataApplierFailure[] {
  const out: MetadataApplierFailure[] = [];
  applier.onFailure((f) => out.push(f));
  return out;
}

suite('contract: NotebookMetadataApplier (RFC-006 §8)', () => {
  test('applies a v1.0.0 snapshot to the active notebook (happy path)', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook({ rts: { schema_version: '0.0.0' } });
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    try {
      const payload = snapshotPayload({ snapshot_version: 1 });
      applier.onNotebookMetadata(payload);
      // applyEdit is async; allow microtasks to flush.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(applier.getLastAcceptedVersion(), 1);
      const meta = nb.metadata as Record<string, unknown>;
      const rts = meta['rts'] as Record<string, unknown> | undefined;
      assert.ok(rts, 'metadata.rts must be present after apply');
      assert.equal(rts['schema_version'], '1.0.0');
    } finally {
      applier.dispose();
    }
  });

  test('preserves unknown top-level metadata keys verbatim on apply', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook({
      kernelspec: { name: 'foreign', display_name: 'Foreign' },
      rts: { schema_version: '0.0.0' }
    });
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    try {
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      const meta = nb.metadata as Record<string, unknown>;
      assert.deepEqual(
        meta['kernelspec'],
        { name: 'foreign', display_name: 'Foreign' },
        'unknown metadata keys must round-trip verbatim'
      );
    } finally {
      applier.dispose();
    }
  });

  // RFC-006 W7
  test('rejects a snapshot whose schema_version major != "1"', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    const failures = captureFailures(applier);
    try {
      applier.onNotebookMetadata(snapshotPayload({ schema_version: '2.0.0', snapshot_version: 1 }));
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(applier.getLastAcceptedVersion(), undefined, 'must not accept');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason, 'schema_version_major_mismatch');
      assert.equal(failures[0].observed_schema_major, '2');
    } finally {
      applier.dispose();
    }
  });

  // RFC-006 W8
  test('rejects non-monotonic snapshot_version', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    const failures = captureFailures(applier);
    try {
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 5 }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(applier.getLastAcceptedVersion(), 5);
      // Lower version: must reject.
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 4 }));
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(applier.getLastAcceptedVersion(), 5);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason, 'non_monotonic_snapshot');
    } finally {
      applier.dispose();
    }
  });

  test('rejects mode != "snapshot" (V1 does not support patch)', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    const failures = captureFailures(applier);
    try {
      const payload: NotebookMetadataPayload = {
        mode: 'patch',
        snapshot_version: 1,
        patch: [{ op: 'add', path: '/foo', value: 'bar' }]
      };
      applier.onNotebookMetadata(payload);
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(applier.getLastAcceptedVersion(), undefined);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason, 'unsupported_mode');
    } finally {
      applier.dispose();
    }
  });

  test('rejects when no active notebook is attached', async function (): Promise<void> {
    this.timeout(15000);
    const applier = new NotebookMetadataApplier(new FixedProvider(undefined), silentLogger());
    const failures = captureFailures(applier);
    try {
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 1 }));
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(applier.getLastAcceptedVersion(), undefined);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason, 'no_active_notebook');
    } finally {
      applier.dispose();
    }
  });

  test('accepts equal snapshot_version (>= last seen)', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    try {
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 3 }));
      await new Promise((r) => setTimeout(r, 50));
      // Equal version: also accepted (RFC-006 W8: "lower than" is the
      // rejection condition; equal is benign).
      applier.onNotebookMetadata(snapshotPayload({ snapshot_version: 3, extra: { drift_log: [] } }));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(applier.getLastAcceptedVersion(), 3);
    } finally {
      applier.dispose();
    }
  });
});
