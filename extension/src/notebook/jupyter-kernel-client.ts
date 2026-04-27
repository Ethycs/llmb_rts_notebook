// Real Jupyter kernel client for LLMKernel (Track C R2).
//
// Replaces the StubKernelClient. Speaks Jupyter messaging via
// @jupyterlab/services and decodes RFC-003 envelopes from two carriers:
//   1. Run lifecycle → display_data / update_display_data with
//      application/vnd.rts.run+json (re-wrapped) or
//      application/vnd.rts.envelope+json (verbatim).
//   2. Other RFC-003 families → Jupyter Comm at target "llmnb.rts.v1";
//      each comm_msg.content.data is a full RFC-003 envelope.
//
// Patterns adapted from:
//   vendor/vscode-jupyter/src/kernels/jupyter/session/jupyterLabHelper.ts
//     (KernelManager / ServerConnection.makeSettings)
//   vendor/vscode-jupyter/src/kernels/jupyter/session/jupyterSession.ts
//     (requestExecute + IFuture iopub plumbing)
//   vendor/vscode-jupyter/src/kernels/kernel.ts:833 (registerCommTarget)

import * as vscode from 'vscode';
import { KernelManager, ServerConnection } from '@jupyterlab/services';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import type {
  KernelClient,
  KernelExecuteRequest,
  KernelEventSink
} from './controller.js';
import {
  Rfc003Envelope,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  RFC003_VERSION
} from '../messaging/types.js';

/** RFC-003 — Jupyter Comm target name for non-run-lifecycle envelopes. */
export const RTS_COMM_TARGET = 'llmnb.rts.v1';
export const RTS_RUN_MIME = 'application/vnd.rts.run+json';
export const RTS_ENVELOPE_MIME = 'application/vnd.rts.envelope+json';

/** Connection inputs; loaded from VS Code config in extension.ts. */
export interface JupyterKernelConfig {
  serverUrl: string;
  token?: string;
  kernelName: string;
}

/** Real Jupyter messaging client. Single-threaded (TypeScript), so the
 *  internal connect() guard is just a Promise cache — no locks needed. */
export class JupyterKernelClient implements KernelClient {
  private manager: KernelManager | undefined;
  private kernel: Kernel.IKernelConnection | undefined;
  private connecting: Promise<void> | undefined;
  /** V1 has at most one inflight cell, so a single sink reference is enough.
   *  Multi-cell parallelism is TODO(C2). */
  private activeCommSink: KernelEventSink | undefined;
  /** RTS comm channel used by sendEnvelope() to ship outbound envelopes
   *  (Stage 5 S3). Opened on first use. */
  private rtsComm: Kernel.IComm | undefined;

  public constructor(
    private readonly config: JupyterKernelConfig,
    private readonly logger: vscode.LogOutputChannel
  ) {}

