// RFC-006 sample payloads — one per Comm `type`. Plus bare run-MIME
// payloads (Family A) per RFC-006 §1. Used by the router and renderer
// contract tests.
//
// I-X note on filename: this module historically held RFC-003 samples; with
// the v2 supersession (RFC-006) the contents migrated. The filename is kept
// stable to avoid churning import paths in tests; new tests import the same
// `RFC006_SAMPLES` constant exported below.
//
// Spec references:
//   RFC-006 §3        — thin Comm envelope `{type, payload, correlation_id?}`
//   RFC-006 §4–§8     — Family B (layout) / C (agent_graph) / D (operator action)
//                       / E (heartbeat) / F (notebook.metadata)
//   RFC-006 §1        — Family A bare OTLP/JSON payloads (no envelope)

import type {
  RtsV2MessageType,
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphQueryPayload,
  AgentGraphResponsePayload,
  OperatorActionPayload,
  HeartbeatKernelPayload,
  HeartbeatExtensionPayload,
  NotebookMetadataPayload,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../../src/messaging/types.js';
import { encodeAttrs } from '../../src/otel/attrs.js';

export interface RfcSample<P = unknown> {
  type: RtsV2MessageType;
  payload: P;
}

const SAMPLE_TRACE_ID = 'a'.repeat(32);
const SAMPLE_SPAN_ID = 'b'.repeat(16);

/** RFC-006 Comm envelope samples — one per `type`. */
export const RFC006_SAMPLES: Array<RfcSample> = [
  // RFC-006 §4
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
  // RFC-006 §5
  {
    type: 'agent_graph.query',
    payload: { query_type: 'full_snapshot' } satisfies AgentGraphQueryPayload
  },
  {
    type: 'agent_graph.response',
    payload: { nodes: [], edges: [] } satisfies AgentGraphResponsePayload
  },
  // RFC-006 §6 (drift_acknowledged is the v2-new action_type)
  {
    type: 'operator.action',
    payload: { action_type: 'cell_edit', parameters: {} } satisfies OperatorActionPayload
  },
  // RFC-006 §7
  {
    type: 'heartbeat.kernel',
    payload: { kernel_state: 'ok', uptime_seconds: 1 } satisfies HeartbeatKernelPayload
  },
  {
    type: 'heartbeat.extension',
    payload: { extension_state: 'ok' } satisfies HeartbeatExtensionPayload
  },
  // RFC-006 §8 (NEW family in v2)
  {
    type: 'notebook.metadata',
    payload: {
      mode: 'snapshot',
      snapshot_version: 1,
      trigger: 'end_of_run',
      snapshot: {
        schema_version: '1.0.0',
        session_id: '00000000-0000-4000-8000-000000000000',
        event_log: { version: 1, runs: [] }
      }
    } satisfies NotebookMetadataPayload
  }
];

/** Backwards-compat alias for older test imports. New tests should reference
 *  `RFC006_SAMPLES` directly. */
export const RFC003_SAMPLES = RFC006_SAMPLES;

// --- Family A bare-OTLP samples (RFC-006 §1) -------------------------------
//
// These are not Comm envelopes; they ride IOPub `display_data` /
// `update_display_data` MIME `application/vnd.rts.run+json` directly. The
// renderer + router routeRunMime path consume these.

/** Open span (`endTimeUnixNano: null`) — the "run.start" semantic. */
export const RUN_OPEN_SAMPLE: RunStartPayload = {
  traceId: SAMPLE_TRACE_ID,
  spanId: SAMPLE_SPAN_ID,
  name: 'echo',
  kind: 'SPAN_KIND_INTERNAL',
  startTimeUnixNano: '1745588938412000000',
  endTimeUnixNano: null,
  attributes: encodeAttrs({ 'llmnb.run_type': 'chain', 'llmnb.agent_id': 'alpha' }),
  status: { code: 'STATUS_CODE_UNSET', message: '' }
};

/** Partial event payload `{spanId, event}` — streamed update. */
export const RUN_EVENT_SAMPLE: RunEventPayload = {
  traceId: SAMPLE_TRACE_ID,
  spanId: SAMPLE_SPAN_ID,
  event: {
    timeUnixNano: '1745588938512000000',
    name: 'gen_ai.choice',
    attributes: encodeAttrs({ 'gen_ai.choice.delta': 'hi' })
  }
};

/** Closed span (terminal `endTimeUnixNano` + non-UNSET status). */
export const RUN_CLOSED_SAMPLE: RunCompletePayload = {
  traceId: SAMPLE_TRACE_ID,
  spanId: SAMPLE_SPAN_ID,
  name: 'echo',
  kind: 'SPAN_KIND_INTERNAL',
  startTimeUnixNano: '1745588938412000000',
  endTimeUnixNano: '1745588938612000000',
  attributes: encodeAttrs({ 'llmnb.run_type': 'chain', 'llmnb.agent_id': 'alpha' }),
  status: { code: 'STATUS_CODE_OK', message: '' }
};

/** RFC-005 §"agent_emit runs" — closed agent_emit span sample. */
export const AGENT_EMIT_SAMPLE: RunCompletePayload = {
  traceId: SAMPLE_TRACE_ID,
  spanId: 'c'.repeat(16),
  parentSpanId: SAMPLE_SPAN_ID,
  name: 'agent_emit:reasoning',
  kind: 'SPAN_KIND_INTERNAL',
  startTimeUnixNano: '1745588938302000000',
  endTimeUnixNano: '1745588938302000000',
  attributes: encodeAttrs({
    'llmnb.run_type': 'agent_emit',
    'llmnb.agent_id': 'alpha',
    'llmnb.emit_kind': 'reasoning',
    'llmnb.emit_content': 'Let me check the file structure before I propose any changes.'
  }),
  status: { code: 'STATUS_CODE_OK', message: '' }
};
