// RFC-006 message router — extension-side dispatcher (v2 wire).
//
// Per RFC-006 §"Architecture: two carriers", the router handles the Comm
// channel only (Families B–F). Run-lifecycle (Family A) flows through the
// IOPub MIME `application/vnd.rts.run+json` directly to the controller via
// the kernel client; it never enters this router.
//
// Comm envelopes use the thin shape from RFC-006 §3:
//   { type, payload, correlation_id? }
// (no direction / timestamp / rfc_version).
//
// Failure-mode references throughout cite RFC-006 §"Failure modes" (W1–W11)
// and RFC-005 §"Failure modes" (F1–F16) where the wire crosses the persistence
// boundary (notebook.metadata).

import * as vscode from 'vscode';
import {
  RtsV2Envelope,
  RtsV2MessageType,
  RunMimePayload,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphQueryPayload,
  AgentGraphResponsePayload,
  OperatorActionPayload,
  HeartbeatKernelPayload,
  HeartbeatExtensionPayload,
  NotebookMetadataPayload,
  OtlpLogRecord
} from './types.js';

export {
  RtsV2Envelope,
  RunMimePayload,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphQueryPayload,
  AgentGraphResponsePayload,
  OperatorActionPayload,
  HeartbeatKernelPayload,
  HeartbeatExtensionPayload,
  NotebookMetadataPayload,
  OtlpLogRecord
};

/** Run-lifecycle observer surface. RFC-006 §1 carries OTLP spans (or a
 *  partial event-only payload) over IOPub MIME without an envelope; the
 *  controller registers itself here so it can stream cell outputs as the
 *  kernel client decodes IOPub. */
export interface RunLifecycleObserver {
  /** A new in-progress span was opened (`endTimeUnixNano: null`). */
  onRunStart(span: RunStartPayload): void;
  /** A streamed event landed against an existing span. */
  onRunEvent(payload: RunEventPayload): void;
  /** A span closed (terminal `endTimeUnixNano` + non-UNSET status). */
  onRunComplete(span: RunCompletePayload): void;
}

/** Layout / agent-graph observer surface (RFC-006 Family B + Family C).
 *  Receivers get the bare payload; the envelope's `correlation_id` (if any)
 *  is matched in the kernel client when it routes responses to queries. */
export interface MapViewObserver {
  onLayoutUpdate(payload: LayoutUpdatePayload): void;
  onAgentGraphResponse(payload: AgentGraphResponsePayload): void;
}

/** Family F (RFC-006 §8) consumer surface. The `metadata-applier` registers
 *  here; the router dispatches inbound `notebook.metadata` Comm envelopes
 *  to it. The applier handles RFC-005 schema-version validation, monotonicity
 *  checking, and `vscode.NotebookEdit.updateNotebookMetadata` application. */
export interface NotebookMetadataObserver {
  onNotebookMetadata(payload: NotebookMetadataPayload): void;
}

/** RFC-008 §6 — data-plane LogRecord consumer surface. The kernel ships
 *  `logging` output and agent stderr captures as OTLP/JSON LogRecord frames
 *  on the same socket as Spans and Comm envelopes; `PtyKernelClient` calls
 *  `routeLogRecord()` for each one and the router fan-outs to subscribers.
 *
 *  Default consumer: the extension's output channel (so dev tools surface
 *  them as a fallback). Future consumer: high-severity records → toasts. */
export interface LogRecordObserver {
  onLogRecord(record: OtlpLogRecord): void;
}

/** RFC-006 §7 v2.0.2 — `heartbeat.kernel` consumer surface. The kernel emits
 *  every 5s; the consumer updates the operator-facing kernel-state badge
 *  and resets the liveness watchdog. The watchdog itself lives in the
 *  consumer (HeartbeatLivenessWatchdog) — the router is a pure dispatcher. */
export interface HeartbeatKernelObserver {
  onHeartbeatKernel(payload: HeartbeatKernelPayload): void;
}

/** Outbound subscriber: ships every enqueued envelope onto the active
 *  `llmnb.rts.v2` Comm. The JupyterKernelClient registers a real sender;
 *  StubKernelClient registers a no-op. */
export type OutboundSubscriber = (envelope: RtsV2Envelope<unknown>) => void;

/** RFC-006-compliant message router. */
export class MessageRouter {
  private readonly runObservers: RunLifecycleObserver[] = [];
  private readonly mapObservers: MapViewObserver[] = [];
  private readonly metadataObservers: NotebookMetadataObserver[] = [];
  private readonly logRecordObservers: LogRecordObserver[] = [];
  private readonly heartbeatKernelObservers: HeartbeatKernelObserver[] = [];
  private readonly outboundSubscribers: OutboundSubscriber[] = [];

