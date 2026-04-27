// llmb RTS Notebook — V1 extension entry point.
//
// Per DR-0009 (chapter 06) the cell paradigm is kept and the Jupyter
// kernel process is dropped: cells dispatch through a NotebookController
// callback that lives inside the extension host. This module wires
// activation: serializer + controller + RFC-003 message router. The
// MIME renderer for application/vnd.rts.run+json is registered by the
// notebookRenderer contribution in package.json (see renderers/run-renderer.ts).
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
  Rfc003Envelope,
  RunStartPayload,
  RunCompletePayload,
  LayoutEditPayload,
  RFC003_VERSION
} from './messaging/types.js';
import { MapViewPanel } from './webviews/map-view-panel.js';

const NOTEBOOK_TYPE = 'llmnb';

let activeController: LlmnbNotebookController | undefined;
let activeRouter: MessageRouter | undefined;
let activeLogger: vscode.LogOutputChannel | undefined;
let activeKernel: KernelClient | undefined;

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const logger = vscode.window.createOutputChannel('LLMNB Extension', { log: true });
  context.subscriptions.push(logger);
  activeLogger = logger;
  logger.info('[llmnb] activate');

  const router = new MessageRouter(logger);
  activeRouter = router;

  // Track C R2: the real JupyterKernelClient connects to LLMKernel over
  // standard Jupyter messaging. The stub remains available behind a config
  // flag (`llmnb.kernel.useStub`) for offline development and unit tests.
  const useStub = vscode.workspace
    .getConfiguration('llmnb')
    .get<boolean>('kernel.useStub', false);
  const kernel: KernelClient = useStub
    ? new StubKernelClient(logger)
    : new JupyterKernelClient(loadKernelConfig(), logger);
  activeKernel = kernel;

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

  // Wire the kernel client as the router's outbound subscriber so layout.edit
  // / agent_graph.query / operator.action envelopes ride the active Comm.
  // Stub kernels accept (and silently swallow) outbound traffic; that's the
  // intended offline-development behaviour.
  context.subscriptions.push(
    router.subscribeOutbound((env) => {
      const sender = kernel as unknown as {
        sendEnvelope?: (e: Rfc003Envelope<unknown>) => Promise<void>;
      };
      if (typeof sender.sendEnvelope === 'function') {
        void sender.sendEnvelope(env);
      }
    })
  );

  // Stage 5 S3: register the map-view command. RFC-003 §Family B routes the
  // operator's drag-and-drop edits through the router's outbound queue.
  context.subscriptions.push(
    vscode.commands.registerCommand('llmnb.openMapView', () => {
      const panel = MapViewPanel.show(context.extensionUri, logger);
      // Forward layout.update / agent_graph.response from kernel to panel.
      const mapDisp = router.registerMapObserver({
        onLayoutUpdate: (env) => panel.applyLayoutUpdate(env.payload),
        onAgentGraphResponse: (env) => panel.applyAgentGraphResponse(env.payload)
      });
      // Wrap webview-emitted layout.edit payloads in RFC-003 envelopes.
      const editDisp = panel.onLayoutEdit((payload: LayoutEditPayload) => {
        router.enqueueOutbound({
          message_type: 'layout.edit',
          direction: 'extension→kernel',
          correlation_id: randomUuid(),
          timestamp: new Date().toISOString(),
          rfc_version: RFC003_VERSION,
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
    getKernelClient: () => kernel
  };
}

export function deactivate(): void {
  activeLogger?.info('[llmnb] deactivate');
  activeController?.dispose();
  // If the active kernel is a real Jupyter client, tear down its
  // KernelManager / connection. The stub has no resources to release.
  if (activeKernel instanceof JupyterKernelClient) {
    void activeKernel.disconnect();
  }
  activeController = undefined;
  activeRouter = undefined;
  activeLogger = undefined;
  activeKernel = undefined;
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
}

/**
 * Placeholder kernel client that emits a fake run.start / run.complete pair.
 *
 * TODO(C2): swap for the real JupyterKernelClient once Track B3 lands a
 * Python-side LLMKernel that speaks the RFC-003 envelopes over Jupyter
 * messaging. The real client will:
 *  - serialize RFC-003 envelopes onto Jupyter `comm_msg` / `display_data`,
 *  - validate inbound envelopes against the schemas in messaging/types.ts,
 *  - propagate kernel-side correlation_ids back through the controller.
 */
export class StubKernelClient implements KernelClient {
  public lastEnvelopes: Array<Rfc003Envelope<unknown>> = [];

  public constructor(private readonly logger: vscode.LogOutputChannel) {}

  public async executeCell(input: KernelExecuteRequest, sink: KernelEventSink): Promise<void> {
    this.logger.info(`[stub-kernel] execute cell ${input.cellUri}`);
    const correlationId = randomUuid();
    const startedAt = new Date().toISOString();

    const startEnv: Rfc003Envelope<RunStartPayload> = {
      message_type: 'run.start',
      direction: 'kernel→extension',
      correlation_id: correlationId,
      timestamp: startedAt,
      rfc_version: RFC003_VERSION,
      payload: {
        id: correlationId,
        trace_id: correlationId,
        parent_run_id: null,
        name: 'stub.echo',
        run_type: 'chain',
        start_time: startedAt,
        inputs: { text: input.text },
        tags: ['stub-kernel'],
        metadata: { cell_uri: input.cellUri }
      }
    };
    this.lastEnvelopes.push(startEnv);
    sink.emit(startEnv);

    const completeEnv: Rfc003Envelope<RunCompletePayload> = {
      message_type: 'run.complete',
      direction: 'kernel→extension',
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
      rfc_version: RFC003_VERSION,
      payload: {
        run_id: correlationId,
        end_time: new Date().toISOString(),
        outputs: { acknowledged: true, echo: input.text },
        error: null,
        status: 'success'
      }
    };
    this.lastEnvelopes.push(completeEnv);
    sink.emit(completeEnv);
  }
}

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
