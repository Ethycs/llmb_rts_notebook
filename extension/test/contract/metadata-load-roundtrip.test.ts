// Integration test for the hydrate round-trip — RFC-006 §8 v2.0.2.
//
// Stub-kernel echo path: the loader ships `mode:"hydrate"` outbound, the
// stub kernel turns that into `mode:"snapshot"` `trigger:"hydrate_complete"`
// inbound, the loader's confirmation handler clears the watchdog, and the
// applier writes the snapshot back to `notebook.metadata.rts`.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MessageRouter } from '../../src/messaging/router.js';
import { MetadataLoader } from '../../src/notebook/metadata-loader.js';
import {
  NotebookMetadataApplier,
  ActiveNotebookProvider
} from '../../src/notebook/metadata-applier.js';
import type {
  RtsV2Envelope,
  NotebookMetadataPayload,
  RtsMetadataSnapshot
} from '../../src/messaging/types.js';

const NOTEBOOK_TYPE = 'llmnb';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'roundtrip-test-log',
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    append: noop, appendLine: noop, replace: noop, clear: noop,
    show: noop, hide: noop, dispose: noop, logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

class FixedProvider implements ActiveNotebookProvider {
  public constructor(private readonly nb: vscode.NotebookDocument | undefined) {}
  public getActiveLlmnbNotebook(): vscode.NotebookDocument | undefined {
    return this.nb;
  }
}

suite('integration: hydrate round-trip (loader → stub kernel → applier)', () => {
  test('the loader-applier round-trip applies post-hydrate snapshot to the notebook', async function (): Promise<void> {
    this.timeout(15000);
    const initialRts: RtsMetadataSnapshot = {
      schema_version: '1.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      snapshot_version: 3,
      event_log: { version: 1, runs: [] }
    };
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'echo hydrate',
      'llmnb-cell'
    );
    const data = new vscode.NotebookData([cell]);
    data.metadata = { rts: initialRts };
    const nb = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);

    const router = new MessageRouter(silentLogger());
    const applier = new NotebookMetadataApplier(new FixedProvider(nb), silentLogger());
    const env = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      showWarning: () => {}
    };
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);

    const subApplier = router.registerMetadataObserver(applier);

    // Stub kernel: when an outbound `mode:"hydrate"` envelope ships, send back
    // a `mode:"snapshot"` `trigger:"hydrate_complete"` envelope after a
    // microtask delay. This is the contract the kernel side promises in
    // RFC-006 §8 v2.0.2.
    const stubSub = router.subscribeOutbound((envelope) => {
      if (envelope.type !== 'notebook.metadata') {
        return;
      }
      const out = envelope as RtsV2Envelope<NotebookMetadataPayload>;
      if (out.payload.mode !== 'hydrate') {
        return;
      }
      // Echo back as snapshot mode with hydrate_complete trigger.
      const echo: RtsV2Envelope<NotebookMetadataPayload> = {
        type: 'notebook.metadata',
        payload: {
          mode: 'snapshot',
          snapshot_version: out.payload.snapshot_version + 1,
          trigger: 'hydrate_complete',
          snapshot: {
            ...out.payload.snapshot!,
            // The kernel adds a drift_log entry on hydrate.
            drift_log: [
              {
                detected_at: '2026-04-26T13:00:00.000Z',
                field_path: 'config.volatile.kernel.rfc_005_version',
                previous_value: '0.9.0',
                current_value: '1.0.0',
                severity: 'info',
                operator_acknowledged: false
              }
            ]
          }
        }
      };
      // Defer to a microtask so the loader's pending watchdog is registered
      // before the confirmation arrives.
      queueMicrotask(() => router.route(echo));
    });

    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'shipped');
      // Allow the deferred echo + applyEdit to run.
      await new Promise((r) => setTimeout(r, 100));
      // The watchdog cleared.
      assert.equal(loader.getPendingCount(), 0);
      // Applier wrote the post-hydrate snapshot back.
      assert.equal(applier.getLastAcceptedVersion(), 4);
      const meta = nb.metadata as Record<string, unknown>;
      const rts = meta['rts'] as Record<string, unknown> | undefined;
      assert.ok(rts, 'metadata.rts must be present after hydrate confirmation');
      assert.equal(rts!['schema_version'], '1.0.0');
      const drift = rts!['drift_log'] as unknown[] | undefined;
      assert.ok(drift && drift.length === 1, 'drift_log must round-trip from kernel');
    } finally {
      stubSub.dispose();
      subApplier.dispose();
      loader.dispose();
      applier.dispose();
    }
  });
});
