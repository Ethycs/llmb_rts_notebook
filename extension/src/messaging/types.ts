// RFC-006 kernel↔extension wire format (v2) — TypeScript types.
//
// Per RFC-006 §"Architecture: two carriers", the wire splits into:
//
//   1. Family A (run lifecycle): OTLP/JSON spans over Jupyter
//      `display_data` / `update_display_data`. NO envelope at this layer;
//      the OTLP span is self-describing. The extension consumes the bare
//      `application/vnd.rts.run+json` MIME payload directly.
//
//   2. Families B–F (layout, agent_graph, operator action, heartbeat,
//      notebook.metadata): a thin Comm envelope `{type, payload,
//      correlation_id?}` over Jupyter Comm at target `llmnb.rts.v2`.
//      Direction / timestamp / rfc_version are dropped (sender identity
//      gives direction, payloads carry their own time fields, the major
//      version is encoded in the Comm target name).
//
// RFC-006 supersedes RFC-003 v1; this module dropped the v1 envelope shape
// in I-X. Producers that emit v1 envelopes are non-conformant; the router
// logs and discards them at the boundary.
//
// The OTLP-shaped run payloads (Family A) live in `extension/src/otel/attrs.ts`.

import type { OtlpSpan, OtlpSpanEvent } from '../otel/attrs.js';

// ===== Family A — Run lifecycle (OTLP/JSON over IOPub) ======================
//
// Per RFC-006 §1, run-lifecycle traffic carries one OTLP span (or a partial
// per-event payload during streaming) directly as the `application/vnd.rts.run+json`
// MIME value. There is no envelope; the IOPub message itself plus the OTLP
// span content is the contract.

/** Family A — `run.start` semantics: an in-progress OTLP span
 *  (`endTimeUnixNano: null`, `status.code: STATUS_CODE_UNSET`).
 *
 *  Note: this is now just an alias for OtlpSpan; "run.start" is no longer a
 *  message_type, but the term is preserved here for code clarity. */
export type RunStartPayload = OtlpSpan;

/** Family A — partial event payload emitted during streaming.
 *
 *  RFC-006 §1 leaves the choice of "re-emit the full span vs. ship only the
 *  new event" to the producer; the kernel's RunTracker (vendor/LLMKernel
 *  llm_kernel/run_tracker.py) emits the partial form `{spanId, event}`,
 *  optionally with `traceId`. The receiver tolerates both: this payload, or
 *  a full OtlpSpan with new events appended. */
export interface RunEventPayload {
  /** 32 hex chars; matches the parent span's traceId. Optional because
   *  current kernels (e.g. LLMKernel's RunTracker) elide it; the spanId is
   *  the canonical routing key (== Jupyter `display_id`). */
  traceId?: string;
  /** 16 hex chars; matches the parent span's spanId. */
  spanId: string;
  /** OTLP-shaped event. */
  event: OtlpSpanEvent;
}

/** Family A — `run.complete` semantics: a closed OTLP span (terminal
 *  `endTimeUnixNano` and a non-UNSET `status.code`). */
export type RunCompletePayload = OtlpSpan;

/** Discriminator for the bare run-MIME payload: full span vs. partial event. */
export type RunMimePayload = OtlpSpan | RunEventPayload;

// ===== OTLP/JSON LogRecord (RFC-008 §6 — data-plane Frame B) ===============
//
// LogRecord frames flow over the data-plane socket alongside Spans (Family A)
// and RFC-006 Comm envelopes. They carry the kernel's `logging` output and
// agent stderr captures, OTLP-shaped, per RFC-008 §7. Receivers identify a
// LogRecord by the presence of `timeUnixNano` AND `severityNumber` at the
// top level of the parsed JSON object (RFC-008 §6).
//
// Severity follows the OTel SeverityNumber convention:
//   1..4   TRACE
//   5..8   DEBUG
//   9..12  INFO
//   13..16 WARN
//   17..20 ERROR
//   21..24 FATAL

