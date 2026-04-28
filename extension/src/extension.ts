// llmb RTS Notebook — V1 extension entry point.
//
// Per DR-0009 (chapter 06) the cell paradigm is kept and the Jupyter kernel
// process is dropped: cells dispatch through a NotebookController callback
// that lives inside the extension host. This module wires activation:
// serializer + controller + RFC-006 message router + RFC-006 Family F
// metadata-applier. The MIME renderer for application/vnd.rts.run+json is
// registered by the notebookRenderer contribution in package.json
// (see renderers/run-renderer.ts).
//
// I-X: switched router to v2 (thin envelope, Comm target llmnb.rts.v2),
// added the metadata-applier consumer for `notebook.metadata`, and updated
// StubKernelClient to emit bare OTLP spans plus optional `agent_emit` test
// spans and `notebook.metadata` envelopes for renderer/applier exercising.
//
// I-T-X: replaced JupyterKernelClient with PtyKernelClient per RFC-008.
// LLMKernel is now spawned as a subprocess via node-pty; the data plane is a
// UDS / named-pipe / TCP socket carrying newline-delimited JSON. Dropped the
// `@jupyterlab/services` dependency and the Jupyter Server config keys.
// Added `LLMNB: Show kernel terminal` (RFC-008 §3 debug surface) and
// LogRecordObserver wiring for OTLP/JSON LogRecord frames.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/notebooks/controllers/controllerRegistration.ts
// where activation builds and disposes the controller graph.

import * as vscode from 'vscode';
import { MessageRouter, OtlpLogRecord } from './messaging/router.js';
import {
  LlmnbNotebookController,
  KernelClient,
  KernelExecuteRequest,
  KernelEventSink
} from './notebook/controller.js';
import { LlmnbNotebookSerializer } from './llmnb/serializer.js';
import {
  PtyKernelClient,
  PtyKernelConfig
} from './notebook/pty-kernel-client.js';
import { KernelTerminal } from './notebook/kernel-terminal.js';
import {
  RtsV2Envelope,
  LayoutEditPayload,
  NotebookMetadataPayload,
  RunMimePayload,
  RunCompletePayload,
  RunStartPayload
} from './messaging/types.js';
import { encodeAttrs } from './otel/attrs.js';
import { MapViewPanel } from './webviews/map-view-panel.js';
import {
  NotebookMetadataApplier,
  WindowActiveNotebookProvider
} from './notebook/metadata-applier.js';
import {
  MetadataLoader
} from './notebook/metadata-loader.js';
import { HeartbeatConsumer } from './messaging/heartbeat-consumer.js';
import { BlobResolver } from './llmnb/blob-resolver.js';
import type { BlobEntry } from './llmnb/blob-resolver.js';

const NOTEBOOK_TYPE = 'llmnb';

let activeController: LlmnbNotebookController | undefined;
let activeRouter: MessageRouter | undefined;
let activeLogger: vscode.LogOutputChannel | undefined;
let activeKernel: KernelClient | undefined;
let activeApplier: NotebookMetadataApplier | undefined;
let activeLoader: MetadataLoader | undefined;
let activeHeartbeat: HeartbeatConsumer | undefined;
let activeBlobResolver: BlobResolver | undefined;
let activeSessionId: string | undefined;

