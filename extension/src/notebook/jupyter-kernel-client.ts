// Real Jupyter kernel client for LLMKernel (Track C R2; updated for RFC-006).
//
// Speaks Jupyter messaging via @jupyterlab/services and decodes the v2 wire:
//
//   1. Run lifecycle (RFC-006 §1) → IOPub `display_data` /
//      `update_display_data` carrying ONE MIME `application/vnd.rts.run+json`
//      whose value is the bare OTLP/JSON span (or `{spanId, event}` partial
//      event). NO ENVELOPE wrapping. The client forwards the bare payload to
//      the controller's KernelEventSink; the router's routeRunMime classifier
//      decides open vs. event vs. close.
//
//   2. Other RFC-006 families → Jupyter Comm at target `llmnb.rts.v2`. Each
//      `comm_msg.content.data` is a thin envelope `{type, payload,
//      correlation_id?}` per RFC-006 §3.
//
// Transition tolerance (RFC-006 §"Conformance during transition" + W10):
// during the v2.0.x window producers MAY also emit
// `application/vnd.rts.envelope+json` alongside the OTLP MIME. Consumers MUST
// dispatch on the OTLP MIME and ignore the envelope MIME if both are present.
// This client logs the dual-emission once per session at debug level.
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
  RtsV2Envelope,
  RunMimePayload,
  RunCompletePayload,
  RTS_COMM_TARGET_V2
} from '../messaging/types.js';
import { encodeAttrs } from '../otel/attrs.js';
import type { OtlpSpan } from '../otel/attrs.js';

/** RFC-006 §2 — Jupyter Comm target name (v2). */
export const RTS_COMM_TARGET = RTS_COMM_TARGET_V2;
/** RFC-006 §1 — primary IOPub MIME for run records. */
export const RTS_RUN_MIME = 'application/vnd.rts.run+json';
/** Deprecated dual-emission MIME (RFC-006 transition tolerance, removed at v2.1). */
export const RTS_ENVELOPE_MIME_DEPRECATED = 'application/vnd.rts.envelope+json';

/** Connection inputs; loaded from VS Code config in extension.ts. */
export interface JupyterKernelConfig {
  serverUrl: string;
  token?: string;
  kernelName: string;
}

/** Inbound Comm sink used by the router-side glue: the kernel client forwards
 *  decoded thin envelopes here so the router can dispatch by `type`. */
export interface CommEnvelopeSink {
  emit(envelope: RtsV2Envelope<unknown>): void;
}

/** Real Jupyter messaging client. Single-threaded (TypeScript), so the
 *  internal connect() guard is just a Promise cache — no locks needed. */
export class JupyterKernelClient implements KernelClient {
  private manager: KernelManager | undefined;
  private kernel: Kernel.IKernelConnection | undefined;
  private connecting: Promise<void> | undefined;
  /** V1 has at most one inflight cell, so a single sink reference is enough.
   *  Multi-cell parallelism is TODO(C2). */
  private activeRunSink: KernelEventSink | undefined;
  /** Inbound Comm forwarder. Set once via `setCommSink()`; the same sink
   *  receives every Comm message regardless of which cell is running. */
  private commSink: CommEnvelopeSink | undefined;
  /** RTS comm channel used by sendEnvelope() to ship outbound envelopes.
   *  Opened on first use. */
  private rtsComm: Kernel.IComm | undefined;
  /** Logged once per session when a producer emits both MIMEs (W10). */
  private dualMimeWarned = false;

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