export interface OtlpLogRecord {
  /** Unix-nanos as a JSON string. */
  timeUnixNano: string;
  /** OTel SeverityNumber (1..24). */
  severityNumber: number;
  /** Optional human-readable severity (`INFO`, `WARN`, ...). */
  severityText?: string;
  /** Body is an OTLP AnyValue; in practice the kernel sends `{stringValue}`. */
  body?: { stringValue?: string; [k: string]: unknown };
  /** OTLP/JSON `attributes` list; RFC-008 §7 fills logger.name / code.* keys. */
  attributes?: Array<{ key: string; value: { [k: string]: unknown } }>;
  /** OTel `observedTimeUnixNano` is present in the kernel's emission. */
  observedTimeUnixNano?: string;
  /** Permissive escape-hatch: future producers may add keys. */
  [extra: string]: unknown;
}

// ===== Comm envelope (RFC-006 §3) ==========================================

/** RFC-006 §4–§9 + RFC-008 §4 — every Comm message type the V1 wire carries.
 *  `kernel.shutdown_request` is added by RFC-008 §4 for the clean-shutdown
 *  handshake (extension→kernel; the kernel responds with a final snapshot
 *  + `kernel.shutting_down` LogRecord on the data plane). */
export type RtsV2MessageType =
  | 'layout.update'
  | 'layout.edit'
  | 'agent_graph.query'
  | 'agent_graph.response'
  | 'operator.action'
  | 'heartbeat.kernel'
  | 'heartbeat.extension'
  | 'notebook.metadata'
  | 'kernel.shutdown_request';

/** RFC-006 §3 — thin Comm envelope. */
export interface RtsV2Envelope<P = unknown> {
  type: RtsV2MessageType;
  payload: P;
  correlation_id?: string;
}

// ----- Family B: layout ----------------------------------------------------

export interface LayoutUpdatePayload {
  snapshot_version: number;
  tree: LayoutNode;
}

export interface LayoutNode {
  id: string;
  type: 'workspace' | 'zone' | 'file' | 'agent' | 'viewpoint' | 'annotation';
  render_hints?: Record<string, unknown>;
  children: LayoutNode[];
}

export interface LayoutEditPayload {
  operation: 'add_zone' | 'remove_node' | 'move_node' | 'rename_node' | 'update_render_hints';
  parameters: {
    node_id?: string;
    new_parent_id?: string;
    new_name?: string;
    render_hints?: Record<string, unknown>;
    node_spec?: Record<string, unknown>;
  };
}

// ----- Family C: agent graph -----------------------------------------------

export interface AgentGraphQueryPayload {
  query_type: 'neighbors' | 'paths' | 'subgraph' | 'full_snapshot';
  node_id?: string;
  target_node_id?: string;
  hops?: number;
  edge_filters?: AgentGraphEdgeKind[];
}

export type AgentGraphEdgeKind =
  | 'spawned'
  | 'in_zone'
  | 'has_tool'
  | 'connects_to'
  | 'supervises'
  | 'collaborates_with'
  | 'has_capability'
  | 'configured_with';

export interface AgentGraphResponsePayload {
  nodes: Array<{
    id: string;
    type: 'agent' | 'zone' | 'mcp_server' | 'tool' | 'operator' | 'file';
    properties?: Record<string, unknown>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: AgentGraphEdgeKind;
    properties?: Record<string, unknown>;
  }>;
  truncated?: boolean;
}

// ----- Family D: operator action -------------------------------------------

/** RFC-006 §6 — `operator.action`. `drift_acknowledged` is added in v2 (the
 *  operator confirmed a drift event from RFC-005's drift log).
 *
 *  BSP-005 S9 adds `agent_interrupt` — a mid-flight SIGINT against an active
 *  agent, distinct from the clean-shutdown `agent_stop`. The kernel routes
 *  `agent_interrupt` to `AgentSupervisor.interrupt(agent_id)` which signals
 *  the agent's process. See atoms/operations/stop-agent.md for the
 *  stop/interrupt distinction. */
export type OperatorActionType =
  | 'cell_edit'
  | 'branch_switch'
  | 'zone_select'
  | 'approval_response'
  | 'dismiss_notification'
  | 'drift_acknowledged'
  | 'agent_interrupt'
  // PLAN-S5.0.1 §3.10/§3.11 — operator-only intents added by S5.0.1d.
  // `reset_contamination` is the explicit clear path for the per-cell
  // contamination flag (the only path that flips it false; see §3.10
  // "Contaminated-cell freeze" and the K3F refusal contract).
  | 'reset_contamination';