  public async connect(): Promise<void> {
    if (this.kernel) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  public async disconnect(): Promise<void> {
    // V1: leave the kernel itself running so multiple notebooks can attach.
    try {
      this.kernel?.dispose();
      this.manager?.dispose();
    } catch (err) {
      this.logger.warn(`[jupyter-kernel] dispose threw: ${String(err)}`);
    }
    this.kernel = undefined;
    this.manager = undefined;
  }

  public async executeCell(
    input: KernelExecuteRequest,
    sink: KernelEventSink
  ): Promise<void> {
    if (!this.kernel) {
      await this.connect();
    }
    const kernel = this.kernel;
    if (!kernel) {
      throw new Error('[jupyter-kernel] kernel connection not available');
    }
    this.activeCommSink = sink;
    const future = kernel.requestExecute({
      code: input.text,
      silent: false,
      stop_on_error: false,
      allow_stdin: false,
      store_history: true
    });
    future.onIOPub = (msg: KernelMessage.IIOPubMessage): void => {
      this.handleIOPub(msg, sink, input);
    };
    try {
      const reply = await future.done;
      if (reply && reply.content.status === 'error') {
        // Pattern adapted from jupyterSession.ts: shell reply errors yield
        // a synthetic run.complete even when no error iopub arrived.
        sink.emit(
          this.syntheticRunCompleteForError(
            input,
            reply.content as KernelMessage.IReplyErrorContent
          )
        );
      }
    } finally {
      future.dispose();
    }
  }

  /** Stage 5 S3: ship an RFC-003 envelope toward the kernel via the
   *  `llmnb.rts.v1` Comm. Used by the router's outbound subscription to
   *  carry layout.edit / agent_graph.query / operator.action envelopes.
   *  Lazily opens the comm on first call; subsequent calls reuse it. */
  public async sendEnvelope(envelope: Rfc003Envelope<unknown>): Promise<void> {
    if (!this.kernel) {
      await this.connect();
    }
    const kernel = this.kernel;
    if (!kernel) {
      this.logger.warn('[jupyter-kernel] sendEnvelope: no kernel connection');
      return;
    }
    if (!this.rtsComm) {
      this.rtsComm = kernel.createComm(RTS_COMM_TARGET);
      this.rtsComm.open();
    }
    // Rfc003Envelope is structurally JSON-shaped, but the JSONValue type
    // from @lumino/coreutils does not accept `unknown`-keyed records
    // without a widening cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.rtsComm.send(envelope as any);
  }

  // --- internals -----------------------------------------------------------

  private async doConnect(): Promise<void> {
    const serverSettings = ServerConnection.makeSettings({
      baseUrl: this.config.serverUrl,
      wsUrl: deriveWsUrl(this.config.serverUrl),
      token: this.config.token ?? '',
      appendToken: !!this.config.token
    });
    const manager = new KernelManager({ serverSettings });
    await manager.ready;

    // Reuse a kernel of the requested name if one is running; otherwise
    // start a fresh one. V1 keeps the kernel running across notebooks.
    let kernel: Kernel.IKernelConnection | undefined;
    for (const model of manager.running()) {
      if (model.name === this.config.kernelName) {
        kernel = manager.connectTo({ model });
        this.logger.info(`[jupyter-kernel] reusing kernel id=${model.id}`);
        break;
      }
    }
    if (!kernel) {
      kernel = await manager.startNew({ name: this.config.kernelName });
      this.logger.info(`[jupyter-kernel] started kernel id=${kernel.id}`);
    }

    // Register the RTS comm target so kernel-initiated comm_opens land in
    // our envelope sink. Pattern adapted from
    // vendor/vscode-jupyter/src/kernels/kernel.ts:833.
    kernel.registerCommTarget(RTS_COMM_TARGET, (comm, _openMsg) => {
      comm.onMsg = (msg: KernelMessage.ICommMsgMsg): void => {
        const data = msg.content.data as unknown;
        if (this.activeCommSink && isObject(data)) {
          this.activeCommSink.emit(data as unknown as Rfc003Envelope<unknown>);
        } else {
          this.logger.debug('[jupyter-kernel] comm_msg dropped (no sink)');
        }
      };
    });

    this.manager = manager;
    this.kernel = kernel;
  }

  private handleIOPub(
    msg: KernelMessage.IIOPubMessage,
    sink: KernelEventSink,
    input: KernelExecuteRequest
  ): void {
    const msgType = msg.header.msg_type;
    if (msgType === 'display_data' || msgType === 'update_display_data') {
      const content = msg.content as KernelMessage.IDisplayDataMsg['content'];
      const bundle = content.data as Record<string, unknown>;
      const verbatim = bundle[RTS_ENVELOPE_MIME];
      if (isObject(verbatim)) {
        sink.emit(verbatim as unknown as Rfc003Envelope<unknown>);
        return;
      }
      const runPayload = bundle[RTS_RUN_MIME];
      if (isObject(runPayload)) {
        const env = this.envelopeFromRunMime(runPayload, msgType);
        if (env) {
          sink.emit(env);
        }
        return;
      }
      this.logger.debug(
        `[jupyter-kernel] ignoring ${msgType} mimes=${Object.keys(bundle).join(',')}`
      );
      return;
    }
    if (msgType === 'error') {
      const content = msg.content as KernelMessage.IErrorMsg['content'];
      sink.emit(
        this.syntheticRunCompleteForError(input, {
          status: 'error',
          ename: content.ename,
          evalue: content.evalue,
          traceback: content.traceback,
          execution_count: 0
        } as KernelMessage.IReplyErrorContent)
      );
      return;
    }
    // status / execute_input / stream / clear_output / etc. — V1 ignores.
    this.logger.debug(`[jupyter-kernel] iopub ${msgType} (cell=${input.cellUri})`);
  }

  /** Build an RFC-003 envelope from a bare run-record MIME payload. */
  private envelopeFromRunMime(
    payload: Record<string, unknown>,
    msgType: 'display_data' | 'update_display_data'
  ): Rfc003Envelope<unknown> | undefined {
    const cid = stringField(payload, 'id') ?? stringField(payload, 'run_id');
    if (!cid) {
      this.logger.warn('[jupyter-kernel] run-mime missing id/run_id');
      return undefined;
    }
    const base = {
      direction: 'kernel→extension' as const,
      correlation_id: cid,
      timestamp: new Date().toISOString(),
      rfc_version: RFC003_VERSION
    };
    if (msgType === 'display_data') {
      return {
        ...base,
        message_type: 'run.start' as const,
        payload: payload as unknown as RunStartPayload
      };
    }
    if ('status' in payload) {
      return {
        ...base,
        message_type: 'run.complete' as const,
        payload: payload as unknown as RunCompletePayload
      };
    }
    if ('event_type' in payload) {
      return {
        ...base,
        message_type: 'run.event' as const,
        payload: payload as unknown as RunEventPayload
      };
    }
    this.logger.warn('[jupyter-kernel] update_display_data missing status/event_type');
    return undefined;
  }

  private syntheticRunCompleteForError(
    input: KernelExecuteRequest,
    err: KernelMessage.IReplyErrorContent
  ): Rfc003Envelope<RunCompletePayload> {
    const now = new Date().toISOString();
    return {
      message_type: 'run.complete',
      direction: 'kernel→extension',
      correlation_id: input.cellUri,
      timestamp: now,
      rfc_version: RFC003_VERSION,
      payload: {
        run_id: input.cellUri,
        end_time: now,
        outputs: {},
        error: {
          kind: err.ename,
          message: err.evalue,
          traceback: Array.isArray(err.traceback) ? err.traceback.join('\n') : ''
        },
        status: 'error'
      }
    };
  }
}

// --- helpers ---------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function stringField(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' ? v : undefined;
}

function deriveWsUrl(httpUrl: string): string {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  } catch {
    return httpUrl.replace(/^http/, 'ws');
  }
}
