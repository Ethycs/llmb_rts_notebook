// PLAN-S7 §5 — Activity tree contract tests.
//
// The synthesizer maps three sources into seven entry types:
//   1. Legacy `agent_ref_move` records in zone.event_log[]
//   2. Captured `operator.action` envelopes in zone.event_log[]
//   3. zone.run_frames.* timestamps (run_start / run_end)
//
// Pure synthesizer tests + a small set of provider tests that exercise
// the TreeItem command wiring and the reverse-chronological sort.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ActivityTreeProvider,
  classifyEventLogEntry,
  classifyRunFrame,
  synthesizeActivity
} from '../../src/sidebar/activity-tree.js';
import {
  InMemorySidebarMetadataSource,
  type NotebookSnapshot
} from '../../src/sidebar/metadata-source.js';
import type { ActivityNode, RtsSnapshot } from '../../src/sidebar/types.js';
import { REVEAL_CELL_COMMAND_ID } from '../../src/notebook/commands/reveal-cell.js';

function activeWith(rts: RtsSnapshot): NotebookSnapshot {
  return {
    uri: vscode.Uri.parse('file:///workspace/active.llmnb'),
    label: 'active.llmnb',
    metadata: rts
  };
}

suite('contract: PLAN-S7 Activity tree', () => {
  test('test_activity_tree_chronological_order', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          event_log: [
            // Legacy revert at 2026-01-01.
            {
              kind: 'agent_ref_move',
              reason: 'operator_revert',
              agent_id: 'alpha',
              from_turn_id: 't_OLD',
              to_turn_id: 't_NEW',
              recorded_at: '2026-01-01T00:00:00Z'
            },
            // Captured spawn at 2026-03-01.
            {
              message_type: 'operator.action',
              created_at: '2026-03-01T00:00:00Z',
              payload: {
                action_type: 'agent_spawn',
                parameters: { agent_id: 'beta' },
                originating_cell_id: 'cell:spawn-beta'
              }
            }
          ]
        }
      })
    ]);
    const provider = new ActivityTreeProvider(src);
    try {
      const nodes = provider.getChildren();
      assert.ok(nodes.length >= 2);
      // Most-recent first.
      assert.equal(nodes[0].kind, 'entry');
      const top = (nodes[0] as { entry: { entry_type: string; label: string } }).entry;
      assert.equal(top.entry_type, 'agent_spawn');
      assert.equal(top.label, 'spawn beta');
      const second = (nodes[1] as { entry: { entry_type: string } }).entry;
      assert.equal(second.entry_type, 'agent_revert');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_activity_tree_click_reveals_cell', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          event_log: [
            {
              message_type: 'operator.action',
              created_at: '2026-05-19T12:00:00Z',
              payload: {
                action_type: 'agent_spawn',
                parameters: { agent_id: 'alpha' },
                originating_cell_id: 'cell:spawn-alpha'
              }
            }
          ]
        }
      })
    ]);
    const provider = new ActivityTreeProvider(src);
    try {
      const [first] = provider.getChildren() as ActivityNode[];
      assert.equal(first.kind, 'entry');
      const item = provider.getTreeItem(first);
      assert.ok(item.command);
      assert.equal(item.command!.command, REVEAL_CELL_COMMAND_ID);
      const args = item.command!.arguments?.[0] as { cell_id?: string };
      assert.equal(args.cell_id, 'cell:spawn-alpha');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_activity_tree_includes_run_frames', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          run_frames: {
            r1: {
              run_id: 'r1',
              cell_id: 'cell:run-1',
              executor_id: 'alpha',
              status: 'completed',
              started_at: '2026-05-19T10:00:00Z',
              ended_at: '2026-05-19T10:00:05Z'
            },
            r2: {
              run_id: 'r2',
              cell_id: 'cell:run-2',
              executor_id: 'beta',
              status: 'running',
              started_at: '2026-05-19T10:01:00Z',
              ended_at: null
            }
          }
        }
      })
    ]);
    const provider = new ActivityTreeProvider(src);
    try {
      const nodes = provider.getChildren();
      const types = nodes
        .filter((n) => n.kind === 'entry')
        .map((n) => (n as { entry: { entry_type: string } }).entry.entry_type);
      // r1 produces both start + end; r2 produces start only.
      assert.equal(types.filter((t) => t === 'run_start').length, 2);
      assert.equal(types.filter((t) => t === 'run_end').length, 1);
      // Most-recent first means r2 start (10:01) > r1 end (10:00:05) > r1 start (10:00).
      const ordered = nodes
        .filter((n) => n.kind === 'entry')
        .map((n) => (n as { entry: { run_id?: string; entry_type: string; label: string } }).entry);
      assert.equal(ordered[0].entry_type, 'run_start'); // r2 most recent
      assert.ok(ordered[0].label.includes('r2'));
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('synthesizer classifies envelope operator.action[zone_mutate fork_agent] as agent_branch', () => {
    const e = classifyEventLogEntry({
      message_type: 'operator.action',
      created_at: '2026-04-01T00:00:00Z',
      payload: {
        action_type: 'zone_mutate',
        parameters: { intent_kind: 'fork_agent' },
        originating_cell_id: 'cell:branch'
      }
    });
    assert.ok(e);
    assert.equal(e!.entry_type, 'agent_branch');
    assert.equal(e!.cell_id, 'cell:branch');
  });

  test('synthesizer routes envelope move_agent_head cause=revert to agent_revert', () => {
    const e = classifyEventLogEntry({
      message_type: 'operator.action',
      created_at: '2026-04-02T00:00:00Z',
      payload: {
        action_type: 'zone_mutate',
        parameters: { intent_kind: 'move_agent_head', cause: 'revert' } as Record<string, unknown>,
        originating_cell_id: 'cell:revert'
      }
    });
    assert.ok(e);
    assert.equal(e!.entry_type, 'agent_revert');
  });

  test('classifyRunFrame returns one entry when ended_at is missing', () => {
    const entries = classifyRunFrame({
      run_id: 'r1',
      started_at: '2026-05-19T00:00:00Z',
      ended_at: null
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entry_type, 'run_start');
  });

  test('synthesizeActivity tolerates missing zone gracefully', () => {
    assert.deepEqual(synthesizeActivity({}), []);
    assert.deepEqual(synthesizeActivity({ zone: {} }), []);
  });

  test('load-more node appears once visible cap is exceeded', () => {
    const src = new InMemorySidebarMetadataSource();
    // 3 run frames produce up to 6 entries (start + end each).
    const runFrames: Record<string, { run_id: string; started_at: string; ended_at: string; cell_id: string; status: string }> = {};
    for (let i = 0; i < 3; i += 1) {
      runFrames[`r${i}`] = {
        run_id: `r${i}`,
        cell_id: `cell:${i}`,
        status: 'completed',
        started_at: `2026-05-19T10:0${i}:00Z`,
        ended_at: `2026-05-19T10:0${i}:05Z`
      };
    }
    src.set([activeWith({ zone: { run_frames: runFrames } })]);
    const provider = new ActivityTreeProvider(src);
    provider.maxVisible = 4; // force overflow
    try {
      const nodes = provider.getChildren();
      // 4 entries + load-more sentinel = 5 total.
      assert.equal(nodes.length, 5);
      assert.equal(nodes[nodes.length - 1].kind, 'load-more');
      const item = provider.getTreeItem(nodes[nodes.length - 1]);
      assert.equal(item.command?.command, 'llmnb.sidebar.activity.loadMore');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });
});
