// RFC-003 message router — extension-side dispatcher.
//
// Per RFC-003 §Specification, every envelope crossing the kernel-extension
// boundary MUST be validated before dispatch. This router is the single
// point at which envelopes are accepted, validated, and routed to per-family
// handlers. V1 implements run.start/run.event/run.complete fully; the rest
// log a TODO(C2) marker and ignore (per the deferred-to-Round-2 plan in
// docs/dev-guide/06-vscode-notebook-substrate.md "The V1 chat shape").

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

/** Validates RFC-003 envelopes and dispatches to per-family handlers. */
export class MessageRouter {
  private readonly observers: RunLifecycleObserver[] = [];

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
        // TODO(C2): apply layout snapshot to the in-memory layout tree
        // and forward to the map-view webview.
        this.logger.debug(`[router] layout.update received (cid=${envelope.correlation_id})`);
        return;
      case 'layout.edit':
        // TODO(C2): forward operator-driven layout edits to kernel
        this.logger.debug(`[router] layout.edit received (cid=${envelope.correlation_id})`);
        return;
      case 'agent_graph.query':
        // TODO(C2): forward query to kernel; this direction is extension→kernel
        // so receiving it here is unusual.
        this.logger.debug(`[router] agent_graph.query received (cid=${envelope.correlation_id})`);
        return;
      case 'agent_graph.response':
        // TODO(C2): match against pending queries and resolve callbacks
        this.logger.debug(`[router] agent_graph.response received (cid=${envelope.correlation_id})`);
        return;
      case 'operator.action':
        // TODO(C2): operator action is extension→kernel; receiving here is unusual
        this.logger.debug(`[router] operator.action received (cid=${envelope.correlation_id})`);
        return;
      case 'heartbeat.kernel':
        // TODO(C2): reset kernel-liveness timer per RFC-003 F7
        this.logger.trace(`[router] heartbeat.kernel received (cid=${envelope.correlation_id})`);
        return;
      case 'heartbeat.extension':
        // TODO(C2): not normally inbound, but log for completeness
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
      if (!(field in env) || (env as Record<string, unknown>)[field] == null) {
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
    for (const obs of this.observers) {
      obs.onRunStart(env);
    }
  }
  private handleRunEvent(env: Rfc003Envelope<RunEventPayload>): void {
    for (const obs of this.observers) {
      obs.onRunEvent(env);
    }
  }
  private handleRunComplete(env: Rfc003Envelope<RunCompletePayload>): void {
    for (const obs of this.observers) {
      obs.onRunComplete(env);
    }
  }
}
