// PLAN-V2-sidebar-glanceability §3.1 — pure run-state + unit-card helpers.
//
// Derives "does this agent have an in-flight run?" from
// `metadata.rts.zone.run_frames` (the per-run RunFrame records the
// kernel writes — see the run-frame atom) and builds the Markdown body
// for the agent row's tooltip card. Pure module over the snapshot —
// same pattern as `agent-lineage.ts`; the vscode.MarkdownString /
// ThemeIcon wrapping happens in the tree layer so this file stays
// vscode-free and T0-testable.

import type { RawAgent, RawRunFrame, RtsSnapshot } from './types.js';

/** Statuses that mean the run is over even if `ended_at` was never
 *  written (crash / legacy writer). Unknown statuses with a null
 *  `ended_at` are treated as in-flight — better a stale spinner than a
 *  hidden live run. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'complete',
  'completed',
  'error',
  'failed',
  'cancelled'
]);

function isInFlight(frame: RawRunFrame): boolean {
  if (frame.ended_at !== null && frame.ended_at !== undefined) return false;
  const status = frame.status;
  if (typeof status === 'string' && TERMINAL_STATUSES.has(status)) return false;
  return true;
}

function startedAtMs(frame: RawRunFrame): number {
  if (typeof frame.started_at !== 'string') return 0;
  const t = Date.parse(frame.started_at);
  return Number.isFinite(t) ? t : 0;
}

/** The most recent (by `started_at`) in-flight run frame executed by
 *  `agentId`, or null when the agent has no live run. Tolerates
 *  missing zone / run_frames / malformed frames. */
export function getActiveRunFrame(
  agentId: string,
  snapshot: RtsSnapshot | undefined
): RawRunFrame | null {
  const frames = snapshot?.zone?.run_frames;
  if (!frames || typeof frames !== 'object') return null;
  let best: RawRunFrame | null = null;
  let bestTs = -1;
  for (const frame of Object.values(frames)) {
    if (!frame || typeof frame !== 'object') continue;
    if (frame.executor_id !== agentId) continue;
    if (!isInFlight(frame)) continue;
    const ts = startedAtMs(frame);
    if (ts > bestTs) {
      best = frame;
      bestTs = ts;
    }
  }
  return best;
}

/** True when the agent has at least one in-flight run frame. */
export function hasInFlightRun(
  agentId: string,
  snapshot: RtsSnapshot | undefined
): boolean {
  return getActiveRunFrame(agentId, snapshot) !== null;
}

/** Build the Markdown body for the agent row's "unit card" tooltip.
 *  Returns a plain string — the tree layer wraps it in a
 *  vscode.MarkdownString with `supportThemeIcons: true` so the
 *  `$(loading~spin)` codicon renders. Every field is optional; a
 *  partial / legacy snapshot must never throw. */
export function buildAgentTooltipMarkdown(
  agentId: string,
  snapshot: RtsSnapshot | undefined
): string {
  const agent: RawAgent | undefined = snapshot?.zone?.agents?.[agentId];
  const rawTurns = agent?.turns;
  const turns = Array.isArray(rawTurns) ? rawTurns : [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

  const status = agent?.session?.runtime_status ?? 'idle';
  const lines: string[] = [`**${agentId}**`, ''];
  lines.push(`- status: ${status}`);
  if (typeof latestTurn?.provider === 'string' && latestTurn.provider.length > 0) {
    lines.push(`- provider: ${latestTurn.provider}`);
  }
  lines.push(`- turns: ${turns.length}`);
  lines.push(`- last activity: ${lastActivity(agentId, snapshot, latestTurn?.created_at)}`);

  const active = getActiveRunFrame(agentId, snapshot);
  if (active) {
    lines.push(`- $(loading~spin) run in flight: ${active.run_id ?? 'unknown'}`);
  }
  return lines.join('\n');
}

/** Latest-activity timestamp: newest turn `created_at`, else the
 *  newest of the agent's run-frame `started_at`s, else an em dash. */
function lastActivity(
  agentId: string,
  snapshot: RtsSnapshot | undefined,
  latestTurnCreatedAt: string | undefined
): string {
  if (typeof latestTurnCreatedAt === 'string' && latestTurnCreatedAt.length > 0) {
    return latestTurnCreatedAt;
  }
  const frames = snapshot?.zone?.run_frames;
  if (frames && typeof frames === 'object') {
    let best: string | undefined;
    let bestTs = -1;
    for (const frame of Object.values(frames)) {
      if (!frame || typeof frame !== 'object') continue;
      if (frame.executor_id !== agentId) continue;
      const ts = startedAtMs(frame);
      if (typeof frame.started_at === 'string' && ts > bestTs) {
        best = frame.started_at;
        bestTs = ts;
      }
    }
    if (best) return best;
  }
  return '—';
}