// Diagnostic ring buffers — populated only when LLMNB_E2E_VERBOSE === '1'.
// Tests subscribe via the ExtensionApi accessors; production builds zero
// out the buffers below to avoid memory growth.
const E2E_VERBOSE = process.env.LLMNB_E2E_VERBOSE === '1';
const RING_LIMIT = 200;
const ptyByteRing: string[] = [];
const logRecordRing: unknown[] = [];
const frameRing: unknown[] = [];
function pushRing(ring: unknown[], item: unknown): void {
  if (!E2E_VERBOSE) return;
  ring.push(item);
  if (ring.length > RING_LIMIT) ring.shift();
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const baseLogger = vscode.window.createOutputChannel('LLMNB Extension', { log: true });
  context.subscriptions.push(baseLogger);
  // BSP-001 / Testing.md §6: under LLMNB_E2E_VERBOSE=1, tee every
  // log line to stderr so Tier 4 / Tier 5 operators can see extension-
  // side activity (controller, router, kernel client). The output
  // channel is invisible from a CLI test runner. Without this tee,
  // failures look like "agent ran but cell stayed blank" with no way
  // to tell whether onRunStart/onRunComplete fired, whether
  // appendOutput was called, or whether MessageRouter classified the
  // payload at all. Wraps the LogOutputChannel surface; production
  // builds (env var unset) bypass the wrapper and pay zero overhead.
  const logger: vscode.LogOutputChannel = E2E_VERBOSE
    ? new Proxy(baseLogger, {
        get(target, prop, receiver) {
          if (prop === 'trace' || prop === 'debug' || prop === 'info' ||
              prop === 'warn' || prop === 'error') {
            return (msg: string, ...args: unknown[]): void => {
              // eslint-disable-next-line no-console
              console.error(`[ext-log][${String(prop)}] ${msg}`,
                ...(args.length > 0 ? [JSON.stringify(args)] : []));
              const orig = Reflect.get(target, prop, receiver) as (m: string, ...a: unknown[]) => void;
              orig.call(target, msg, ...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      })
    : baseLogger;
  activeLogger = logger;
  logger.info('[llmnb] activate');

  const router = new MessageRouter(logger);
  activeRouter = router;

  // RFC-008 §"Default consumer": fan log records into the extension output
  // channel. High-severity surfacing (toasts) is V1.5+.
  context.subscriptions.push(
    router.registerLogRecordHandler((rec: OtlpLogRecord) => {
      const text =
        (rec.body && typeof rec.body.stringValue === 'string'
          ? rec.body.stringValue
          : JSON.stringify(rec)) ?? '';
      const sev = rec.severityText ?? `S${rec.severityNumber}`;
      logger.info(`[kernel-log][${sev}] ${text}`);
      pushRing(logRecordRing, { sev, text, raw: rec });
    })
  );

  const sessionId = randomUuid();
  activeSessionId = sessionId;

  // I-X: the StubKernelClient remains available behind a config flag for
  // offline development and unit tests. The production path now spawns
  // LLMKernel as a subprocess via node-pty per RFC-008; @jupyterlab/services
  // is no longer used.
  const useStub = vscode.workspace
    .getConfiguration('llmnb')
    .get<boolean>('kernel.useStub', false);
  const kernel: KernelClient = useStub
    ? new StubKernelClient(logger)
    : new PtyKernelClient(loadKernelConfig(sessionId), router, logger);
  activeKernel = kernel;
  if (kernel instanceof StubKernelClient) {
    kernel.attachRouter(router);
  }

  const controller = new LlmnbNotebookController(NOTEBOOK_TYPE, kernel, router, logger);
  context.subscriptions.push(controller);
  activeController = controller;

  const serializer = new LlmnbNotebookSerializer();
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, {
      transientOutputs: false,
      transientCellMetadata: { executionOrder: false }
    })
  );

  // RFC-006 §8 Family F consumer: the applier receives `notebook.metadata`
  // envelopes and applies them to the open notebook document. RFC-005 §"Persistence
  // strategy" — the kernel is the single logical writer of metadata.rts; the
  // applier is the only path that mutates metadata.rts from the extension side.
  const applier = new NotebookMetadataApplier(
    new WindowActiveNotebookProvider(NOTEBOOK_TYPE),
    logger
  );
  activeApplier = applier;
  context.subscriptions.push({ dispose: () => applier.dispose() });
  context.subscriptions.push(router.registerMetadataObserver(applier));

  // RFC-006 §8 v2.0.2 — Family F is bidirectional: when the operator opens an
  // `.llmnb` with persisted state, the loader extracts `metadata.rts` and
  // ships a `mode:"hydrate"` envelope outbound. The kernel respawns agents
  // and sends a `mode:"snapshot"` `trigger:"hydrate_complete"` confirmation
  // back through the applier path within 10s.
  const loader = new MetadataLoader(
    router,
    {
      logger: { info: (s) => logger.info(s), warn: (s) => logger.warn(s), error: (s) => logger.error(s) },
      showWarning: (msg) => {
        void vscode.window.showWarningMessage(msg);
      }
    },
    NOTEBOOK_TYPE
  );
  activeLoader = loader;
  context.subscriptions.push({ dispose: () => loader.dispose() });
  // Hook into VS Code's notebook-open lifecycle. RFC-006 §8 hydrate envelopes
  // ship per-open; PtyKernelClient was started above so the data plane is
  // (or will become) ready by the time the kernel's read loop processes the
  // envelope. Already-open notebooks at activation time also get a hydrate
  // ship so reload-after-crash works.
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((nb) => {
      void loader.onDidOpenNotebook(nb);
    })
  );
  for (const nb of vscode.workspace.notebookDocuments) {
    if (nb.notebookType === NOTEBOOK_TYPE) {
      void loader.onDidOpenNotebook(nb);
    }
  }

  // RFC-006 §7 v2.0.2 — `heartbeat.kernel` consumer + liveness watchdog.
  // The kernel emits a heartbeat every 5s; the watchdog flags an operator
  // warning when >30s elapse without a heartbeat and the PTY transport is
  // healthy (PTY-EOF / SIGCHLD already cover "process died").
  const heartbeat = new HeartbeatConsumer({
    onState: (payload) => {
      logger.trace(`[heartbeat] state=${payload.kernel_state} uptime=${payload.uptime_seconds}s`);
    },
    sink: {
      onLivenessLost: ({ sinceMs }) => {
        const sec = Math.round(sinceMs / 1000);
        void vscode.window.showWarningMessage(
          `LLMNB: kernel may be hung — no heartbeat for ${sec}s while PTY remains healthy.`
        );
      }
    },
    pty: {
      isHealthy: () => {
        // PtyKernelClient owns transport health; the stub always reports OK
        // because the stub doesn't emit heartbeats anyway (so the watchdog's
        // "lastHeartbeatTimestamp === 0" guard never starts ticking).
        if (kernel instanceof PtyKernelClient) {
          const ph = (kernel as unknown as { isPtyHealthy?: () => boolean }).isPtyHealthy;
          return typeof ph === 'function' ? ph.call(kernel) : true;
        }
        return true;
      }
    }
  });
  activeHeartbeat = heartbeat;
  context.subscriptions.push(router.registerHeartbeatKernelObserver(heartbeat));
  heartbeat.start();
  context.subscriptions.push({ dispose: () => heartbeat.dispose() });

  // RFC-005 §"metadata.rts.blobs" — instantiate a per-session BlobResolver so
  // renderers can resolve `$blob:sha256:` sentinels in attribute values. The
  // table refreshes whenever a notebook.metadata snapshot lands; the loader
  // and applier are the snapshot consumers, but the resolver only needs the
  // most recent table.
  let activeBlobs: Record<string, BlobEntry> = {};
  activeBlobResolver = new BlobResolver(activeBlobs);
  context.subscriptions.push(
    router.registerMetadataObserver({
      onNotebookMetadata: (payload) => {
        if (payload.mode !== 'snapshot' || !payload.snapshot) {
          return;
        }
        const next = (payload.snapshot as { blobs?: Record<string, BlobEntry> }).blobs;
        if (next && typeof next === 'object') {
          activeBlobs = next;
          activeBlobResolver = new BlobResolver(activeBlobs);
        }
      }
    })
  );

  // Wire the kernel client as the router's outbound subscriber so layout.edit
  // / agent_graph.query / operator.action envelopes ride the active socket.
  // Stub kernels accept (and silently swallow) outbound traffic; that's the
  // intended offline-development behaviour.
  context.subscriptions.push(
    router.subscribeOutbound((env) => {
      const sender = kernel as unknown as {
        sendEnvelope?: (e: RtsV2Envelope<unknown>) => Promise<void>;
      };
      if (typeof sender.sendEnvelope === 'function') {
        void sender.sendEnvelope(env);
      }
    })
  );

  // For the real PTY client, plumb inbound Comm envelopes back through the
  // router. The stub kernel never opens a socket; it emits its
  // `notebook.metadata` directly via the router for testing (see below).
  if (kernel instanceof PtyKernelClient) {
    kernel.setCommSink({
      emit: (env) => router.route(env)
    });
    // Eagerly start so the ready handshake races the first cell execution.
    void kernel.start().catch((err) => {
      logger.error(`[llmnb] PtyKernelClient start failed: ${String(err)}`);
    });
  }

  // RFC-008 §3 — operator command to surface the kernel debug terminal.
  context.subscriptions.push(
    vscode.commands.registerCommand('llmnb.showKernelTerminal', () => {
      if (!(kernel instanceof PtyKernelClient)) {
        void vscode.window.showInformationMessage(
          'LLMNB: kernel terminal is only available with the production PtyKernelClient.'
        );
        return;
      }
      const term = new KernelTerminal(kernel, sessionId);
      term.attach();
      const terminal = vscode.window.createTerminal({
        name: `LLMKernel: ${sessionId}`,
        pty: term
      });
      terminal.show();
      context.subscriptions.push({
        dispose: () => {
          terminal.dispose();
          term.dispose();
        }
      });
    })
  );

  // Stage 5 S3: register the map-view command. RFC-006 Family B routes the
  // operator's drag-and-drop edits through the router's outbound queue.
  context.subscriptions.push(
    vscode.commands.registerCommand('llmnb.openMapView', () => {
      const panel = MapViewPanel.show(context.extensionUri, logger);
      // Forward layout.update / agent_graph.response from kernel to panel.
      const mapDisp = router.registerMapObserver({
        onLayoutUpdate: (payload) => panel.applyLayoutUpdate(payload),
        onAgentGraphResponse: (payload) => panel.applyAgentGraphResponse(payload)
      });
      // Wrap webview-emitted layout.edit payloads in RFC-006 envelopes.
      const editDisp = panel.onLayoutEdit((payload: LayoutEditPayload) => {
        router.enqueueOutbound({
          type: 'layout.edit',
          correlation_id: randomUuid(),
          payload
        });
      });
      // Tear the wiring down with the panel (the panel disposes itself when
      // the operator closes the tab).
      const linkDisposable = new vscode.Disposable(() => {
        mapDisp.dispose();
        editDisp.dispose();
      });
      context.subscriptions.push(linkDisposable);
    })
  );

  // Diagnostic capture for Tier 4 e2e tests. PtyKernelClient already
  // exposes onPtyData; we tee bytes into ptyByteRing. Frame capture
  // requires an additional hook below.
  if (E2E_VERBOSE && kernel instanceof PtyKernelClient) {
    kernel.onPtyData((bytes) => {
      pushRing(ptyByteRing, bytes);
    });
    if (typeof (kernel as unknown as { onFrame?: (cb: (frame: unknown) => void) => void }).onFrame === 'function') {
      (kernel as unknown as { onFrame: (cb: (frame: unknown) => void) => void }).onFrame((frame: unknown) => {
        pushRing(frameRing, frame);
      });
    }
  }

  return {
    getController: () => activeController,
    getRouter: () => activeRouter,
    getKernelClient: () => kernel,
    getMetadataApplier: () => activeApplier,
    getMetadataLoader: () => activeLoader,
    getHeartbeatConsumer: () => activeHeartbeat,
    getBlobResolver: () => activeBlobResolver,
    getSessionId: () => activeSessionId,
    getRecentPtyBytes: () => ptyByteRing.join(''),
    getRecentLogRecords: () => [...logRecordRing],
    getRecentFrames: () => [...frameRing]
  };
}

export function deactivate(): void {
  activeLogger?.info('[llmnb] deactivate');
  activeController?.dispose();
  activeApplier?.dispose();
  activeLoader?.dispose();
  activeHeartbeat?.dispose();
  // If the active kernel is a real PTY client, send the shutdown handshake
  // and clean up the PTY + socket. The stub has no resources to release.
  if (activeKernel instanceof PtyKernelClient) {
    void activeKernel.shutdown();
  }
  activeController = undefined;
  activeRouter = undefined;
  activeLogger = undefined;
  activeKernel = undefined;
  activeApplier = undefined;
  activeLoader = undefined;
  activeHeartbeat = undefined;
  activeBlobResolver = undefined;
  activeSessionId = undefined;
}

/** Load PtyKernelClient connection settings from VS Code configuration.
 *  See package.json `contributes.configuration.properties` for defaults. */
function loadKernelConfig(sessionId: string): PtyKernelConfig {
  const cfg = vscode.workspace.getConfiguration('llmnb.kernel');
  const raw = cfg.get<string>('pythonPath', 'python');
  return {
    sessionId,
    pythonPath: resolveConfigPath(raw)
  };
}

/** Substitute `${workspaceFolder}` (and `${env:NAME}`) in a config-string
 *  path. VS Code does not auto-resolve variables in arbitrary settings —
 *  only specific built-ins (e.g. `python.defaultInterpreterPath`). The
 *  Python extension and many others do this manually; we follow suit so
 *  the fixture workspace can use a portable `${workspaceFolder}/../...`
 *  reference for both F5 (Tier 5) and `@vscode/test-cli` (Tier 4). */
function resolveConfigPath(value: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return value
    .replace(/\$\{workspaceFolder\}/g, folder)
    .replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? '');
}

