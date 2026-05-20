// V2 branch-switching UX — pure agent-lineage builder.
//
// The `fork_agent` intent (kernel side: `metadata_writer._handle_fork_agent`)
// carries `source_agent_id` + `new_agent_id` + `at_turn_id` + `case` on
// its `payload.parameters`, but the persisted agent record only keeps
// `session.fork_case` — the lineage relationship itself isn't on the
// agent record. We recover it by walking `metadata.rts.zone.event_log[]`
// (the captured RFC-006 envelope stream, PLAN-S6.0 §3.A) and indexing
// by `intent_kind === "fork_agent"`.
//
// This module is pure — give it a snapshot, get back the maps. The
// sidebar Agents tree consumes the reverse-map to render "Branches"
// subnodes under each agent that has descendants.

import type {
  EnvelopeEventLogEntry,
  RawEventLogEntry,
  RtsSnapshot
} from './types.js';

/** One forked-agent record recovered from the event_log. The fields
 *  here are exactly what the operator needs to disambiguate the fork
 *  in the UI: which agent forked from where, at which turn, and the
 *  PLAN-S5 case label (A = at head, B = at ancestor). */
export interface ForkRecord {
  /** The agent that was created by the fork. */
  branchAgentId: string;
  /** The source agent the fork was based on. */
  sourceAgentId: string;
  /** The turn the fork pivoted at (null when the source agent was
   *  bootstrapping — see metadata_writer.py:1633-1638). */
  atTurnId: string | null;
  /** PLAN-S5 case label ("A" = fork at head, "B" = fork at ancestor). */
  case: 'A' | 'B' | undefined;
  /** ms-since-epoch timestamp when the fork envelope was captured.
   *  0 if unknown. Used for chronological ordering when an agent has
   *  multiple forks. */
  timestampMs: number;
}

/** Maps (forward + reverse) recovered from one snapshot. */
export interface AgentLineage {
  /** `branchAgentId -> ForkRecord`. Tells you "is this agent a branch,
   *  and if so, from where?" */
  parents: ReadonlyMap<string, ForkRecord>;
  /** `sourceAgentId -> ForkRecord[]` (children in chronological order).
   *  Tells you "what branches does this agent have?" */
  children: ReadonlyMap<string, ForkRecord[]>;
}

/** Build the lineage maps from an RTS snapshot. Tolerates missing /
 *  malformed entries — anything that doesn't match the fork-agent
 *  envelope shape is silently skipped. */
export function buildAgentLineage(
  snapshot: RtsSnapshot | undefined
): AgentLineage {
  const parents = new Map<string, ForkRecord>();
  const childrenWithTs = new Map<string, ForkRecord[]>();
  const log = snapshot?.zone?.event_log ?? [];
  for (const entry of log) {
    const rec = extractForkRecord(entry);
    if (!rec) continue;
    // The same `new_agent_id` can only be forked once (the kernel
    // rejects duplicate ids — metadata_writer.py:1624), so the
    // forward map is single-write per branch.
    if (!parents.has(rec.branchAgentId)) {
      parents.set(rec.branchAgentId, rec);
    }
    const bucket = childrenWithTs.get(rec.sourceAgentId);
    if (bucket) {
      bucket.push(rec);
    } else {
      childrenWithTs.set(rec.sourceAgentId, [rec]);
    }
  }
  // Sort each child bucket by capture time so the UI renders branches
  // in operator-creation order. Forks with timestamp 0 (unknown) sort
  // last so they don't push known-ordered branches around.
  for (const bucket of childrenWithTs.values()) {
    bucket.sort((a, b) => {
      const at = a.timestampMs || Number.MAX_SAFE_INTEGER;
      const bt = b.timestampMs || Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
  }
  return { parents, children: childrenWithTs };
}

/** Inspect a single event_log entry and return a ForkRecord if it's a
 *  fork_agent intent envelope; otherwise undefined. Exported so tests
 *  can pin the discrimination logic against representative wire
 *  shapes. */
export function extractForkRecord(
  entry: RawEventLogEntry | undefined
): ForkRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  // Legacy `agent_ref_move` records don't carry fork details — skip.
  if ((entry as { kind?: unknown }).kind === 'agent_ref_move') return undefined;
  const env = entry as EnvelopeEventLogEntry;
  if (env.message_type !== 'operator.action') return undefined;
  const payload = env.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.action_type !== 'zone_mutate') return undefined;
  const params = payload.parameters;
  if (!params || typeof params !== 'object') return undefined;
  if (params.intent_kind !== 'fork_agent') return undefined;
  const p = params as Record<string, unknown>;
  const sourceAgentId = p['source_agent_id'];
  const branchAgentId = p['new_agent_id'];
  if (typeof sourceAgentId !== 'string' || sourceAgentId.length === 0) return undefined;
  if (typeof branchAgentId !== 'string' || branchAgentId.length === 0) return undefined;
  const atTurnId =
    typeof p['at_turn_id'] === 'string' && (p['at_turn_id'] as string).length > 0
      ? (p['at_turn_id'] as string)
      : null;
  const rawCase = p['case'];
  const caseLabel =
    rawCase === 'A' || rawCase === 'B' ? (rawCase as 'A' | 'B') : undefined;
  const timestampMs = readTimestampMs(env);
  return {
    branchAgentId,
    sourceAgentId,
    atTurnId,
    case: caseLabel,
    timestampMs
  };
}

function readTimestampMs(env: EnvelopeEventLogEntry): number {
  if (typeof env.created_at === 'string') {
    const t = Date.parse(env.created_at);
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof env.ts === 'number' && Number.isFinite(env.ts)) return env.ts;
  if (typeof env.ts === 'string') {
    const t = Date.parse(env.ts);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** Pick the "root" agent ids — agents that are NOT branches of any
 *  other agent. The Agents tree currently renders all agents flat at
 *  the top level; V2 branch-switching UX uses this to surface the
 *  lineage relationship without reorganising the tree (every agent
 *  is still rendered; root agents have descendants as Branches
 *  subnodes, branches DO show under their parent AND remain in the
 *  top-level list for direct navigation). */
export function rootAgentIds(
  agentIds: ReadonlyArray<string>,
  lineage: AgentLineage
): string[] {
  return agentIds.filter((id) => !lineage.parents.has(id));
}
