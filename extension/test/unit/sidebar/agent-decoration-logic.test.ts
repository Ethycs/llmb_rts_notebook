// PLAN-V2-sidebar-glanceability §3.4 (A4) — unit tests for the pure
// decoration-condition logic.
//
// T0: pure-module tests, no vscode. We exercise `deriveAgentCondition`
// + `conditionToDecoration` + the `llmnb-agent://` URI helpers
// directly. The vscode-bound FileDecorationProvider class is covered
// by the contract tier after the composition pass.

import * as assert from 'node:assert/strict';
import {
  AGENT_RESOURCE_SCHEME,
  agentResourceUriString,
  conditionToDecoration,
  deriveAgentCondition,
  parseAgentResourceUriPath
} from '../../../src/sidebar/agent-decoration-logic.js';
import type { RtsSnapshot } from '../../../src/sidebar/types.js';

// ----------------------------------------------------------------------
// Fixture builders — mirror the on-disk `metadata.rts` shape the
// kernel writes (capture/metadata_writer/_writer.py). Emit spans live
// in the TOP-level `event_log.runs[]` (OTLP spans); run frames and
// agent sessions live under `zone`.
// ----------------------------------------------------------------------

function nanos(iso: string): string {
  return String(Date.parse(iso)) + '000000';
}

/** One agent_emit OTLP span tagged with `llmnb.output.kind`. */
function emitSpan(agentId: string, kind: string, iso: string): unknown {
  return {
    traceId: '0'.repeat(32),
    spanId: 'abcdef0123456789',
    name: 'agent_emit',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: nanos(iso),
    endTimeUnixNano: nanos(iso),
    attributes: [
      { key: 'llmnb.agent_id', value: { stringValue: agentId } },
      { key: 'llmnb.output.kind', value: { stringValue: kind } }
    ],
    status: { code: 'STATUS_CODE_OK', message: '' }
  };
}

function snapshotWith(args: {
  runs?: unknown[];
  run_frames?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}): RtsSnapshot {
  const snapshot: Record<string, unknown> = {
    schema_version: '1',
    zone: {
      zone_id: 'z1',
      agents: args.agents,
      run_frames: args.run_frames
    }
  };
  if (args.runs) {
    snapshot['event_log'] = { version: 1, runs: args.runs };
  }
  return snapshot as RtsSnapshot;
}

function inFlightFrame(agentId: string): Record<string, unknown> {
  return {
    run_id: 'r-inflight',
    cell_id: 'c1',
    executor_id: agentId,
    status: 'running',
    started_at: '2026-08-27T12:00:00Z',
    ended_at: null
  };
}

function completedFrame(agentId: string): Record<string, unknown> {
  return {
    run_id: 'r-done',
    cell_id: 'c1',
    executor_id: agentId,
    status: 'complete',
    started_at: '2026-08-27T11:00:00Z',
    ended_at: '2026-08-27T11:00:05Z'
  };
}

function agentRecord(runtimeStatus: string): Record<string, unknown> {
  return { turns: [], session: { runtime_status: runtimeStatus } };
}

