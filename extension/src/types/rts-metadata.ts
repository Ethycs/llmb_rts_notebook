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

import type { LayoutNode, AgentGraphResponsePayload } from '../messaging/types.js';

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

/** chapter 07 §"Chat flow JSON" — LangSmith-shaped run record stored in the
 *  event_log array. The cell-level flow lives separately in cell outputs. */
export interface RtsRunRecord {
  id: string;
  trace_id: string;
  parent_run_id: string | null;
  name: string;
  run_type: 'llm' | 'tool' | 'chain' | 'retriever' | 'agent' | 'embedding';
  start_time: string;
  end_time?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  events?: Array<{ event_type: string; data: Record<string, unknown>; timestamp: string }>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  error?: { kind?: string; message?: string; traceback?: string } | null;
}

/** chapter 07 §"One file: .llmnb" — cells[*].metadata.rts shape. */
export interface RtsCellMetadata {
  trace_id?: string;
  target_agent?: string;
  branch_marker?: string;
  /** Free-form extension. */
  [k: string]: unknown;
}