/** Public surface returned from activate(). The smoke test uses this to
 *  reach the controller and the kernel client without depending on
 *  internal modules. */
export interface ExtensionApi {
  getController(): LlmnbNotebookController | undefined;
  getRouter(): MessageRouter | undefined;
  getKernelClient(): KernelClient;
  getMetadataApplier(): NotebookMetadataApplier | undefined;
  getMetadataLoader(): MetadataLoader | undefined;
  getHeartbeatConsumer(): HeartbeatConsumer | undefined;
  getBlobResolver(): BlobResolver | undefined;
  getSessionId(): string | undefined;
  // Diagnostic surfaces — populated only when LLMNB_E2E_VERBOSE === '1'.
  // Tests subscribe to introspect what the extension actually saw when
  // a Tier 4 e2e run fails. See Testing.md §6.
  getRecentPtyBytes?(): string;
  getRecentLogRecords?(): unknown[];
  getRecentFrames?(): unknown[];
}

/**
 * Placeholder kernel client. Emits a fake open/close OTLP span pair for the
 * cell, optionally emits an `agent_emit` span for renderer testing, and
 * pushes a `notebook.metadata` snapshot through the router so the applier
 * has something to receive in offline / contract tests.
 *
 * I-X: switched to bare-OTLP emissions per RFC-006 §1 (no envelope), and
 * added the agent_emit + notebook.metadata test fixtures.
 */