  /** Register the inbound Comm sink. The router subscribes here so that
   *  every Comm message reaches `MessageRouter.route()`. */
  public setCommSink(sink: CommEnvelopeSink): void {
    this.commSink = sink;
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
    this.activeRunSink = sink;
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
        // jupyterSession.ts pattern: shell reply errors yield a synthetic
        // terminal span even when no error iopub arrived.
        sink.emit(
          this.syntheticErrorSpan(
            input,
            reply.content as KernelMessage.IReplyErrorContent
          )
        );
      }
    } finally {
      future.dispose();
    }
  }

  /** Ship an RFC-006 v2 envelope toward the kernel via the `llmnb.rts.v2`
   *  Comm. Used by the router's outbound subscription. Lazily opens the
   *  comm on first call; subsequent calls reuse it. */
  public async sendEnvelope(envelope: RtsV2Envelope<unknown>): Promise<void> {
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
    // The thin envelope is JSON-shaped; @lumino/coreutils' JSONValue type
    // does not accept `unknown`-keyed records without a widening cast.
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

    // RFC-006 §2: register the v2 Comm target. A v3 kernel registers
    // `llmnb.rts.v3` and would NOT reach this branch — that's the
    // major-version handshake.
    kernel.registerCommTarget(RTS_COMM_TARGET, (comm, _openMsg) => {
      comm.onMsg = (msg: KernelMessage.ICommMsgMsg): void => {
        const data = msg.content.data as unknown;
        if (this.commSink && isObject(data)) {
          this.commSink.emit(data as unknown as RtsV2Envelope<unknown>);
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
      const runPayload = bundle[RTS_RUN_MIME];
      const dual = bundle[RTS_ENVELOPE_MIME_DEPRECATED];
      // RFC-006 transition tolerance: prefer OTLP MIME, ignore the deprecated
      // envelope MIME if both are present (W10). Log once per session.
      if (dual && !this.dualMimeWarned) {
        this.dualMimeWarned = true;
        this.logger.debug(
          `[jupyter-kernel] producer emitted both ${RTS_RUN_MIME} and the deprecated ${RTS_ENVELOPE_MIME_DEPRECATED} MIME; ignoring the latter (RFC-006 W10)`
        );
      }
      if (isObject(runPayload)) {
        sink.emit(runPayload as unknown as RunMimePayload);
        return;
      }
      // No OTLP MIME present and the envelope MIME alone is not a v2-conformant
      // emission. Log and drop per W2 / W4.
      this.logger.debug(
        `[jupyter-kernel] ignoring ${msgType} (no ${RTS_RUN_MIME}); mimes=${Object.keys(bundle).join(',')}`
      );
      return;
    }
    if (msgType === 'error') {
      const content = msg.content as KernelMessage.IErrorMsg['content'];
      sink.emit(
        this.syntheticErrorSpan(input, {
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

  /** Build a synthetic terminal OTLP span when the shell reply reports an
   *  error but no OTLP span was emitted. The kernel didn't supply a real
   *  spanId here, so we deterministically derive one from the cell URI. */
  private syntheticErrorSpan(
    input: KernelExecuteRequest,
    err: KernelMessage.IReplyErrorContent
  ): RunCompletePayload {
    const traceback = Array.isArray(err.traceback) ? err.traceback.join('\n') : '';
    const span: OtlpSpan = {
      traceId: hex32FromString(input.cellUri),
      spanId: hex16FromString(input.cellUri),
      name: 'cell.execute',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: nowUnixNanos(),
      endTimeUnixNano: nowUnixNanos(),
      attributes: encodeAttrs({
        'llmnb.run_type': 'chain',
        'llmnb.cell_id': input.cellUri,
        'exception.type': err.ename,
        'exception.message': err.evalue,
        'exception.stacktrace': traceback
      }),
      status: { code: 'STATUS_CODE_ERROR', message: err.evalue }
    };
    return span;
  }
}

// --- helpers ---------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

/** Current Unix-nanos as a JSON string. */
function nowUnixNanos(): string {
  return `${Date.now()}000000`;
}

/** Deterministic 32-hex-char id from an arbitrary string. Used only for the
 *  synthetic terminal span on shell error, where the kernel did not supply
 *  an OTLP span id; falls back to hashing the cell uri so the synthetic span
 *  remains identifiable across retries. */
function hex32FromString(s: string): string {
  // FNV-1a 32-bit, then hex-pad to 32 chars by repeating + xor.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const seed = h.toString(16).padStart(8, '0');
  // 32 hex = 4 * 8-hex blocks; rotate to avoid 4 identical groups.
  return (
    seed +
    seed.split('').reverse().join('') +
    seed +
    seed.split('').reverse().join('')
  ).slice(0, 32);
}

function hex16FromString(s: string): string {
  return hex32FromString(s).slice(0, 16);
}
