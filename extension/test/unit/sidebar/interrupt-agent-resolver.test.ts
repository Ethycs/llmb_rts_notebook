// PLAN-V2-sidebar-glanceability §3.3 — unit tests for the pure
// interrupt-target resolver.
//
// T0: pure-module tests, no vscode. The run-state helper (§3.1) is
// dependency-injected as `ActiveRunFrameLookup`, so these tests stub it
// with plain functions — the resolver's behavior is pinned without
// importing agent-run-state.ts.

import * as assert from 'node:assert/strict';
import {
  resolveInterruptTarget,
  isAgentRunningContextValue,
  type ActiveRunFrameLookup
} from '../../../src/sidebar/interrupt-agent-resolver.js';
import type { RawRunFrame, RtsSnapshot } from '../../../src/sidebar/types.js';

const SNAPSHOT: RtsSnapshot = { zone: { zone_id: 'z1' } };

suite('unit: V2 glanceability — interrupt-agent-resolver', () => {

  test('frame_with_cell_id_resolves_target_with_run_id', () => {
    const frame: RawRunFrame = {
      run_id: 'run-1234',
      cell_id: 'cell-77',
      status: 'running'
    };
    const lookup: ActiveRunFrameLookup = (agentId, snapshot) => {
      assert.equal(agentId, 'alpha', 'lookup receives the agent id');
      assert.equal(snapshot, SNAPSHOT, 'lookup receives the snapshot');
      return frame;
    };
    assert.deepEqual(resolveInterruptTarget('alpha', SNAPSHOT, lookup), {
      cellId: 'cell-77',
      runId: 'run-1234'
    });
  });

  test('frame_without_cell_id_resolves_null', () => {
    const lookup: ActiveRunFrameLookup = () => ({
      run_id: 'run-1234',
      status: 'running'
      // cell_id absent — nothing to route the interrupt to.
    });
    assert.equal(resolveInterruptTarget('alpha', SNAPSHOT, lookup), null,
      'frame lacking cell_id → null (command layer warns and no-ops)');
  });

  test('no_in_flight_frame_resolves_null', () => {
    const lookup: ActiveRunFrameLookup = () => null;
    assert.equal(resolveInterruptTarget('alpha', SNAPSHOT, lookup), null,
      'run already completed → null, never throws');
    assert.equal(resolveInterruptTarget('alpha', undefined, lookup), null,
      'undefined snapshot passes through to the lookup safely');
  });

  test('missing_run_id_resolves_target_with_null_run_id', () => {
    const lookup: ActiveRunFrameLookup = () => ({
      cell_id: 'cell-42',
      status: 'running'
    });
    assert.deepEqual(resolveInterruptTarget('alpha', SNAPSHOT, lookup), {
      cellId: 'cell-42',
      runId: null
    });
  });

  test('context_value_helper_gates_running_variant', () => {
    // Base string must match what agents-tree.ts sets today
    // (agents-tree.ts:140) so the package.json `when` clauses key on
    // the same vocabulary.
    assert.equal(isAgentRunningContextValue(false), 'llmnb.sidebar.agent');
    assert.equal(
      isAgentRunningContextValue(true),
      'llmnb.sidebar.agent.running'
    );
  });
});
