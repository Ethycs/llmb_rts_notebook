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
// Pattern adapted from
// vendor/vscode-jupyter/src/notebooks/controllers/controllerRegistration.ts
// where activation builds and disposes the controller graph.

import * as vscode from 'vscode';
import { MessageRouter } from './messaging/router.js';
import {
  LlmnbNotebookController,
  KernelClient,
  KernelExecuteRequest,
  KernelEventSink
} from './notebook/controller.js';
import { LlmnbNotebookSerializer } from './llmnb/serializer.js';
import {
  JupyterKernelClient,
  JupyterKernelConfig
} from './notebook/jupyter-kernel-client.js';
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

const NOTEBOOK_TYPE = 'llmnb';

let activeController: LlmnbNotebookController | undefined;
let activeRouter: MessageRouter | undefined;
let activeLogger: vscode.LogOutputChannel | undefined;
let activeKernel: KernelClient | undefined;
let activeApplier: NotebookMetadataApplier | undefined;

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const logger = vscode.window.createOutputChannel('LLMNB Extension', { log: true });
  context.subscriptions.push(logger);
  activeLogger = logger;
  logger.info('[llmnb] activate');

  const router = new MessageRouter(logger);
  activeRouter = router;

  // Track C R2 / I-X: the real JupyterKernelClient connects to LLMKernel over
  // Jupyter messaging at Comm target `llmnb.rts.v2`. The stub remains
  // available behind a config flag (`llmnb.kernel.useStub`) for offline
  // development and unit tests.
  const useStub = vscode.workspace
    .getConfiguration('llmnb')
    .get<boolean>('kernel.useStub', false);
  const kernel: KernelClient = useStub
    ? new StubKernelClient(logger)
    : new JupyterKernelClient(loadKernelConfig(), logger);
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

  // Wire the kernel client as the router's outbound subscriber so layout.edit
  // / agent_graph.query / operator.action envelopes ride the active Comm.
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

  // For the real Jupyter client, plumb inbound Comm envelopes back through
  // the router. The stub kernel never opens a Comm; it emits its
  // `notebook.metadata` directly via the router for testing (see below).
  if (kernel instanceof JupyterKernelClient) {
    kernel.setCommSink({
      emit: (env) => router.route(env)
    });
  }

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

  return {
    getController: () => activeController,
    getRouter: () => activeRouter,
    getKernelClient: () => kernel,
    getMetadataApplier: () => activeApplier
  };
}

export function deactivate(): void {
  activeLogger?.info('[llmnb] deactivate');
  activeController?.dispose();
  activeApplier?.dispose();
  // If the active kernel is a real Jupyter client, tear down its
  // KernelManager / connection. The stub has no resources to release.
  if (activeKernel instanceof JupyterKernelClient) {
    void activeKernel.disconnect();
  }
  activeController = undefined;
  activeRouter = undefined;
  activeLogger = undefined;
  activeKernel = undefined;
  activeApplier = undefined;
}

/** Load JupyterKernelClient connection settings from VS Code configuration.
 *  See package.json `contributes.configuration.properties` for defaults. */
function loadKernelConfig(): JupyterKernelConfig {
  const cfg = vscode.workspace.getConfiguration('llmnb.kernel');
  return {
    serverUrl: cfg.get<string>('serverUrl', 'http://127.0.0.1:8888'),
    token: cfg.get<string>('token', ''),
    kernelName: cfg.get<string>('kernelName', 'llm_kernel')
  };
}

/** Public surface returned from activate(). The smoke test uses this to
 *  reach the controller and the kernel client without depending on
 *  internal modules. */
export interface ExtensionApi {
  getController(): LlmnbNotebookController | undefined;
  getRouter(): MessageRouter | undefined;
  getKernelClient(): KernelClient;
  getMetadataApplier(): NotebookMetadataApplier | undefined;
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

  /** Outbound surface compatible with `JupyterKernelClient.sendEnvelope`. The
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
