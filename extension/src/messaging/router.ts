// RFC-003 message router — extension-side dispatcher.
//
// Per RFC-003 §Specification, every envelope is validated then dispatched.
// V1 implements Family A (run.*) plus Family B (layout.*) and Family C
// (agent_graph.*) (Stage 5 S3). Family E heartbeats remain V1.5.

import * as vscode from 'vscode';
import {
  Rfc003Envelope,
  Rfc003MessageType,
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
  RFC003_VERSION
} from './types.js';

export {
  Rfc003Envelope,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphQueryPayload,
  AgentGraphResponsePayload,
  OperatorActionPayload,
  HeartbeatKernelPayload,
  HeartbeatExtensionPayload
};

/** Run-lifecycle observer surface. The controller registers itself here so
 *  it can stream cell outputs as run events arrive from the kernel. */
export interface RunLifecycleObserver {
  onRunStart(envelope: Rfc003Envelope<RunStartPayload>): void;
  onRunEvent(envelope: Rfc003Envelope<RunEventPayload>): void;
  onRunComplete(envelope: Rfc003Envelope<RunCompletePayload>): void;
}

/** Layout / agent-graph observer surface (RFC-003 Family B + Family C).
 *  The MapViewPanel registers itself here when `show()` is called so the
 *  router can forward inbound snapshots and graph responses. */
export interface MapViewObserver {
  onLayoutUpdate(envelope: Rfc003Envelope<LayoutUpdatePayload>): void;
  onAgentGraphResponse(envelope: Rfc003Envelope<AgentGraphResponsePayload>): void;
}

/** Outbound subscriber: the JupyterKernelClient registers a callback that
 *  ships every enqueued envelope onto the active `llmnb.rts.v1` Comm.
 *  StubKernelClient registers a no-op. */
export type OutboundSubscriber = (envelope: Rfc003Envelope<unknown>) => void;

/** Validates RFC-003 envelopes and dispatches to per-family handlers. */
export class MessageRouter {
  private readonly observers: RunLifecycleObserver[] = [];
  private readonly mapObservers: MapViewObserver[] = [];
  private readonly outboundSubscribers: OutboundSubscriber[] = [];

  public constructor(private readonly logger: vscode.LogOutputChannel) {}

