// Contract tests for MetadataLoader — RFC-006 §8 v2.0.2 hydrate path.
//
// Spec references:
//   RFC-006 §8 (v2.0.2)            — bidirectional Family F + hydrate
//   RFC-005 §"Top-level structure" — schema_version major == "1"
//   RFC-005 §config (security)     — forbidden field names

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  MetadataLoader,
  scanForbiddenSecrets,
  HYDRATE_CONFIRMATION_TIMEOUT_MS
} from '../../src/notebook/metadata-loader.js';
import { MessageRouter } from '../../src/messaging/router.js';
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
    name: 'metadata-loader-test-log',
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

interface RecordingEnv {
  infos: string[];
  warns: string[];
  errors: string[];
  banners: string[];
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void };
  showWarning: (m: string) => void;
}

function recordingEnv(): RecordingEnv {
  const out: RecordingEnv = {
    infos: [],
    warns: [],
    errors: [],
    banners: [],
    logger: {
      info(s): void { out.infos.push(s); },
      warn(s): void { out.warns.push(s); },
      error(s): void { out.errors.push(s); }
    },
    showWarning(m): void { out.banners.push(m); }
  };
  return out;
}

async function newNotebook(rts?: RtsMetadataSnapshot): Promise<vscode.NotebookDocument> {
  const cell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    'echo hello',
    'llmnb-cell'
  );
  const data = new vscode.NotebookData([cell]);
  data.metadata = rts ? { rts } : {};
  return vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
}

function captureOutbound(router: MessageRouter): RtsV2Envelope<NotebookMetadataPayload>[] {
  const out: RtsV2Envelope<NotebookMetadataPayload>[] = [];
  router.subscribeOutbound((env) => {
    if (env.type === 'notebook.metadata') {
      out.push(env as RtsV2Envelope<NotebookMetadataPayload>);
    }
  });
  return out;
}

