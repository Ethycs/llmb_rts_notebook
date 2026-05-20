// PLAN-S7 §5 — Zones tree contract tests.
//
// Targets the ZonesTreeProvider directly via InMemorySidebarMetadataSource
// so the assertions stay deterministic and decoupled from VS Code's
// notebook-document lifecycle. The provider's getChildren / getTreeItem
// pair are pure functions of the source — these tests exercise that
// surface without spinning up the full extension host wiring.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ZonesTreeProvider } from '../../src/sidebar/zones-tree.js';
import {
  InMemorySidebarMetadataSource,
  type NotebookSnapshot
} from '../../src/sidebar/metadata-source.js';
import type { RtsSnapshot, ZonesNode } from '../../src/sidebar/types.js';
import { ZONES_EMPTY, ZONE_NO_AGENTS, ZONE_NO_SECTIONS } from '../../src/sidebar/empty-states.js';

function makeSnapshot(rts?: RtsSnapshot): NotebookSnapshot {
  return {
    uri: vscode.Uri.parse('file:///workspace/example.llmnb'),
    label: 'example.llmnb',
    metadata: rts
  };
}

function withSnapshot(uri: string, label: string, rts: RtsSnapshot): NotebookSnapshot {
  return { uri: vscode.Uri.parse(uri), label, metadata: rts };
}

suite('contract: PLAN-S7 Zones tree', () => {
  test('test_zones_tree_lists_open_workspaces', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([
      makeSnapshot(),
      withSnapshot('file:///workspace/other.llmnb', 'other.llmnb', {})
    ]);
    const provider = new ZonesTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 2, 'one root node per open llmnb');
      assert.equal(roots[0].kind, 'zone');
      assert.equal(roots[1].kind, 'zone');
      // Tree items should carry the basename as label + iconPath set.
      const first = provider.getTreeItem(roots[0]);
      assert.equal(first.label, 'example.llmnb');
      assert.ok(first.iconPath instanceof vscode.ThemeIcon);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('test_zones_tree_expands_to_agents_and_sections', () => {
    const src = new InMemorySidebarMetadataSource();
    const snapshot: RtsSnapshot = {
      zone: {
        agents: {
          alpha: { session: { runtime_status: 'alive' } }
        },
        sections: {
          'sec_01': { id: 'sec_01', title: 'Architecture', status: 'open', cell_range: ['c1'] }
        }
      }
    };
    src.set([withSnapshot('file:///w/x.llmnb', 'x.llmnb', snapshot)]);
    const provider = new ZonesTreeProvider(src);
    try {
      const [zoneNode] = provider.getChildren() as ZonesNode[];
      assert.equal(zoneNode.kind, 'zone');
      const zoneChildren = provider.getChildren(zoneNode);
      assert.equal(zoneChildren.length, 2);
      assert.equal(zoneChildren[0].kind, 'agents-root');
      assert.equal(zoneChildren[1].kind, 'sections-root');

      const agentsRootChildren = provider.getChildren(zoneChildren[0]);
      assert.equal(agentsRootChildren.length, 1);
      assert.equal(agentsRootChildren[0].kind, 'zone-agent');
      assert.equal(
        (agentsRootChildren[0] as { agentId: string }).agentId,
        'alpha'
      );

      const sectionsRootChildren = provider.getChildren(zoneChildren[1]);
      assert.equal(sectionsRootChildren.length, 1);
      assert.equal(sectionsRootChildren[0].kind, 'zone-section');
      assert.equal(
        (sectionsRootChildren[0] as { sectionId: string }).sectionId,
        'sec_01'
      );

      // The section row description should expose status + member count.
      const sectionItem = provider.getTreeItem(sectionsRootChildren[0]);
      assert.equal(sectionItem.label, 'Architecture');
      assert.equal(sectionItem.description, 'open · 1 cells');
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('zones tree shows empty-state hints when agents or sections are absent', () => {
    const src = new InMemorySidebarMetadataSource();
    src.set([withSnapshot('file:///w/y.llmnb', 'y.llmnb', { zone: {} })]);
    const provider = new ZonesTreeProvider(src);
    try {
      const [zoneNode] = provider.getChildren() as ZonesNode[];
      const [agentsRoot, sectionsRoot] = provider.getChildren(zoneNode);
      const agentsEmpty = provider.getChildren(agentsRoot);
      const sectionsEmpty = provider.getChildren(sectionsRoot);
      assert.equal(agentsEmpty.length, 1);
      assert.equal(agentsEmpty[0].kind, 'empty');
      assert.equal((agentsEmpty[0] as { message: string }).message, ZONE_NO_AGENTS);
      assert.equal(sectionsEmpty.length, 1);
      assert.equal((sectionsEmpty[0] as { message: string }).message, ZONE_NO_SECTIONS);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('zones tree renders ZONES_EMPTY when no .llmnb is open', () => {
    const src = new InMemorySidebarMetadataSource();
    const provider = new ZonesTreeProvider(src);
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
      assert.equal((roots[0] as { message: string }).message, ZONES_EMPTY);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });
});
