// PLAN-S7 §3.6 — Empty-state contract tests.
//
// Each tree must render a helpful "no data" hint rather than crashing
// when its data source is empty. The strings live in
// `extension/src/sidebar/empty-states.ts` so the assertions can pin
// against canonical copy without breaking on phrasing tweaks.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { InMemorySidebarMetadataSource } from '../../src/sidebar/metadata-source.js';
import { ZonesTreeProvider } from '../../src/sidebar/zones-tree.js';
import { AgentsTreeProvider } from '../../src/sidebar/agents-tree.js';
import { ActivityTreeProvider } from '../../src/sidebar/activity-tree.js';
import {
  ZONES_EMPTY,
  AGENTS_EMPTY,
  ACTIVITY_EMPTY
} from '../../src/sidebar/empty-states.js';

suite('contract: PLAN-S7 sidebar empty states', () => {
  test('test_empty_state_no_zones', () => {
    const src = new InMemorySidebarMetadataSource();
    const provider = new ZonesTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
      assert.equal((roots[0] as { message: string }).message, ZONES_EMPTY);
      const item = provider.getTreeItem(roots[0]);
      assert.equal(item.label, ZONES_EMPTY);
      assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_empty_state_no_agents', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      {
        uri: vscode.Uri.parse('file:///w/x.llmnb'),
        label: 'x.llmnb',
        metadata: { zone: { agents: {} } }
      }
    ]);
    const provider = new AgentsTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
      assert.equal((roots[0] as { message: string }).message, AGENTS_EMPTY);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('activity tree renders ACTIVITY_EMPTY when zone has no event log or run frames', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      {
        uri: vscode.Uri.parse('file:///w/x.llmnb'),
        label: 'x.llmnb',
        metadata: { zone: {} }
      }
    ]);
    const provider = new ActivityTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
      assert.equal((roots[0] as { message: string }).message, ACTIVITY_EMPTY);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });
});