suite('contract: MetadataLoader (RFC-006 §8 v2.0.2 hydrate path)', () => {
  test('ships a hydrate envelope when metadata.rts has persisted state', async function (): Promise<void> {
    this.timeout(15000);
    const rts: RtsMetadataSnapshot = {
      schema_version: '1.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      snapshot_version: 7,
      event_log: { version: 1, runs: [] }
    };
    const nb = await newNotebook(rts);
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const captured = captureOutbound(router);
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'shipped');
      assert.equal(captured.length, 1);
      assert.equal(captured[0].type, 'notebook.metadata');
      assert.equal(captured[0].payload.mode, 'hydrate');
      assert.equal(captured[0].payload.trigger, 'open');
      assert.equal(captured[0].payload.snapshot_version, 7);
      assert.equal(
        (captured[0].payload.snapshot as { schema_version?: string }).schema_version,
        '1.0.0'
      );
      // Watchdog armed; clear before suite ends.
      loader.clearPendingFor(nb.uri.toString());
    } finally {
      loader.dispose();
    }
  });

  test('skips hydrate ship when metadata.rts is absent (new empty notebook)', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const captured = captureOutbound(router);
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'skipped_no_metadata');
      assert.equal(captured.length, 0);
      assert.equal(env.banners.length, 0);
    } finally {
      loader.dispose();
    }
  });

  test('refuses to ship and surfaces a banner on schema_version major mismatch', async function (): Promise<void> {
    this.timeout(15000);
    const rts: RtsMetadataSnapshot = {
      schema_version: '2.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      event_log: { version: 1, runs: [] }
    };
    const nb = await newNotebook(rts);
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const captured = captureOutbound(router);
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'rejected_schema_mismatch');
      assert.equal(result.observed_schema_major, '2');
      assert.equal(captured.length, 0);
      assert.equal(env.banners.length, 1);
      assert.match(env.banners[0], /incompatible file format/);
    } finally {
      loader.dispose();
    }
  });

  test('refuses to ship when metadata.rts.config carries a forbidden secret-shaped field', async function (): Promise<void> {
    this.timeout(15000);
    const rts: RtsMetadataSnapshot = {
      schema_version: '1.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      config: {
        version: 1,
        recoverable: {
          agents: [
            { id: 'alpha', model: 'claude-sonnet-4-5', api_key: 'sk-ant-XXX-leak' }
          ]
        },
        volatile: {}
      },
      event_log: { version: 1, runs: [] }
    };
    const nb = await newNotebook(rts);
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const captured = captureOutbound(router);
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'rejected_forbidden_secret');
      assert.ok(result.forbidden_matches);
      assert.ok(result.forbidden_matches!.length >= 1);
      // The error log MUST NOT contain the value (only the path).
      for (const err of env.errors) {
        assert.equal(err.includes('sk-ant-XXX-leak'), false, 'error log leaks secret value');
      }
      // The banner MUST NOT contain the value either.
      for (const b of env.banners) {
        assert.equal(b.includes('sk-ant-XXX-leak'), false, 'banner leaks secret value');
      }
      assert.equal(captured.length, 0);
    } finally {
      loader.dispose();
    }
  });

  test('detects a variety of forbidden field-name patterns', () => {
    const matches = scanForbiddenSecrets(
      {
        api_key: 'x',
        anthropic_api_key: 'x',
        nested: {
          openai_token: 'x',
          db_password: 'x',
          plain_field: 'ok'
        },
        Authorization: 'x',
        cookie: 'x',
        bearer: 'x',
        client_secret: 'x',
        agents: [{ provider_key: 'x' }]
      },
      'metadata.rts.config'
    );
    const paths = matches.map((m) => m.path).sort();
    assert.deepEqual(paths, [
      'metadata.rts.config.Authorization',
      'metadata.rts.config.agents[0].provider_key',
      'metadata.rts.config.anthropic_api_key',
      'metadata.rts.config.api_key',
      'metadata.rts.config.bearer',
      'metadata.rts.config.client_secret',
      'metadata.rts.config.cookie',
      'metadata.rts.config.nested.db_password',
      'metadata.rts.config.nested.openai_token'
    ]);
  });

  test('clears the watchdog when a hydrate_complete confirmation arrives', async function (): Promise<void> {
    this.timeout(15000);
    const rts: RtsMetadataSnapshot = {
      schema_version: '1.0.0',
      session_id: '00000000-0000-4000-8000-000000000000',
      snapshot_version: 1,
      event_log: { version: 1, runs: [] }
    };
    const nb = await newNotebook(rts);
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(nb);
      assert.equal(result.outcome, 'shipped');
      assert.equal(loader.getPendingCount(), 1);
      // Simulate a kernel hydrate_complete.
      router.route({
        type: 'notebook.metadata',
        payload: {
          mode: 'snapshot',
          snapshot_version: 2,
          trigger: 'hydrate_complete',
          snapshot: rts
        }
      });
      assert.equal(loader.getPendingCount(), 0);
      assert.equal(env.banners.length, 0);
    } finally {
      loader.dispose();
    }
  });

  test('exports the expected timeout (10s per RFC-006 §8 v2.0.2)', () => {
    assert.equal(HYDRATE_CONFIRMATION_TIMEOUT_MS, 10_000);
  });

  test('skips ship for non-llmnb notebook types', async function (): Promise<void> {
    this.timeout(15000);
    // Build a synthetic non-llmnb notebook surface; openNotebookDocument
    // requires a registered type, so use a JS object that quacks like
    // NotebookDocument for the loader's purposes.
    const fake = {
      notebookType: 'jupyter-notebook',
      uri: vscode.Uri.parse('untitled:foo.ipynb'),
      metadata: { rts: { schema_version: '1.0.0' } }
    } as unknown as vscode.NotebookDocument;
    const router = new MessageRouter(silentLogger());
    const env = recordingEnv();
    const captured = captureOutbound(router);
    const loader = new MetadataLoader(router, env, NOTEBOOK_TYPE);
    try {
      const result = await loader.onDidOpenNotebook(fake);
      assert.equal(result.outcome, 'skipped_no_metadata');
      assert.equal(captured.length, 0);
    } finally {
      loader.dispose();
    }
  });
});