export class StubKernelClient implements KernelClient {
  /** Run-MIME payloads emitted via the sink (kept for assertion in tests). */
  public lastPayloads: RunMimePayload[] = [];
  /** v2 envelopes the stub pretended to ship from the kernel side. */
  public lastInboundEnvelopes: RtsV2Envelope<unknown>[] = [];
  /** When true, also emit an `agent_emit` span for each cell. Default true
   *  so the renderer-host smoke surfaces the path. */
  public emitAgentEmit = true;
  /** When true, push one `notebook.metadata` snapshot per cell into the
   *  router so the applier exercises its accept path. Defaults true. */
  public emitNotebookMetadata = true;
  /** Monotonic snapshot version counter; persists across executions. */
  private snapshotVersion = 0;
  /** Reference to the active router. Set via setRouter(); the activate()
   *  flow injects it after construction. */
  private router: { route: (env: RtsV2Envelope<unknown>) => void } | undefined;

  public constructor(private readonly logger: vscode.LogOutputChannel) {}

  /** Allow the activation glue to inject the router so the stub can pretend
   *  to be the kernel side of the Comm channel. */
  public attachRouter(router: { route: (env: RtsV2Envelope<unknown>) => void }): void {
    this.router = router;
  }

  /** Outbound surface compatible with `PtyKernelClient.sendEnvelope`. The
   *  stub captures, then drops; the activation glue sees the same interface
   *  shape so the router's outbound subscriber works without a branch. */
  public async sendEnvelope(envelope: RtsV2Envelope<unknown>): Promise<void> {
    this.logger.debug(`[stub-kernel] sendEnvelope type=${envelope.type}`);
  }

