// PLAN-V2-sidebar-glanceability §3.2 — unit tests for the Agents view
// fleet badge compute.
//
// T0: pure-module tests, no vscode. We exercise `computeAliveAgentCount`
// and `computeAgentsViewBadge` directly; the extension.ts wiring that
// assigns the result to `TreeView.badge` is composed (and covered)
// separately.

import * as assert from 'node:assert/strict';
import {
  computeAliveAgentCount,
  computeAgentsViewBadge
} from '../../../src/sidebar/view-badge.js';
import type { RtsSnapshot } from '../../../src/sidebar/types.js';

function snapshotWith(
  agents: Record<string, { session?: { runtime_status?: string } }>
): RtsSnapshot {
  return { zone: { zone_id: 'z1', agents } };
}

suite('unit: V2 glanceability — view-badge compute', () => {

  test('zero_alive_agents_clears_the_badge', () => {
    const snap = snapshotWith({
      alpha: { session: { runtime_status: 'exited' } },
      beta: { session: { runtime_status: 'idle' } }
    });
    assert.equal(computeAliveAgentCount(snap), 0);
    assert.equal(computeAgentsViewBadge(snap), undefined,
      'zero alive → undefined so TreeView.badge is CLEARED, not rendered as 0');
  });

  test('one_alive_agent_yields_value_1_with_singular_tooltip', () => {
    const snap = snapshotWith({
      alpha: { session: { runtime_status: 'alive' } }
    });
    assert.equal(computeAliveAgentCount(snap), 1);
    assert.deepEqual(computeAgentsViewBadge(snap), {
      value: 1,
      tooltip: '1 agent alive'
    });
  });

  test('counts_only_alive_among_mixed_statuses_with_plural_tooltip', () => {
    const snap = snapshotWith({
      a1: { session: { runtime_status: 'alive' } },
      a2: { session: { runtime_status: 'exited' } },
      a3: { session: { runtime_status: 'alive' } },
      a4: { session: { runtime_status: 'terminated' } },
      a5: { session: { runtime_status: 'alive' } },
      a6: { session: { runtime_status: 'idle' } }
    });
    assert.equal(computeAliveAgentCount(snap), 3);
    assert.deepEqual(computeAgentsViewBadge(snap), {
      value: 3,
      tooltip: '3 agents alive'
    });
  });

  test('missing_zone_or_undefined_snapshot_yields_zero_and_no_badge', () => {
    assert.equal(computeAliveAgentCount(undefined), 0, 'undefined snapshot');
    assert.equal(computeAgentsViewBadge(undefined), undefined);
    assert.equal(computeAliveAgentCount({}), 0, 'snapshot with no zone');
    assert.equal(computeAgentsViewBadge({}), undefined);
    assert.equal(computeAliveAgentCount({ zone: {} }), 0, 'zone with no agents');
    assert.equal(computeAgentsViewBadge({ zone: {} }), undefined);
  });

  test('agents_without_session_count_as_not_alive', () => {
    const snap = snapshotWith({
      alpha: {},
      beta: { session: {} }
    });
    assert.equal(computeAliveAgentCount(snap), 0,
      'missing session / missing runtime_status → not alive, no throw');
    assert.equal(computeAgentsViewBadge(snap), undefined);
  });
});
