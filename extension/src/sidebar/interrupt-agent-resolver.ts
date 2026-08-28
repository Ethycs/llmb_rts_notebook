// PLAN-V2-sidebar-glanceability §3.3 — inline interrupt: pure resolver.
//
// The `llmnb.sidebar.interruptAgent` command (thin vscode-bound layer,
// composed later) must route the click to the agent's ACTIVE cell so it
// can delegate to the existing S9 interrupt path. This module holds the
// pure resolution logic: given an agent id, a snapshot, and an injected
// active-run-frame lookup (the §3.1 run-state helper — injected rather
// than imported so the two modules can land independently), produce the
// `{ cellId, runId }` target — or null when there is nothing to
// interrupt. Interrupting a run that already completed must never
// throw; the command layer warns and no-ops on null (PLAN §5 staleness
// mitigation: re-resolve at click time).
//
// Pure — no vscode import. Same pattern as `agent-lineage.ts`.

import type { RawRunFrame, RtsSnapshot } from './types.js';

/** Injected lookup for the agent's in-flight run frame. Implemented by
 *  the §3.1 run-state helper (`agent-run-state.ts`); returns null when
 *  the agent has no in-flight run. */
export type ActiveRunFrameLookup = (
  agentId: string,
  snapshot: RtsSnapshot | undefined
) => RawRunFrame | null;

/** Resolved interrupt target: the cell to interrupt (S9 path keys on
 *  cell_id) plus the run id for logging/telemetry (null when the frame
 *  didn't record one). */
export interface InterruptTarget {
  cellId: string;
  runId: string | null;
}

/** Resolve the interrupt target for an agent at click time. Returns
 *  null when the lookup finds no in-flight frame, or when the frame
 *  lacks a usable `cell_id` (nothing to route the interrupt to). */
export function resolveInterruptTarget(
  agentId: string,
  snapshot: RtsSnapshot | undefined,
  lookup: ActiveRunFrameLookup
): InterruptTarget | null {
  const frame = lookup(agentId, snapshot);
  if (!frame) return null;
  const cellId = frame.cell_id;
  if (typeof cellId !== 'string' || cellId.length === 0) return null;
  return { cellId, runId: frame.run_id ?? null };
}

/** Base contextValue set by agents-tree.ts (agents-tree.ts:140). */
export const AGENT_CONTEXT_VALUE = 'llmnb.sidebar.agent';

/** Running-variant contextValue the package.json `when` clause gates
 *  the inline stop button on (PLAN §3.3). */
export const AGENT_RUNNING_CONTEXT_VALUE = 'llmnb.sidebar.agent.running';

/** Single source for the agent-row contextValue strings. The tree sets
 *  the `.running` variant iff the agent has an in-flight run, so the
 *  inline stop button only appears where it can act. */
export function isAgentRunningContextValue(hasInFlight: boolean): string {
  return hasInFlight ? AGENT_RUNNING_CONTEXT_VALUE : AGENT_CONTEXT_VALUE;
}
