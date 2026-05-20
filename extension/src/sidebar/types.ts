// PLAN-S7 — Internal type definitions for the sidebar TreeDataProviders.
//
// These types are extension-internal (no public API surface). The
// providers consume `metadata.rts` shapes the kernel writes
// (metadata_writer.py / overlay_applier.py); the relevant atoms are
// listed in PLAN-S7 §4.

import * as vscode from 'vscode';

/** Raw `metadata.rts` snapshot shape we read from notebook documents.
 *  Mirrors the kernel-side writer; fields are optional because we tolerate
 *  partial / legacy snapshots without crashing the sidebar. */
export interface RtsSnapshot {
  schema_version?: string;
  zone?: RtsZone;
  layout?: RtsLayout;
  blobs?: Record<string, unknown>;
}

export interface RtsZone {
  zone_id?: string;
  agents?: Record<string, RawAgent>;
  sections?: Record<string, RawSection>;
  event_log?: RawEventLogEntry[];
  event_log_archive?: RawEventLogEntry[];
  run_frames?: Record<string, RawRunFrame>;
}

export interface RawAgent {
  turns?: RawTurnRecord[];
  session?: RawAgentSession;
}

export interface RawTurnRecord {
  id?: string;
  parent_id?: string | null;
  agent_id?: string;
  cell_id?: string;
  claude_session_id?: string;
  role?: string;
  body?: string;
  created_at?: string;
  provider?: string;
}

/** Per agent.md (atom §Schema). The kernel writes a subset; unknown
 *  fields are preserved verbatim. */
export interface RawAgentSession {
  head_turn_id?: string;
  last_seen_turn_id?: string;
  claude_session_id?: string;
  /** `terminated` accepted per metadata_writer.py:1758 (atom enum updated). */
  runtime_status?: 'alive' | 'idle' | 'exited' | 'terminated' | string;
  pid?: number | null;
  fork_case?: 'A' | 'B';
}

export interface RawSection {
  id?: string;
  title?: string;
  parent_section_id?: string | null;
  cell_range?: string[];
  status?: 'open' | 'in_progress' | 'complete' | 'frozen' | string;
  collapsed?: boolean;
  summary?: string | null;
  flow_policy?: unknown;
}

/** Per run-frame atom. V1 minimal RunFrame fields. */
export interface RawRunFrame {
  run_id?: string;
  cell_id?: string;
  executor_id?: string;
  turn_head_before?: string;
  turn_head_after?: string;
  context_manifest_id?: string;
  status?: string;
  started_at?: string;
  ended_at?: string | null;
}

/** Discriminated union of `zone.event_log[*]` entries — legacy pre-S6.0
 *  `agent_ref_move` records vs post-S6.0 captured envelopes (per
 *  `metadata_writer.is_legacy_event_log_entry` / `is_envelope_event_log_entry`). */
export type RawEventLogEntry = LegacyEventLogEntry | EnvelopeEventLogEntry;

export interface LegacyEventLogEntry {
  kind: 'agent_ref_move';
  reason?: 'operator_revert' | 'operator_branch' | string;
  agent_id?: string;
  from_turn_id?: string;
  to_turn_id?: string;
  recorded_at?: string;
}

export interface EnvelopeEventLogEntry {
  message_type: string;
  payload?: {
    action_type?: string;
    parameters?: { intent_kind?: string; [k: string]: unknown };
    originating_cell_id?: string;
    [k: string]: unknown;
  };
  rfc_version?: string;
  correlation_id?: string;
  created_at?: string;
  ts?: string | number;
}

/** Layout root per family-b-layout protocol — recursive tree at
 *  `metadata.rts.layout.tree`. Sidebar V1 uses only `children[*]` of
 *  the root; richer navigation through the tree is V1.5+. */
export interface RtsLayout {
  version?: number;
  tree?: LayoutTreeNode;
}

export interface LayoutTreeNode {
  type?: string;
  id?: string;
  children?: LayoutTreeNode[];
}

// ----------------------------------------------------------------------
// Zones tree nodes
// ----------------------------------------------------------------------

/** A node in the Zones tree. The root level lists open .llmnb files;
 *  expanding a zone reveals two virtual nodes (Agents / Sections) whose
 *  children are the per-agent and per-section nodes for that zone. */
export type ZonesNode =
  | { kind: 'empty'; message: string }
  | { kind: 'zone'; uri: vscode.Uri; label: string }
  | { kind: 'agents-root'; parentUri: vscode.Uri }
  | { kind: 'sections-root'; parentUri: vscode.Uri }
  | { kind: 'zone-agent'; parentUri: vscode.Uri; agentId: string }
  | { kind: 'zone-section'; parentUri: vscode.Uri; sectionId: string };

// ----------------------------------------------------------------------
// Agents tree nodes
// ----------------------------------------------------------------------

/** A node in the Agents tree (active notebook only). Roots are
 *  per-agent; expanding shows the session detail rows pulled from
 *  `agents[id].session.*`. */
export type AgentsNode =
  | { kind: 'empty'; message: string }
  | { kind: 'agent'; agentId: string }
  | {
      kind: 'agent-detail';
      agentId: string;
      label: string;
      value: string;
    };

// ----------------------------------------------------------------------
// Activity tree nodes
// ----------------------------------------------------------------------

/** The seven entry types PLAN-S7 §3.4 surfaces in the activity tree.
 *  Synthesized consumer-side — the kernel does not emit these as
 *  discrete entry types. */
export type SynthesizedEntryType =
  | 'agent_spawn'
  | 'agent_branch'
  | 'agent_revert'
  | 'agent_stop'
  | 'ref_move'
  | 'run_start'
  | 'run_end';

/** One row in the activity tree after consumer-side synthesis. */
export interface SynthesizedActivityEntry {
  /** Sortable timestamp (ms-since-epoch). 0 means unknown. */
  timestamp_ms: number;
  entry_type: SynthesizedEntryType;
  label: string;
  /** Cell to navigate to on click. Optional — some entries have no
   *  cell anchor (e.g. operator-driven section ops on an empty zone). */
  cell_id?: string;
  /** Which source the entry came from (for triage when classification
   *  goes wrong). */
  source: 'event_log_legacy' | 'event_log_envelope' | 'run_frames';
}

export type ActivityNode =
  | { kind: 'empty'; message: string }
  | { kind: 'entry'; entry: SynthesizedActivityEntry }
  | { kind: 'load-more' };
