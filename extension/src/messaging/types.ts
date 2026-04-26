// RFC-003 Custom Jupyter message format — TypeScript types
//
// One TypeScript interface per payload schema in
// docs/rfcs/RFC-003-custom-message-format.md. The envelope is generic over
// the payload type so receivers can dispatch on `message_type` and obtain a
// statically-typed payload via the per-family unions below.

/** RFC-003 envelope direction enum. */
export type Rfc003Direction = 'kernel→extension' | 'extension→kernel';

/** RFC-003 §Specification — every message_type the envelope enum permits. */
export type Rfc003MessageType =
  | 'run.start'
  | 'run.event'
  | 'run.complete'
  | 'layout.update'
  | 'layout.edit'
  | 'agent_graph.query'
  | 'agent_graph.response'
  | 'operator.action'
  | 'heartbeat.kernel'
  | 'heartbeat.extension';

/** RFC-003 §Envelope schema — universal envelope wrapping every payload. */
export interface Rfc003Envelope<P = unknown> {
  message_type: Rfc003MessageType;
  direction: Rfc003Direction;
  correlation_id: string;
  timestamp: string;
  rfc_version: string;
  payload: P;
}

// --- Family A: run lifecycle ----------------------------------------------

/** RFC-003 §Family A — run.start payload. */
export interface RunStartPayload {
  id: string;
  trace_id: string;
  parent_run_id: string | null;
  name: string;
  run_type: 'llm' | 'tool' | 'chain' | 'retriever' | 'agent' | 'embedding';
  start_time: string;
  inputs: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** RFC-003 §Family A — run.event payload. */
export interface RunEventPayload {
  run_id: string;
  event_type: 'token' | 'tool_call' | 'tool_result' | 'log' | 'error';
  data: Record<string, unknown>;
  timestamp: string;
}

/** RFC-003 §Family A — run.complete payload. */
export interface RunCompletePayload {
  run_id: string;
  end_time: string;
  outputs: Record<string, unknown>;
  error?: { kind?: string; message?: string; traceback?: string } | null;
  status: 'success' | 'error' | 'timeout';
}

// --- Family B: layout ------------------------------------------------------

/** RFC-003 §Family B — layout.update payload. */
export interface LayoutUpdatePayload {
  snapshot_version: number;
  tree: LayoutNode;
}

/** RFC-003 §Family B — layout tree node (recursive). */
export interface LayoutNode {
  id: string;
  type: 'workspace' | 'zone' | 'file' | 'agent' | 'viewpoint' | 'annotation';
  render_hints?: Record<string, unknown>;
  children: LayoutNode[];
}

/** RFC-003 §Family B — layout.edit payload. */
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

// --- Family C: agent graph -------------------------------------------------

/** RFC-003 §Family C — agent_graph.query payload. */
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

/** RFC-003 §Family C — agent_graph.response payload. */
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

// --- Family D: operator action --------------------------------------------

/** RFC-003 §Family D — operator.action payload. */
export interface OperatorActionPayload {
  action_type: 'cell_edit' | 'branch_switch' | 'zone_select' | 'approval_response' | 'dismiss_notification';
  parameters: Record<string, unknown>;
  originating_cell_id?: string;
}

// --- Family E: heartbeat / liveness ---------------------------------------

/** RFC-003 §Family E — heartbeat.kernel payload. */
export interface HeartbeatKernelPayload {
  kernel_state: 'ok' | 'degraded' | 'starting' | 'shutting_down';
  uptime_seconds: number;
  last_run_timestamp?: string | null;
}

/** RFC-003 §Family E — heartbeat.extension payload. */
export interface HeartbeatExtensionPayload {
  extension_state: 'ok' | 'degraded' | 'starting' | 'shutting_down';
  active_notebook_id?: string | null;
  focused_cell_id?: string | null;
}

/** Discriminated union over all RFC-003 envelopes (sender-shape). */
export type AnyRfc003Envelope =
  | Rfc003Envelope<RunStartPayload>
  | Rfc003Envelope<RunEventPayload>
  | Rfc003Envelope<RunCompletePayload>
  | Rfc003Envelope<LayoutUpdatePayload>
  | Rfc003Envelope<LayoutEditPayload>
  | Rfc003Envelope<AgentGraphQueryPayload>
  | Rfc003Envelope<AgentGraphResponsePayload>
  | Rfc003Envelope<OperatorActionPayload>
  | Rfc003Envelope<HeartbeatKernelPayload>
  | Rfc003Envelope<HeartbeatExtensionPayload>;

/** RFC-003 currently-supported major.minor.patch. */
export const RFC003_VERSION = '1.0.0';