  public async executeCell(input: KernelExecuteRequest, sink: KernelEventSink): Promise<void> {
    this.logger.info(`[stub-kernel] execute cell ${input.cellUri}`);
    const traceId = randomHex(32);
    const spanId = randomHex(16);
    const startNanos = nowUnixNanos();

    // RFC-006 §1: emit the open span (endTimeUnixNano: null).
    const openSpan: RunStartPayload = {
      traceId,
      spanId,
      name: 'stub.echo',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: startNanos,
      endTimeUnixNano: null,
      attributes: encodeAttrs({
        'llmnb.run_type': 'chain',
        'llmnb.agent_id': 'stub',
        'llmnb.cell_id': input.cellUri,
        'llmnb.tags': ['stub-kernel'],
        'input.value': JSON.stringify({ text: input.text }),
        'input.mime_type': 'application/json'
      }),
      status: { code: 'STATUS_CODE_UNSET', message: '' }
    };
    this.lastPayloads.push(openSpan);
    sink.emit(openSpan);

    // Optional `agent_emit` span for renderer testing — RFC-005 §"agent_emit
    // runs". Emitted as a self-contained closed span (open + close in one
    // shot to keep the test fixture simple).
    if (this.emitAgentEmit) {
      const emitSpanId = randomHex(16);
      const emitSpan: OtlpClosedSpan = {
        traceId,
        spanId: emitSpanId,
        parentSpanId: spanId,
        name: 'agent_emit:reasoning',
        kind: 'SPAN_KIND_INTERNAL',
        startTimeUnixNano: startNanos,
        endTimeUnixNano: nowUnixNanos(),
        attributes: encodeAttrs({
          'llmnb.run_type': 'agent_emit',
          'llmnb.agent_id': 'stub',
          'llmnb.emit_kind': 'reasoning',
          'llmnb.emit_content':
            'Stub kernel: simulated reasoning text for agent_emit renderer surface.'
        }),
        status: { code: 'STATUS_CODE_OK', message: '' }
      };
      this.lastPayloads.push(emitSpan);
      sink.emit(emitSpan);
    }

    // RFC-006 §1: emit the closed span.
    const endNanos = nowUnixNanos();
    const closedSpan: RunCompletePayload = {
      traceId,
      spanId,
      name: 'stub.echo',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: startNanos,
      endTimeUnixNano: endNanos,
      attributes: encodeAttrs({
        'llmnb.run_type': 'chain',
        'llmnb.agent_id': 'stub',
        'llmnb.cell_id': input.cellUri,
        'llmnb.tags': ['stub-kernel'],
        'input.value': JSON.stringify({ text: input.text }),
        'input.mime_type': 'application/json',
        'output.value': JSON.stringify({ acknowledged: true, echo: input.text }),
        'output.mime_type': 'application/json'
      }),
      status: { code: 'STATUS_CODE_OK', message: '' }
    };
    this.lastPayloads.push(closedSpan);
    sink.emit(closedSpan);

    // RFC-006 §8 Family F: emit a synthetic notebook.metadata snapshot so
    // the applier path exercises during offline/contract tests.
    if (this.emitNotebookMetadata && this.router) {
      this.snapshotVersion += 1;
      const env: RtsV2Envelope<NotebookMetadataPayload> = {
        type: 'notebook.metadata',
        payload: {
          mode: 'snapshot',
          snapshot_version: this.snapshotVersion,
          trigger: 'end_of_run',
          snapshot: {
            schema_version: '1.0.0',
            session_id: '00000000-0000-4000-8000-000000000000',
            event_log: { version: 1, runs: [closedSpan] }
          }
        }
      };
      this.lastInboundEnvelopes.push(env);
      try {
        this.router.route(env);
      } catch (err) {
        this.logger.warn(`[stub-kernel] notebook.metadata route threw: ${String(err)}`);
      }
    }
  }
}

/** Shape used internally for fully-formed (closed) test spans. */
type OtlpClosedSpan = RunCompletePayload;

function randomUuid(): string {
  // crypto.randomUUID is available in Node 20+ which is the engine pin.
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

function fallbackUuid(): string {
  // Conservative UUIDv4 fallback for environments without crypto.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** Random lowercase-hex string of `len` chars (OTLP spanId=16, traceId=32). */
function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Current Unix-nanos as a JSON string. Date.now() ms-resolution is fine
 *  for the stub kernel; the kernel-side LLMKernel will use real ns clocks. */
function nowUnixNanos(): string {
  return `${Date.now()}000000`;
}
