// PLAN-V2-sidebar-glanceability §3.4 (A4) — pure decoration-condition
// logic for the agent FileDecorationProvider badges.
//
// This module is pure — no vscode import at runtime. It answers three
// questions the (separately wired) `vscode.FileDecorationProvider`
// needs:
//
//   1. `deriveAgentCondition` — which exception state, if any, does an
//      agent occupy? Priority: attention > running > terminated (one
//      badge per node; highest-attention wins — mirrors the
//      output-kind lens ordering convention in
//      `output-kind-lens/types.ts` OUTPUT_KIND_ORDER).
//   2. `conditionToDecoration` — the POJO badge/color for a condition.
//      Returns colorId STRINGS (theme color ids per `badge-style.ts`
//      conventions); the composition pass wraps them in
//      `vscode.ThemeColor` / `vscode.FileDecoration`.
//   3. `agentResourceUriString` / `parseAgentResourceUriPath` — the
//      `llmnb-agent://` resource-URI scheme both trees and the
//      provider must agree on, kept here so the agreement lives in
//      one vscode-free place.
//
// Steady state (alive-but-idle) gets NO decoration — decorations are
// for exceptions, not directory noise.
//
// Every snapshot field may be absent — partial / legacy snapshots must
// never throw (same tolerance contract as `agent-lineage.ts`).

import type { RawRunFrame, RtsSnapshot } from './types.js';
import { getStringAttr, type OtlpAttribute } from '../otel/attrs.js';

/** The three exception states a decoration badge can encode. */
export type AgentCondition = 'attention' | 'running' | 'terminated';

/** Custom URI scheme shared by the decoration provider and both trees. */
export const AGENT_RESOURCE_SCHEME = 'llmnb-agent';

/** Output kinds whose latest emission flags the agent as needing the
 *  operator (subset of the 12 V1-normative kinds pinned in
 *  `output-kind-lens/types.ts`). */
const ATTENTION_KINDS: ReadonlySet<string> = new Set(['question', 'decision']);

/** Run-frame statuses that mean the run is settled even if `ended_at`
 *  was never written (defensive against writer lag). */
const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'complete',
  'completed',
  'error',
  'failed',
  'cancelled'
]);

/** `metadata.rts.event_log` (TOP-level, distinct from
 *  `zone.event_log[]`) carries the writer's closed OTLP spans in
 *  `runs[]` — including the supervisor's agent_emit emissions with
 *  their `llmnb.output.kind` attribute (metadata_writer/_writer.py,
 *  `_build_event_log`). `sidebar/types.ts` doesn't declare it yet, so
 *  we widen locally and read defensively. */
interface SnapshotWithRunLog extends RtsSnapshot {
  event_log?: { runs?: unknown[] };
}

/** Derive the highest-priority exception condition for `agentId`, or
 *  null when the agent is in steady state (no decoration). */
export function deriveAgentCondition(
  agentId: string,
  snapshot: RtsSnapshot | undefined
): AgentCondition | null {
  if (!agentId || !snapshot || typeof snapshot !== 'object') return null;
  // (a) attention — latest output-kind-tagged span is question/decision.
  const latestKind = latestTaggedSpanKind(agentId, snapshot);
  if (latestKind !== undefined && ATTENTION_KINDS.has(latestKind)) {
    return 'attention';
  }
  // (b) running — an in-flight run frame executed by this agent.
  if (hasInFlightRunFrame(agentId, snapshot)) return 'running';
  // (c) terminated.
  const status = snapshot.zone?.agents?.[agentId]?.session?.runtime_status;
  if (status === 'terminated') return 'terminated';
  // (d) steady state — decorations are for exceptions.
  return null;
}

/** Map a condition to its badge POJO. `colorId` is a theme color id
 *  string (`charts.*` per badge-style.ts conventions); the composition
 *  pass wraps it in `vscode.ThemeColor`. */
export function conditionToDecoration(
  condition: AgentCondition
): { badge: string; colorId: string; propagate: true } {
  switch (condition) {
    case 'attention':
      return { badge: '!!', colorId: 'charts.yellow', propagate: true };
    case 'running':
      return { badge: '▶', colorId: 'charts.green', propagate: true };
    case 'terminated':
      return { badge: '✗', colorId: 'charts.red', propagate: true };
  }
}

/** Build the `llmnb-agent://` resource-URI string for one agent row.
 *  Both path segments are percent-encoded so ids containing `/` or
 *  spaces survive the round-trip through `parseAgentResourceUriPath`. */
