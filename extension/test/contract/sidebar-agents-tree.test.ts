// PLAN-S7 §5 — Agents tree contract tests.
//
// AgentsTreeProvider reads from `source.getActiveZone()` (not all zones)
// and surfaces `agents[id].session.*` as detail children. The reveal
// command path uses `agents[id].turns[0].cell_id` per the agent atom
// (the back-reference is written by append_turn per
// metadata_writer.py:1579).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  AgentsTreeProvider,
  firstTurnCellId
} from '../../src/sidebar/agents-tree.js';
import {
  InMemorySidebarMetadataSource,
  type NotebookSnapshot
} from '../../src/sidebar/metadata-source.js';
import type { AgentsNode, RtsSnapshot } from '../../src/sidebar/types.js';
import { REVEAL_CELL_COMMAND_ID } from '../../src/notebook/commands/reveal-cell.js';

function activeWith(rts: RtsSnapshot): NotebookSnapshot {
  return {
    uri: vscode.Uri.parse('file:///workspace/active.llmnb'),
    label: 'active.llmnb',
    metadata: rts
  };
}

suite('contract: PLAN-S7 Agents tree', () => {
  test('test_agents_tree_renders_runtime_status_badge', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          agents: {
            alpha: { session: { runtime_status: 'alive', head_turn_id: 't_01' } },
            beta:  { session: { runtime_status: 'idle', head_turn_id: 't_02' } }
          }
        }
      })
    ]);
    const provider = new AgentsTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 2);
      // Alphabetical order on agent id.
      assert.equal((roots[0] as { agentId: string }).agentId, 'alpha');
      assert.equal((roots[1] as { agentId: string }).agentId, 'beta');

      const aliveItem = provider.getTreeItem(roots[0]);
      assert.equal(aliveItem.label, 'alpha');
      assert.equal(aliveItem.description, 'alive');
      assert.ok(aliveItem.iconPath instanceof vscode.ThemeIcon);
      // The ThemeIcon should carry a ThemeColor — verify it's the alive
      // color (charts.green) by inspecting the public field.
      const aliveIcon = aliveItem.iconPath as vscode.ThemeIcon;
      assert.ok(aliveIcon.color instanceof vscode.ThemeColor);
      assert.equal((aliveIcon.color as { id: string }).id, 'charts.green');

      const idleItem = provider.getTreeItem(roots[1]);
      const idleIcon = idleItem.iconPath as vscode.ThemeIcon;
      assert.equal((idleIcon.color as { id: string }).id, 'charts.blue');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_agents_tree_jump_to_first_cell_command', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          agents: {
            alpha: {
              turns: [
                { id: 't_01', cell_id: 'vscode-notebook-cell:.../#abc', role: 'assistant' }
              ],
              session: { runtime_status: 'idle' }
            }
          }
        }
      })
    ]);
    const provider = new AgentsTreeProvider(src);
    try {
      const [agentNode] = provider.getChildren() as AgentsNode[];
      const item = provider.getTreeItem(agentNode);
      assert.ok(item.command, 'agent node must carry a command for click-through');
      assert.equal(item.command!.command, REVEAL_CELL_COMMAND_ID);
      const args = item.command!.arguments?.[0] as { cell_id?: string };
      assert.equal(args.cell_id, 'vscode-notebook-cell:.../#abc');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_agents_tree_live_updates_on_snapshot', async () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([activeWith({ zone: { agents: {} } })]);
    const provider = new AgentsTreeProvider(src);
    const fires: number[] = [];
    provider.onDidChangeTreeData(() => fires.push(Date.now()));
    try {
      // Before the snapshot lands, the empty-state node is returned.
      let roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');

      src.set([
        activeWith({
          zone: { agents: { alpha: { session: { runtime_status: 'alive' } } } }
        })
      ]);

      // Allow the synchronous fire to land.
      await Promise.resolve();
      assert.ok(fires.length >= 1, 'onDidChangeTreeData should fire');
      roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal((roots[0] as { agentId?: string }).agentId, 'alpha');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('agent session details surface head_turn_id and last_seen_turn_id', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeWith({
        zone: {
          agents: {
            alpha: {
              session: {
                head_turn_id: 't_HEAD',
                last_seen_turn_id: 't_SEEN',
                claude_session_id: 'sess_42',
                runtime_status: 'idle',
                pid: 32856
              }
            }
          }
        }
      })
    ]);
    const provider = new AgentsTreeProvider(src);
    try {
      const [agentNode] = provider.getChildren() as AgentsNode[];
      const details = provider.getChildren(agentNode);
      const labels = details.map((d) =>
        d.kind === 'agent-detail' ? `${d.label}=${d.value}` : 'OTHER'
      );
      assert.deepEqual(labels, [
        'head_turn_id=t_HEAD',
        'last_seen_turn_id=t_SEEN',
        'claude_session_id=sess_42',
        'pid=32856'
      ]);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('firstTurnCellId helper finds the first turn carrying a cell_id', () => {
    assert.equal(
      firstTurnCellId([{ id: 't1' }, { id: 't2', cell_id: 'cell:abc' }]),
      'cell:abc'
    );
    assert.equal(firstTurnCellId(undefined), undefined);
    assert.equal(firstTurnCellId([]), undefined);
    assert.equal(firstTurnCellId([{ id: 't1', cell_id: '' }]), undefined);
  });
});