  public registerRunObserver(observer: RunLifecycleObserver): vscode.Disposable {
    this.observers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.observers.indexOf(observer);
      if (idx >= 0) {
        this.observers.splice(idx, 1);
      }
    });
  }

  /** Register a map-view observer (Family B + Family C inbound). Returns a
   *  disposable; the panel's dispose() callback releases it. */
  public registerMapObserver(observer: MapViewObserver): vscode.Disposable {
    this.mapObservers.push(observer);
    return new vscode.Disposable(() => {
      const idx = this.mapObservers.indexOf(observer);
      if (idx >= 0) {
        this.mapObservers.splice(idx, 1);
      }
    });
  }

  /** Subscribe to outbound envelopes (extension→kernel). The kernel client
   *  uses this to drain `enqueueOutbound()` calls onto the active Comm. */
  public subscribeOutbound(subscriber: OutboundSubscriber): vscode.Disposable {
    this.outboundSubscribers.push(subscriber);
    return new vscode.Disposable(() => {
      const idx = this.outboundSubscribers.indexOf(subscriber);
      if (idx >= 0) {
        this.outboundSubscribers.splice(idx, 1);
      }
    });
  }

  /** Push an envelope toward the kernel. V1 contract is fire-and-forget; the
   *  kernel echoes a `layout.update` on success (RFC-003 F11 covers reject). */
  public enqueueOutbound(envelope: Rfc003Envelope<unknown>): void {
    if (this.outboundSubscribers.length === 0) {
      this.logger.warn(
        `[router] outbound dropped (no subscriber): type=${envelope.message_type} cid=${envelope.correlation_id}`
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

  /** Entry point. Validates, then dispatches by message_type. F1/F10 from
   *  the RFC-003 failure-mode table are enforced here. */
  public route(envelope: Rfc003Envelope<unknown>): void {
    if (!this.validateEnvelope(envelope)) {
      return;
    }

    switch (envelope.message_type) {
      case 'run.start':
        this.handleRunStart(envelope as Rfc003Envelope<RunStartPayload>);
        return;
      case 'run.event':
        this.handleRunEvent(envelope as Rfc003Envelope<RunEventPayload>);
        return;
      case 'run.complete':
        this.handleRunComplete(envelope as Rfc003Envelope<RunCompletePayload>);
        return;
      case 'layout.update':
        // RFC-003 §Family B kernel→extension: forward to map observers.
        for (const obs of this.mapObservers) {
          obs.onLayoutUpdate(envelope as Rfc003Envelope<LayoutUpdatePayload>);
        }
        return;
      case 'agent_graph.response':
        // RFC-003 §Family C kernel→extension: forward to map observers.
        for (const obs of this.mapObservers) {
          obs.onAgentGraphResponse(
            envelope as Rfc003Envelope<AgentGraphResponsePayload>
          );
        }
        return;
      case 'layout.edit':
      case 'agent_graph.query':
      case 'operator.action':
        // RFC-003 §Family B/C/D extension→kernel: route onto the outbound
        // queue so the kernel client ships it via the Comm. Reaching this
        // branch normally means the producer used `route()` instead of
        // `enqueueOutbound()`; both end up in the same place.
        this.enqueueOutbound(envelope);
        return;
      case 'heartbeat.kernel':
        // TODO(V1.5): reset kernel-liveness timer per RFC-003 F7.
        this.logger.trace(`[router] heartbeat.kernel received (cid=${envelope.correlation_id})`);
        return;
      case 'heartbeat.extension':
        // TODO(V1.5): not normally inbound; log for completeness.
        this.logger.trace(`[router] heartbeat.extension received (cid=${envelope.correlation_id})`);
        return;
      default: {
        const unknown: Rfc003MessageType = envelope.message_type;
        // RFC-003 F2: V1 fail-closed on unknown message_type
        this.logger.error(`[router] unknown message_type: ${String(unknown)}`);
        return;
      }
    }
  }

  /** RFC-003 F1 + F10: reject envelopes missing required fields or
   *  bearing a foreign major version. */
  private validateEnvelope(env: Rfc003Envelope<unknown>): boolean {
    if (!env || typeof env !== 'object') {
      this.logger.error('[router] envelope is not an object');
      return false;
    }
    const required: Array<keyof Rfc003Envelope> = [
      'message_type',
      'direction',
      'correlation_id',
      'timestamp',
      'rfc_version',
      'payload'
    ];
    for (const field of required) {
      if (!(field in env) || (env as unknown as Record<string, unknown>)[field] == null) {
        this.logger.error(`[router] envelope missing required field: ${String(field)}`);
        return false;
      }
    }
    const ourMajor = RFC003_VERSION.split('.')[0];
    const theirMajor = String(env.rfc_version).split('.')[0];
    if (ourMajor !== theirMajor) {
      // RFC-003 F10: major-version mismatch; reject and log once per peer.
      this.logger.error(`[router] rfc_version major mismatch: ours=${ourMajor} theirs=${theirMajor}`);
      return false;
    }
    return true;
  }

  private handleRunStart(env: Rfc003Envelope<RunStartPayload>): void {
    for (const obs of this.observers) { obs.onRunStart(env); }
  }
  private handleRunEvent(env: Rfc003Envelope<RunEventPayload>): void {
    for (const obs of this.observers) { obs.onRunEvent(env); }
  }
  private handleRunComplete(env: Rfc003Envelope<RunCompletePayload>): void {
    for (const obs of this.observers) { obs.onRunComplete(env); }
  }
}