export function agentResourceUriString(
  zoneId: string,
  agentId: string
): string {
  return `${AGENT_RESOURCE_SCHEME}:///${encodeURIComponent(zoneId)}/${encodeURIComponent(agentId)}`;
}

/** Inverse of `agentResourceUriString` over the URI *path* component
 *  (`/<zone>/<agent>`). Returns null on any malformed input — wrong
 *  segment count, empty segments, or invalid percent-encoding. */
export function parseAgentResourceUriPath(
  path: string
): { zoneId: string; agentId: string } | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const parts = path.slice(1).split('/');
  if (parts.length !== 2) return null;
  const [rawZone, rawAgent] = parts;
  if (rawZone.length === 0 || rawAgent.length === 0) return null;
  try {
    return {
      zoneId: decodeURIComponent(rawZone),
      agentId: decodeURIComponent(rawAgent)
    };
  } catch {
    // URIError on malformed percent-encoding (e.g. "%zz").
    return null;
  }
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------

/** True iff some entry in `zone.run_frames` is an in-flight run
 *  executed by `agentId`: no `ended_at` and a status that isn't
 *  settled.
 *
 *  NOTE: a sibling A1 helper (`agent-run-state.ts`) derives the same
 *  fact; this check is deliberately inlined per the A4 slice contract
 *  so the two modules land independently. */
function hasInFlightRunFrame(
  agentId: string,
  snapshot: RtsSnapshot
): boolean {
  const frames = snapshot.zone?.run_frames;
  if (!frames || typeof frames !== 'object') return false;
  for (const raw of Object.values(frames)) {
    if (!raw || typeof raw !== 'object') continue;
    const frame = raw as RawRunFrame;
    if (frame.executor_id !== agentId) continue;
    if (frame.ended_at !== null && frame.ended_at !== undefined) continue;
    const status = typeof frame.status === 'string' ? frame.status : '';
    if (!SETTLED_RUN_STATUSES.has(status)) return true;
  }
  return false;
}

/** The `llmnb.output.kind` value of the agent's most recent tagged
 *  span in `event_log.runs[]` ("most recent" = latest
 *  `startTimeUnixNano`; log order breaks ties, later wins). Returns
 *  undefined when the agent has no tagged spans.
 *
 *  TODO(A4): span iteration + nanos→ms parsing are minimally
 *  re-derived from `output-kind-lens/extractor.ts` (`iterateSpans` /
 *  `parseNanos`) — that module imports vscode at top level (its
 *  entry point walks `vscode.NotebookDocument` cell outputs), so it
 *  cannot be imported from this pure module. If the extractor's pure
 *  pieces are ever split out vscode-free, fold this duplication back
 *  in. Attribute decoding is NOT duplicated — reused from
 *  `otel/attrs.ts` (already pure).
 */
function latestTaggedSpanKind(
  agentId: string,
  snapshot: RtsSnapshot
): string | undefined {
  const runs = (snapshot as SnapshotWithRunLog).event_log?.runs;
  if (!Array.isArray(runs)) return undefined;
  let bestKind: string | undefined;
  let bestTs = -1;
  for (const raw of runs) {
    if (!raw || typeof raw !== 'object') continue;
    const span = raw as { attributes?: unknown; startTimeUnixNano?: unknown };
    if (!Array.isArray(span.attributes)) continue;
    const attrs = span.attributes.filter(
      (a): a is OtlpAttribute =>
        !!a && typeof a === 'object' && typeof (a as OtlpAttribute).key === 'string'
    );
    if (getStringAttr(attrs, 'llmnb.agent_id') !== agentId) continue;
    const kind = getStringAttr(attrs, 'llmnb.output.kind');
    if (kind.length === 0) continue;
    const ts = parseNanosToMs(span.startTimeUnixNano);
    // `>=` so log order breaks ties (later entries win).
    if (ts >= bestTs) {
      bestTs = ts;
      bestKind = kind;
    }
  }
  return bestKind;
}

/** OTLP `startTimeUnixNano` (JSON string of nanos) → ms-since-epoch;
 *  0 on missing / unparseable input. See TODO(A4) above. */
function parseNanosToMs(nanos: unknown): number {
  if (typeof nanos !== 'string' || nanos.length === 0) return 0;
  if (!/^\d+$/.test(nanos)) {
    const fallback = Date.parse(nanos);
    return Number.isFinite(fallback) ? fallback : 0;
  }
  if (nanos.length <= 6) return 0;
  const ms = Number(nanos.slice(0, nanos.length - 6));
  return Number.isFinite(ms) ? ms : 0;
}