  public constructor(private readonly logger: vscode.LogOutputChannel) {}

  // --- observer registration ------------------------------------------------

  public registerRunObserver(observer: RunLifecycleObserver): vscode.Disposable {
    this.runObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.runObservers.indexOf(observer);
      if (idx >= 0) {
        this.runObservers.splice(idx, 1);
      }
    });
  }

  public registerMapObserver(observer: MapViewObserver): vscode.Disposable {
    this.mapObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.mapObservers.indexOf(observer);
      if (idx >= 0) {
        this.mapObservers.splice(idx, 1);
      }
    });
  }

  public registerMetadataObserver(observer: NotebookMetadataObserver): vscode.Disposable {
    this.metadataObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.metadataObservers.indexOf(observer);
      if (idx >= 0) {
        this.metadataObservers.splice(idx, 1);
      }
    });
  }

  /** RFC-008 §6 — register a consumer for OTLP/JSON LogRecord frames lifted
   *  off the data-plane socket. Multiple subscribers may register
   *  independently; the router fan-outs in registration order. */
  public registerLogRecordObserver(observer: LogRecordObserver): vscode.Disposable {
    this.logRecordObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.logRecordObservers.indexOf(observer);
      if (idx >= 0) {
        this.logRecordObservers.splice(idx, 1);
      }
    });
  }

  /** Convenience handler-based variant; mirrors the I-X observer registration
   *  style requested in RFC-008 §"§4 New observer". The returned Disposable
   *  unhooks the handler. */
  public registerLogRecordHandler(
    handler: (record: OtlpLogRecord) => void
  ): vscode.Disposable {
    return this.registerLogRecordObserver({ onLogRecord: handler });
  }

  /** RFC-006 §7 v2.0.2 — register a `heartbeat.kernel` consumer. Multiple
   *  subscribers may register independently (status-bar + watchdog +
   *  diagnostics); the router fan-outs in registration order. */
  public registerHeartbeatKernelObserver(
    observer: HeartbeatKernelObserver
  ): vscode.Disposable {
    this.heartbeatKernelObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.heartbeatKernelObservers.indexOf(observer);
      if (idx >= 0) {
        this.heartbeatKernelObservers.splice(idx, 1);
      }
    });
  }

  public subscribeOutbound(subscriber: OutboundSubscriber): vscode.Disposable {
    this.outboundSubscribers.push(subscriber);
    return new vscode.Disposable(() => {
      const idx = this.outboundSubscribers.indexOf(subscriber);
      if (idx >= 0) {
        this.outboundSubscribers.splice(idx, 1);
      }
    });
  }

  // --- inbound dispatch -----------------------------------------------------

  /** Comm entry point: validate then dispatch by `type`. RFC-006 §3 + §"Failure
   *  modes" W4 (unknown type → log+discard) and W5 (missing fields → log+discard). */
  public route(envelope: RtsV2Envelope<unknown>): void {
    if (!this.validateEnvelope(envelope)) {
      return;
    }
    switch (envelope.type) {
      case 'layout.update':
        for (const obs of this.mapObservers) {
          obs.onLayoutUpdate((envelope as RtsV2Envelope<LayoutUpdatePayload>).payload);
        }
        return;
      case 'agent_graph.response':
        for (const obs of this.mapObservers) {
          obs.onAgentGraphResponse(
            (envelope as RtsV2Envelope<AgentGraphResponsePayload>).payload
          );
        }
        return;
      case 'notebook.metadata':
        for (const obs of this.metadataObservers) {
          obs.onNotebookMetadata(
            (envelope as RtsV2Envelope<NotebookMetadataPayload>).payload
          );
        }
        return;
      case 'layout.edit':
      case 'agent_graph.query':
      case 'operator.action':
      case 'heartbeat.extension':
      case 'kernel.shutdown_request':
        // These are extension→kernel; reaching this branch normally means a
        // producer used `route()` instead of `enqueueOutbound()`. Forward.
        this.enqueueOutbound(envelope);
        return;
      case 'heartbeat.kernel':
        // RFC-006 §7 v2.0.2 — kernel→extension liveness. Dispatch to every
        // registered HeartbeatKernelObserver (status badge updater +
        // liveness watchdog).
        for (const obs of this.heartbeatKernelObservers) {
          try {
            obs.onHeartbeatKernel(
              (envelope as RtsV2Envelope<HeartbeatKernelPayload>).payload
            );
          } catch (err) {
            this.logger.error(`[router] heartbeat.kernel observer threw: ${String(err)}`);
          }
        }
        this.logger.trace(`[router] heartbeat.kernel received (cid=${envelope.correlation_id ?? '-'})`);
        return;
      default: {
        const unknown: RtsV2MessageType = envelope.type;
        // RFC-006 W4: log-and-discard on unknown type.
        this.logger.error(`[router] unknown comm type: ${String(unknown)}`);
        return;
      }
    }
  }

  /** IOPub run-MIME entry point. The kernel client decodes `display_data` /
   *  `update_display_data` into one of three shapes per RFC-006 §1:
   *
   *   - full OtlpSpan with `endTimeUnixNano: null`     → onRunStart
   *   - full OtlpSpan with terminal `endTimeUnixNano`  → onRunComplete
   *   - `{spanId, event}` partial event payload        → onRunEvent
   *
   *  Receivers MUST treat each emission as the authoritative current state
   *  (last writer wins) per RFC-006 §1 "State machine."
   *
   *  The router's job here is purely classification + dispatch; the OTLP
   *  payload is forwarded verbatim. */
  public routeRunMime(payload: RunMimePayload): void {
    if (!payload || typeof payload !== 'object') {
      this.logger.error('[router] routeRunMime: payload is not an object');
      return;
    }
    // Partial event shape: {spanId, event}
    if ('event' in payload && (payload as RunEventPayload).event) {
      for (const obs of this.runObservers) {
        obs.onRunEvent(payload as RunEventPayload);
      }
      return;
    }
    // Otherwise expect an OtlpSpan.
    const span = payload as RunStartPayload;
    if (typeof span.spanId !== 'string' || span.spanId.length === 0) {
      this.logger.warn('[router] routeRunMime: span missing spanId');
      return;
    }
    if (span.endTimeUnixNano && span.endTimeUnixNano.length > 0) {
      for (const obs of this.runObservers) {
        obs.onRunComplete(span);
      }
    } else {
      for (const obs of this.runObservers) {
        obs.onRunStart(span);
      }
    }
  }

  /** RFC-008 §6 — entry point for LogRecord frames lifted off the data-plane
   *  socket. The PtyKernelClient calls this once per parsed frame. The router
   *  fan-outs to every registered LogRecordObserver. Producers that emit a
   *  malformed record (missing `timeUnixNano` or `severityNumber`) are
   *  filtered out at the kernel-client framer; this method is permissive and
   *  forwards whatever it receives. */
  public routeLogRecord(record: OtlpLogRecord): void {
    if (!record || typeof record !== 'object') {
      this.logger.error('[router] routeLogRecord: record is not an object');
      return;
    }
    for (const obs of this.logRecordObservers) {
      try {
        obs.onLogRecord(record);
      } catch (err) {
        this.logger.error(`[router] log-record observer threw: ${String(err)}`);
      }
    }
  }

  // --- outbound -------------------------------------------------------------

  /** Push an envelope toward the kernel. V1 is fire-and-forget; the kernel
   *  echoes a `layout.update` on success (RFC-006 §4) — failure surfaces are
   *  the kernel's responsibility. */
  public enqueueOutbound(envelope: RtsV2Envelope<unknown>): void {
    if (this.outboundSubscribers.length === 0) {
      this.logger.warn(
        `[router] outbound dropped (no subscriber): type=${envelope.type} cid=${envelope.correlation_id ?? '-'}`
      );
      return;
    }
    for (const sub of this.outboundSubscribers) {
      try {
        sub(envelope);
      } catch (err) {
        this.logger.error(`[router] outbound subscriber threw: ${String(err)}`);
      }
    }
  }

  // --- validation -----------------------------------------------------------

  /** RFC-006 §3 + W5: reject envelopes missing `type` / `payload`. */
  private validateEnvelope(env: RtsV2Envelope<unknown>): boolean {
    if (!env || typeof env !== 'object') {
      this.logger.error('[router] envelope is not an object');
      return false;
    }
    if (typeof env.type !== 'string' || env.type.length === 0) {
      this.logger.error('[router] envelope missing required field: type');
      return false;
    }
    if (env.payload === undefined || env.payload === null) {
      this.logger.error('[router] envelope missing required field: payload');
      return false;
    }
    return true;
  }
}
