// RFC-003 sample payloads — one per message_type. Used by the router and
// (eventually) renderer contract tests. Splitting them out keeps the test
// files under the 200-line cap stipulated by Track T1.
//
// Spec reference: RFC-003 §Specification (10 message_types) and the
// per-family payload schemas in §Family A through §Family E.

import type {
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
  HeartbeatExtensionPayload
} from '../../src/messaging/types.js';

export interface RfcSample<P = unknown> {
  type: Rfc003MessageType;
  payload: P;
}

export const RFC003_SAMPLES: Array<RfcSample> = [
  // RFC-003 §Family A
  {
    type: 'run.start',
    payload: {
      id: 'r1',
      trace_id: 'r1',
      parent_run_id: null,
      name: 'echo',
      run_type: 'chain',
      start_time: '2026-04-26T00:00:00.000Z',
      inputs: {}
    } satisfies RunStartPayload
  },
  {
    type: 'run.event',
    payload: {
      run_id: 'r1',
      event_type: 'token',
      data: { delta: 'hi' },
      timestamp: '2026-04-26T00:00:00.000Z'
    } satisfies RunEventPayload
  },
  {
    type: 'run.complete',
    payload: {
      run_id: 'r1',
      end_time: '2026-04-26T00:00:00.000Z',
      outputs: {},
      status: 'success'
    } satisfies RunCompletePayload
  },
  // RFC-003 §Family B
  {
    type: 'layout.update',
    payload: {
      snapshot_version: 1,
      tree: { id: 'root', type: 'workspace', children: [] }
    } satisfies LayoutUpdatePayload
  },
  {
    type: 'layout.edit',
    payload: { operation: 'add_zone', parameters: {} } satisfies LayoutEditPayload
  },
  // RFC-003 §Family C
  {
    type: 'agent_graph.query',
    payload: { query_type: 'full_snapshot' } satisfies AgentGraphQueryPayload
  },
  {
    type: 'agent_graph.response',
    payload: { nodes: [], edges: [] } satisfies AgentGraphResponsePayload
  },
  // RFC-003 §Family D
  {
    type: 'operator.action',
    payload: { action_type: 'cell_edit', parameters: {} } satisfies OperatorActionPayload
  },
  // RFC-003 §Family E
  {
    type: 'heartbeat.kernel',
    payload: { kernel_state: 'ok', uptime_seconds: 1 } satisfies HeartbeatKernelPayload
  },
  {
    type: 'heartbeat.extension',
    payload: { extension_state: 'ok' } satisfies HeartbeatExtensionPayload
  }
];
