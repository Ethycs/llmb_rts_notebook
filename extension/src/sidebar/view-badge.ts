// PLAN-V2-sidebar-glanceability §3.2 — fleet badge on the Agents view.
//
// Pure compute for the `TreeView.badge` (`ViewBadge`) the composition
// pass in extension.ts sets on the `llmnb.agents` view handle. This
// module derives the alive-agent count from an RTS snapshot and shapes
// it into the `{ value, tooltip }` pair the stable ViewBadge API takes.
// Zero alive → `undefined`, because a zero badge must CLEAR the badge,
// not render a "0" pill on the Activity Bar icon.
//
// Pure — no vscode import. Same pattern as `agent-lineage.ts`.

import type { RtsSnapshot } from './types.js';

/** Count agents whose `session.runtime_status === 'alive'` in the
 *  snapshot's zone. Tolerates missing zone / agents / session (partial
 *  or legacy snapshots) — returns 0, never throws. */
export function computeAliveAgentCount(
  snapshot: RtsSnapshot | undefined
): number {
  const agents = snapshot?.zone?.agents;
  if (!agents || typeof agents !== 'object') return 0;
  let count = 0;
  for (const agent of Object.values(agents)) {
    if (agent?.session?.runtime_status === 'alive') count += 1;
  }
  return count;
}

/** Shape the ViewBadge value for the Agents view. `undefined` when no
 *  agent is alive (the caller assigns it straight to `TreeView.badge`,
 *  where `undefined` clears the badge). Tooltip pluralises correctly:
 *  "1 agent alive" / "3 agents alive". */
export function computeAgentsViewBadge(
  snapshot: RtsSnapshot | undefined
): { value: number; tooltip: string } | undefined {
  const count = computeAliveAgentCount(snapshot);
  if (count === 0) return undefined;
  return {
    value: count,
    tooltip: count === 1 ? '1 agent alive' : `${count} agents alive`
  };
}