suite('unit: V2 sidebar A4 — agent-decoration-logic', () => {

  test('condition_to_decoration_maps_each_condition', () => {
    assert.deepEqual(conditionToDecoration('attention'), {
      badge: '!!', colorId: 'charts.yellow', propagate: true
    });
    assert.deepEqual(conditionToDecoration('running'), {
      badge: '▶', colorId: 'charts.green', propagate: true
    });
    assert.deepEqual(conditionToDecoration('terminated'), {
      badge: '✗', colorId: 'charts.red', propagate: true
    });
  });

  test('attention_when_latest_tagged_span_is_question_or_decision', () => {
    const snap = snapshotWith({
      runs: [
        emitSpan('alpha', 'prose', '2026-08-27T10:00:00Z'),
        emitSpan('alpha', 'question', '2026-08-27T10:05:00Z'),
        // Another agent's later decision must not leak onto alpha.
        emitSpan('beta', 'code', '2026-08-27T10:10:00Z')
      ],
      agents: { alpha: agentRecord('alive'), beta: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', snap), 'attention');
    assert.equal(deriveAgentCondition('beta', snap), null,
      'latest beta span is code → no attention, and idle-alive → no badge');
  });

  test('attention_clears_when_a_later_span_is_not_question_or_decision', () => {
    // "Most recent" semantics: the question was answered by a later
    // prose emission → steady state again.
    const snap = snapshotWith({
      runs: [
        emitSpan('alpha', 'question', '2026-08-27T10:00:00Z'),
        emitSpan('alpha', 'prose', '2026-08-27T10:05:00Z')
      ],
      agents: { alpha: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', snap), null);
  });

  test('priority_attention_beats_running_beats_terminated', () => {
    // All three conditions hold at once → attention wins.
    const all = snapshotWith({
      runs: [emitSpan('alpha', 'decision', '2026-08-27T10:00:00Z')],
      run_frames: { 'r-inflight': inFlightFrame('alpha') },
      agents: { alpha: agentRecord('terminated') }
    });
    assert.equal(deriveAgentCondition('alpha', all), 'attention');
    // Running + terminated (no attention span) → running wins.
    const runningAndDead = snapshotWith({
      run_frames: { 'r-inflight': inFlightFrame('alpha') },
      agents: { alpha: agentRecord('terminated') }
    });
    assert.equal(deriveAgentCondition('alpha', runningAndDead), 'running');
  });

  test('running_for_in_flight_frame_but_not_settled_frames', () => {
    const inflight = snapshotWith({
      run_frames: { 'r-inflight': inFlightFrame('alpha') },
      agents: { alpha: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', inflight), 'running');
    // Completed frame → not running; alive-but-idle → null.
    const done = snapshotWith({
      run_frames: { 'r-done': completedFrame('alpha') },
      agents: { alpha: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', done), null);
    // Settled status without ended_at (writer lag) still isn't running.
    const laggy = snapshotWith({
      run_frames: {
        'r-lag': { executor_id: 'alpha', status: 'error', ended_at: null }
      },
      agents: { alpha: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', laggy), null,
      'error status → settled even with ended_at null');
    // Someone else's in-flight frame is not ours.
    const other = snapshotWith({
      run_frames: { 'r-inflight': inFlightFrame('beta') },
      agents: { alpha: agentRecord('alive') }
    });
    assert.equal(deriveAgentCondition('alpha', other), null);
  });

  test('terminated_status_maps_to_terminated', () => {
    const snap = snapshotWith({
      agents: { alpha: agentRecord('terminated') }
    });
    assert.equal(deriveAgentCondition('alpha', snap), 'terminated');
  });

  test('steady_state_alive_idle_gets_no_decoration', () => {
    const snap = snapshotWith({
      agents: {
        alpha: agentRecord('alive'),
        idler: agentRecord('idle'),
        gone: agentRecord('exited')
      }
    });
    assert.equal(deriveAgentCondition('alpha', snap), null);
    assert.equal(deriveAgentCondition('idler', snap), null);
    assert.equal(deriveAgentCondition('gone', snap), null,
      'exited is a normal end state, not the ✗ exception');
  });

  test('tolerates_missing_or_partial_snapshots_without_throwing', () => {
    assert.equal(deriveAgentCondition('alpha', undefined), null);
    assert.equal(deriveAgentCondition('alpha', {} as RtsSnapshot), null);
    assert.equal(deriveAgentCondition('alpha', { zone: {} } as RtsSnapshot), null);
    assert.equal(deriveAgentCondition('', snapshotWith({})), null);
    // Junk in every collection the derivation walks.
    const junk = {
      event_log: { runs: [null, 42, {}, { attributes: 'nope' }, { attributes: [null, {}] }] },
      zone: {
        run_frames: { bad: null, worse: 'string' },
        agents: { alpha: { session: null } }
      }
    } as unknown as RtsSnapshot;
    assert.equal(deriveAgentCondition('alpha', junk), null);
  });

  test('uri_round_trip_including_slashes_and_spaces', () => {
    const plain = agentResourceUriString('z1', 'alpha');
    assert.equal(plain, 'llmnb-agent:///z1/alpha');
    assert.deepEqual(
      parseAgentResourceUriPath(plain.slice(`${AGENT_RESOURCE_SCHEME}://`.length)),
      { zoneId: 'z1', agentId: 'alpha' }
    );
    // Hostile ids: '/' and spaces must survive the round-trip without
    // growing extra path segments.
    const uri = agentResourceUriString('zone one', 'agent/with slash');
    const path = uri.slice(`${AGENT_RESOURCE_SCHEME}://`.length);
    assert.equal(path.slice(1).split('/').length, 2,
      'encoded path must still be exactly two segments');
    assert.deepEqual(parseAgentResourceUriPath(path), {
      zoneId: 'zone one',
      agentId: 'agent/with slash'
    });
  });

  test('malformed_uri_paths_parse_to_null', () => {
    assert.equal(parseAgentResourceUriPath(''), null);
    assert.equal(parseAgentResourceUriPath('no-leading-slash'), null);
    assert.equal(parseAgentResourceUriPath('/only-zone'), null);
    assert.equal(parseAgentResourceUriPath('/z1/'), null, 'empty agent segment');
    assert.equal(parseAgentResourceUriPath('//alpha'), null, 'empty zone segment');
    assert.equal(parseAgentResourceUriPath('/z1/a/extra'), null, 'three segments');
    assert.equal(parseAgentResourceUriPath('/z1/%zz'), null,
      'invalid percent-encoding must not throw');
  });
});