export interface OperatorActionPayload {
  action_type: OperatorActionType;
  parameters: Record<string, unknown>;
  originating_cell_id?: string;
}

// ----- Family E: heartbeat / liveness --------------------------------------

export interface HeartbeatKernelPayload {
  kernel_state: 'ok' | 'degraded' | 'starting' | 'shutting_down';
  uptime_seconds: number;
  last_run_timestamp?: string | null;
}

export interface HeartbeatExtensionPayload {
  extension_state: 'ok' | 'degraded' | 'starting' | 'shutting_down';
  active_notebook_id?: string | null;
  focused_cell_id?: string | null;
}

// ----- Family F: notebook.metadata (NEW in RFC-006) ------------------------
//
// Per RFC-006 §8 + RFC-005 §"Persistence strategy": the kernel ships
// `metadata.rts` snapshots over this family; the extension applies them to
// the open notebook document via `vscode.NotebookEdit.updateNotebookMetadata`
// and lets VS Code's normal save flow persist.

/** RFC-005 §"Top-level structure" — the `metadata.rts` namespace. The shape
 *  is intentionally permissive (`Record<string, unknown>` for substructures)
 *  because RFC-005 governs the schema; this RFC's typing only enforces the
 *  outer envelope. The applier validates `schema_version` at the boundary. */
export interface RtsMetadataSnapshot {
  schema_version: string;
  schema_uri?: string;
  session_id?: string;
  created_at?: string;
  layout?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  config?: Record<string, unknown>;
  event_log?: Record<string, unknown>;
  blobs?: Record<string, unknown>;
  drift_log?: unknown[];
  /** Permissive escape-hatch: future RFC-005 minor versions may add keys. */
  [extra: string]: unknown;
}

/** RFC-006 §8 (v2.0.2 amended) — `notebook.metadata` payload. V1 senders
 *  MUST NOT emit `"patch"` (V1.5+). The extension SENDS `"hydrate"` on
 *  file-open and EXPECTS a `"snapshot"` confirmation with
 *  `trigger: "hydrate_complete"` within 10s.
 *
 *  Triggers:
 *   - `save | shutdown | timer | end_of_run` — kernel-emitted runtime cadence.
 *   - `open` — extension-emitted when shipping `mode: "hydrate"` on file open.
 *   - `hydrate_complete` — kernel-emitted as confirmation after processing
 *     a hydrate envelope.
 */
export interface NotebookMetadataPayload {
  mode: 'snapshot' | 'patch' | 'hydrate';
  snapshot_version: number;
  snapshot?: RtsMetadataSnapshot;
  patch?: Array<Record<string, unknown>>; // RFC 6902 ops (V1.5+)
  trigger?:
    | 'save'
    | 'shutdown'
    | 'timer'
    | 'end_of_run'
    | 'open'
    | 'hydrate_complete'
    | string;
}

// ===== Cross-cutting =======================================================

/** Discriminated union of every kernel→extension Comm envelope. */
export type AnyInboundCommEnvelope =
  | RtsV2Envelope<LayoutUpdatePayload>
  | RtsV2Envelope<AgentGraphResponsePayload>
  | RtsV2Envelope<HeartbeatKernelPayload>
  | RtsV2Envelope<NotebookMetadataPayload>;

/** Discriminated union of every extension→kernel Comm envelope. */
export type AnyOutboundCommEnvelope =
  | RtsV2Envelope<LayoutEditPayload>
  | RtsV2Envelope<AgentGraphQueryPayload>
  | RtsV2Envelope<OperatorActionPayload>
  | RtsV2Envelope<HeartbeatExtensionPayload>;

/** Comm target name. RFC-006 §2: the major version is part of the name so a
 *  v3 kernel and a v2 extension fail to open a Comm together — and the
 *  failure IS the upgrade prompt. */
export const RTS_COMM_TARGET_V2 = 'llmnb.rts.v2';

/** Currently-supported wire major.minor.patch (RFC-006). */
export const RFC006_VERSION = '2.0.0';

/** RFC-005 schema major we accept on `notebook.metadata` snapshots. */
export const RFC005_SCHEMA_MAJOR = '1';
