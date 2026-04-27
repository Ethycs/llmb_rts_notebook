// TypeScript shapes for the metadata.rts namespace inside .llmnb files.
//
// All shapes derive from chapter 07 of the dev guide
// (docs/dev-guide/07-subtractive-fork-and-storage.md), specifically the
// "Storage structures (DR-0014)" section. Three structures embed in one
// file: layout tree, agent state graph, chat flow. The full event log
// also lives under metadata.rts for replay; cell-level chat flow lives
// in cells[*].outputs[*] as MIME-typed displays and is NOT typed here.
//
// Cell-specific hints (trace id, target agent, branch markers) live in
// cells[*].metadata.rts and are typed by `RtsCellMetadata` below.
//
// Refactor R1-X: the persistent run-record form is the merged OTLP/JSON
// span. RtsRunRecord aliases OtlpSpan; cell-level OTLP traceId hints in
// cells[*].metadata.rts use the same hex-string encoding.

import type { LayoutNode, AgentGraphResponsePayload } from '../messaging/types.js';
import type { OtlpSpan } from '../otel/attrs.js';

/** chapter 07 §"One file: .llmnb" — top-level metadata.rts namespace. */
export interface RtsNotebookMetadata {
  layout?: RtsLayoutMetadata;
  agents?: RtsAgentGraphMetadata;
  config?: RtsConfigMetadata;
  event_log?: RtsRunRecord[];
  /** Free-form for forward compatibility; receivers MUST preserve unknown keys. */
  [extension: string]: unknown;
}

/** chapter 07 §"Layout tree" — the layout-tree storage structure. */
export interface RtsLayoutMetadata {
  snapshot_version: number;
  tree: LayoutNode;
}

/** chapter 07 §"Agent state graph" — the agent-graph storage structure. */
export interface RtsAgentGraphMetadata extends AgentGraphResponsePayload {
  /** Optional signature to detect cross-file ID drift. */
  graph_version?: number;
}

/** chapter 07 §"LLMKernel as sole kernel" + DR-0012 — per-notebook config. */
export interface RtsConfigMetadata {
  rfc_version: string;
  kernel_id?: string;
  zone_defaults?: Record<string, unknown>;
  /** Free-form configuration extension. */
  [k: string]: unknown;
}

/** chapter 07 §"Chat flow JSON" — strict OTLP/JSON span persisted in the
 *  event_log array. One merged span per run. The cell-level flow lives
 *  separately in cell outputs (also as RFC-003 envelopes carrying spans). */
export type RtsRunRecord = OtlpSpan;

/** chapter 07 §"One file: .llmnb" — cells[*].metadata.rts shape. */
export interface RtsCellMetadata {
  /** OTLP traceId hint (32 lowercase hex chars) for cells that pin to a run. */
  traceId?: string;
  target_agent?: string;
  branch_marker?: string;
  /** Free-form extension. */
  [k: string]: unknown;
}
