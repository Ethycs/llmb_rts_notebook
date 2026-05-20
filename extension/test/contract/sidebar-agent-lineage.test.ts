// V2 branch-switching UX — pure-unit tests for the lineage builder.
//
// `buildAgentLineage` is the load-bearing pure function; the Agents
// tree just renders against the maps it returns. We pin the
// extraction logic and the sort against representative event_log
// shapes (the legacy `agent_ref_move` shape we ignore; the post-S6.0
// envelope shape we DO extract).

import * as assert from 'node:assert/strict';
import {
  buildAgentLineage,
  extractForkRecord,
  rootAgentIds
} from '../../src/sidebar/agent-lineage.js';
import type { RtsSnapshot } from '../../src/sidebar/types.js';

function forkEnvelope(opts: {
  source: string;
  branch: string;
  at?: string | null;
  case?: 'A' | 'B';
  createdAt?: string;
}): Record<string, unknown> {
  return {
    message_type: 'operator.action',
    created_at: opts.createdAt ?? '2026-05-19T12:00:00Z',
    payload: {
      action_type: 'zone_mutate',
      parameters: {
        intent_kind: 'fork_agent',
        source_agent_id: opts.source,
        new_agent_id: opts.branch,
        at_turn_id: opts.at ?? null,
        case: opts.case ?? 'A'
      }
    }
  };
}

suite('contract: V2 branch-switching agent-lineage', () => {
  test('buildAgentLineage returns empty maps for an empty snapshot', () => {
    const lineage = buildAgentLineage(undefined);
    assert.equal(lineage.parents.size, 0);
    assert.equal(lineage.children.size, 0);
  });

  test('buildAgentLineage indexes a single fork in both directions', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          forkEnvelope({ source: 'alpha', branch: 'alpha-b', case: 'B' }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    const parent = lineage.parents.get('alpha-b');
    assert.ok(parent);
    assert.equal(parent!.sourceAgentId, 'alpha');
    assert.equal(parent!.case, 'B');
    const children = lineage.children.get('alpha');
    assert.ok(children);
    assert.equal(children!.length, 1);
    assert.equal(children![0].branchAgentId, 'alpha-b');
  });

  test('legacy agent_ref_move records are ignored', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          {
            kind: 'agent_ref_move',
            reason: 'operator_revert',
            agent_id: 'alpha',
            from_turn_id: 't_old',
            to_turn_id: 't_new',
            recorded_at: '2026-04-01T00:00:00Z'
          },
          forkEnvelope({ source: 'alpha', branch: 'alpha-b' }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    // Only the fork envelope contributes.
    assert.equal(lineage.parents.size, 1);
    assert.ok(lineage.parents.has('alpha-b'));
  });

  test('extractForkRecord rejects non-fork envelopes', () => {
    // Non-operator.action message
    assert.equal(
      extractForkRecord({ message_type: 'layout.update', payload: {} } as never),
      undefined
    );
    // operator.action but non-zone_mutate action
    assert.equal(
      extractForkRecord({
        message_type: 'operator.action',
        payload: { action_type: 'agent_spawn', parameters: {} }
      } as never),
      undefined
    );
    // zone_mutate but non-fork intent
    assert.equal(
      extractForkRecord({
        message_type: 'operator.action',
        payload: {
          action_type: 'zone_mutate',
          parameters: { intent_kind: 'move_agent_head' }
        }
      } as never),
      undefined
    );
    // fork_agent missing required ids
    assert.equal(
      extractForkRecord({
        message_type: 'operator.action',
        payload: {
          action_type: 'zone_mutate',
          parameters: { intent_kind: 'fork_agent', source_agent_id: 'alpha' }
        }
      } as never),
      undefined
    );
  });

  test('children buckets sort by capture time ascending', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          forkEnvelope({
            source: 'alpha',
            branch: 'late',
            createdAt: '2026-05-19T15:00:00Z'
          }) as never,
          forkEnvelope({
            source: 'alpha',
            branch: 'early',
            createdAt: '2026-05-19T10:00:00Z'
          }) as never,
          forkEnvelope({
            source: 'alpha',
            branch: 'middle',
            createdAt: '2026-05-19T12:00:00Z'
          }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    const ids = lineage.children.get('alpha')!.map((r) => r.branchAgentId);
    assert.deepEqual(ids, ['early', 'middle', 'late']);
  });

  test('forks with no timestamp sort last among siblings', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          { ...forkEnvelope({ source: 'alpha', branch: 'no-ts' }), created_at: undefined } as never,
          forkEnvelope({
            source: 'alpha',
            branch: 'first',
            createdAt: '2026-05-19T10:00:00Z'
          }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    const ids = lineage.children.get('alpha')!.map((r) => r.branchAgentId);
    assert.deepEqual(ids, ['first', 'no-ts']);
  });

  test('rootAgentIds filters out agents that appear as branches', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          forkEnvelope({ source: 'alpha', branch: 'alpha-b' }) as never,
          forkEnvelope({ source: 'alpha-b', branch: 'alpha-b-c' }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    // The agent map has three entries; only 'alpha' is a true root.
    const roots = rootAgentIds(['alpha', 'alpha-b', 'alpha-b-c'], lineage);
    assert.deepEqual(roots, ['alpha']);
  });

  test('duplicate fork envelope for same branch keeps the first record', () => {
    const snapshot: RtsSnapshot = {
      zone: {
        event_log: [
          forkEnvelope({
            source: 'alpha',
            branch: 'alpha-b',
            case: 'A',
            createdAt: '2026-05-19T10:00:00Z'
          }) as never,
          forkEnvelope({
            source: 'alpha',
            branch: 'alpha-b',
            case: 'B',
            createdAt: '2026-05-19T11:00:00Z'
          }) as never
        ]
      }
    };
    const lineage = buildAgentLineage(snapshot);
    assert.equal(lineage.parents.get('alpha-b')?.case, 'A');
  });
});
