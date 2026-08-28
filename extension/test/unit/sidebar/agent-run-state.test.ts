// PLAN-V2-sidebar-glanceability §3.1 — unit tests for the pure
// run-state + tooltip helpers.
//
// T0: pure-module tests, no vscode. We exercise `getActiveRunFrame`,
// `hasInFlightRun`, and `buildAgentTooltipMarkdown` directly against
// snapshot fixtures shaped like the kernel writer's output; the
// vscode-bound tree wiring (ThemeIcon / MarkdownString) is covered by
// the contract tier.

import * as assert from 'node:assert/strict';
import {
  buildAgentTooltipMarkdown,
  getActiveRunFrame,
  hasInFlightRun
} from '../../../src/sidebar/agent-run-state.js';
import type {
  RawAgent,
  RawRunFrame,
  RtsSnapshot
} from '../../../src/sidebar/types.js';

function snapshotWith(args: {
  run_frames?: Record<string, RawRunFrame>;
  agents?: Record<string, RawAgent>;
}): RtsSnapshot {
  return {
    zone: {
      run_frames: args.run_frames,
      agents: args.agents
    }
  };
}

suite('unit: V2 sidebar — agent-run-state', () => {

  test('detects_in_flight_run_with_null_ended_at', () => {
    const snap = snapshotWith({
      run_frames: {
        'r1': {
          run_id: 'r1', executor_id: 'alpha', status: 'running',
          started_at: '2026-08-27T12:00:00Z', ended_at: null
        }
      }
    });
    const frame = getActiveRunFrame('alpha', snap);
    assert.ok(frame, 'running frame with null ended_at is in flight');
    assert.equal(frame!.run_id, 'r1');
    assert.equal(hasInFlightRun('alpha', snap), true);
  });

  test('completed_and_errored_runs_are_not_in_flight', () => {
    // Terminal statuses win even when ended_at was never written
    // (crash / legacy writer path).
    for (const status of ['complete', 'completed', 'error', 'failed', 'cancelled']) {
      const snap = snapshotWith({
        run_frames: {
          'r1': {
            run_id: 'r1', executor_id: 'alpha', status,
            started_at: '2026-08-27T12:00:00Z', ended_at: null
          }
        }
      });
      assert.equal(getActiveRunFrame('alpha', snap), null, `${status} is terminal`);
      assert.equal(hasInFlightRun('alpha', snap), false);
    }
  });

  test('ended_at_set_means_not_in_flight_even_with_nonterminal_status', () => {
    const snap = snapshotWith({
      run_frames: {
        'r1': {
          run_id: 'r1', executor_id: 'alpha', status: 'running',
          started_at: '2026-08-27T12:00:00Z',
          ended_at: '2026-08-27T12:00:05Z'
        }
      }
    });
    assert.equal(getActiveRunFrame('alpha', snap), null);
  });

  test('unknown_status_with_null_ended_at_counts_as_in_flight', () => {
    const snap = snapshotWith({
      run_frames: {
        'r1': {
          run_id: 'r1', executor_id: 'alpha', status: 'weird-new-status',
          started_at: '2026-08-27T12:00:00Z', ended_at: null
        }
      }
    });
    assert.equal(hasInFlightRun('alpha', snap), true,
      'unknown status + null ended_at → treat as live');
  });

  test('most_recent_in_flight_frame_wins_and_other_executors_are_ignored', () => {
    const snap = snapshotWith({
      run_frames: {
        'r-old': {
          run_id: 'r-old', executor_id: 'alpha', status: 'running',
          started_at: '2026-08-27T10:00:00Z', ended_at: null
        },
        'r-new': {
          run_id: 'r-new', executor_id: 'alpha', status: 'running',
          started_at: '2026-08-27T12:00:00Z', ended_at: null
        },
        'r-other': {
          run_id: 'r-other', executor_id: 'beta', status: 'running',
          started_at: '2026-08-27T13:00:00Z', ended_at: null
        }
      }
    });
    assert.equal(getActiveRunFrame('alpha', snap)!.run_id, 'r-new');
    assert.equal(getActiveRunFrame('beta', snap)!.run_id, 'r-other');
  });

  test('missing_zone_run_frames_or_snapshot_never_throws', () => {
    assert.equal(getActiveRunFrame('alpha', undefined), null);
    assert.equal(hasInFlightRun('alpha', undefined), false);
    assert.equal(getActiveRunFrame('alpha', {}), null, 'no zone');
    assert.equal(getActiveRunFrame('alpha', { zone: {} }), null, 'no run_frames');
    assert.equal(hasInFlightRun('alpha', { zone: {} }), false);
  });

  test('tooltip_renders_status_provider_and_turn_count', () => {
    const snap = snapshotWith({
      agents: {
        'alpha': {
          session: { runtime_status: 'alive' },
          turns: [
            { id: 't1', created_at: '2026-08-27T11:00:00Z', provider: 'claude' },
            { id: 't2', created_at: '2026-08-27T12:00:00Z', provider: 'claude' }
          ]
        }
      }
    });
    const md = buildAgentTooltipMarkdown('alpha', snap);
    assert.match(md, /\*\*alpha\*\*/, 'bolded agent id');
    assert.match(md, /- status: alive/);
    assert.match(md, /- provider: claude/);
    assert.match(md, /- turns: 2/);
    assert.match(md, /- last activity: 2026-08-27T12:00:00Z/,
      'latest turn created_at wins');
    assert.doesNotMatch(md, /run in flight/, 'no live run → no spinner line');
  });

  test('tooltip_tolerates_fully_empty_agent', () => {
    // Agent id not present in the snapshot at all — partial/legacy
    // snapshots must never throw.
    const md = buildAgentTooltipMarkdown('ghost', { zone: {} });
    assert.match(md, /\*\*ghost\*\*/);
    assert.match(md, /- status: idle/, 'runtime_status defaults to idle');
    assert.match(md, /- turns: 0/);
    assert.match(md, /- last activity: —/);
    assert.doesNotMatch(md, /- provider:/, 'no turns → no provider line');
    // Also survives a fully-undefined snapshot.
    assert.match(buildAgentTooltipMarkdown('ghost', undefined), /\*\*ghost\*\*/);
  });

  test('tooltip_includes_run_in_flight_line_only_when_in_flight', () => {
    const live = snapshotWith({
      agents: { 'alpha': { session: { runtime_status: 'alive' } } },
      run_frames: {
        'r1': {
          run_id: 'r1', executor_id: 'alpha', status: 'running',
          started_at: '2026-08-27T12:00:00Z', ended_at: null
        }
      }
    });
    const mdLive = buildAgentTooltipMarkdown('alpha', live);
    assert.match(mdLive, /\$\(loading~spin\) run in flight: r1/);

    const done = snapshotWith({
      agents: { 'alpha': { session: { runtime_status: 'idle' } } },
      run_frames: {
        'r1': {
          run_id: 'r1', executor_id: 'alpha', status: 'complete',
          started_at: '2026-08-27T12:00:00Z',
          ended_at: '2026-08-27T12:00:05Z'
        }
      }
    });
    assert.doesNotMatch(buildAgentTooltipMarkdown('alpha', done), /run in flight/);
  });

  test('tooltip_last_activity_falls_back_to_run_frame_started_at', () => {
    // No turns at all — the newest run frame's started_at fills in.
    const snap = snapshotWith({
      agents: { 'alpha': { session: { runtime_status: 'alive' } } },
      run_frames: {
        'r-old': {
          run_id: 'r-old', executor_id: 'alpha', status: 'complete',
          started_at: '2026-08-27T10:00:00Z',
          ended_at: '2026-08-27T10:00:05Z'
        },
        'r-new': {
          run_id: 'r-new', executor_id: 'alpha', status: 'complete',
          started_at: '2026-08-27T12:00:00Z',
          ended_at: '2026-08-27T12:00:05Z'
        }
      }
    });
    assert.match(
      buildAgentTooltipMarkdown('alpha', snap),
      /- last activity: 2026-08-27T12:00:00Z/
    );
  });
});
