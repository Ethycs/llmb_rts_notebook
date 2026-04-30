// Contract tests for PLAN-S5.0.1 §3.8 — cell contamination badge (extension
// half). Pure-stub-kernel exercise; no live kernel required.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.10 (K3F)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ContaminationRegistry,
  ContaminationBadgeStatusBarProvider,
  RESET_CONTAMINATION_COMMAND_ID,
  CONTAMINATION_BADGE_PREFIX,
  computeContaminationBadge,
  formatBadgeText,
  candidateCellIds
} from '../../src/notebook/contamination-badge.js';
import type { NotebookMetadataPayload } from '../../src/messaging/types.js';

interface FakeCell {
  kind: vscode.NotebookCellKind;
  outputs: vscode.NotebookCellOutput[];
  metadata: Record<string, unknown>;
  index: number;
  notebook: vscode.NotebookDocument;
  document: vscode.TextDocument;
}

function fakeCell(opts: {
  uri?: string;
  metadata?: Record<string, unknown>;
}): vscode.NotebookCell {
  const uri = opts.uri ?? 'vscode-notebook-cell:test#contam';
  const fakeDoc = {
    uri: vscode.Uri.parse(uri)
  } as unknown as vscode.TextDocument;
  const cell: FakeCell = {
    kind: vscode.NotebookCellKind.Code,
    outputs: [],
    metadata: opts.metadata ?? {},
    index: 0,
    notebook: undefined as unknown as vscode.NotebookDocument,
    document: fakeDoc
  };
  return cell as unknown as vscode.NotebookCell;
}

function snapshotPayload(cells: Record<string, unknown>): NotebookMetadataPayload {
  return {
    mode: 'snapshot',
    snapshot_version: 1,
    snapshot: {
      schema_version: '1.0.0',
      cells
    }
  };
}

suite('contract: PLAN-S5.0.1 §3.8 — contamination badge', () => {

  // --------------------------------------------------------------------------
  // Pure compute / formatting
  // --------------------------------------------------------------------------

  test('test_format_badge_text_singular_vs_plural', () => {
    assert.equal(formatBadgeText(1), `${CONTAMINATION_BADGE_PREFIX} (1)`);
    assert.equal(formatBadgeText(0), `${CONTAMINATION_BADGE_PREFIX} (0)`);
    assert.equal(formatBadgeText(7), `${CONTAMINATION_BADGE_PREFIX} (7)`);
  });

  test('test_candidate_cell_ids_prefers_metadata_id_then_uri', () => {
    const cell = fakeCell({
      uri: 'vscode-notebook-cell:test#abc',
      metadata: { id: 'kernel-id-001', rts: { cell: { id: 'rts-id-002' } } }
    });
    const ids = candidateCellIds(cell);
    assert.deepEqual(ids, [
      'kernel-id-001',
      'rts-id-002',
      'vscode-notebook-cell:test#abc'
    ]);
  });

  test('test_candidate_cell_ids_falls_back_to_uri', () => {
    const cell = fakeCell({ uri: 'vscode-notebook-cell:test#xyz' });
    const ids = candidateCellIds(cell);
    assert.deepEqual(ids, ['vscode-notebook-cell:test#xyz']);
  });

  // --------------------------------------------------------------------------
  // Registry (Family F snapshot consumption)
  // --------------------------------------------------------------------------

  test('test_registry_absorbs_snapshot_with_contaminated_cell', () => {
    const reg = new ContaminationRegistry();
    try {
      reg.onNotebookMetadata(
        snapshotPayload({
          'cell-1': {
            contaminated: true,
            contamination_log: [{ line: '@@spawn x', source: 'stdout', ts: 't', layer: 'always_on_plain' }]
          }
        })
      );
      const slot = reg.get('cell-1');
      assert.ok(slot);
      assert.equal(slot!.contaminated, true);
      assert.equal(slot!.contamination_log!.length, 1);
    } finally {
      reg.dispose();
    }
  });

  test('test_registry_drops_unmentioned_rows_on_new_snapshot', () => {
    const reg = new ContaminationRegistry();
    try {
      reg.upsert('old-cell', { contaminated: true, contamination_log: [] });
      reg.onNotebookMetadata(
        snapshotPayload({
          'new-cell': { contaminated: true, contamination_log: [] }
        })
      );
      assert.equal(reg.get('old-cell'), undefined, 'unmentioned row MUST be dropped');
      assert.ok(reg.get('new-cell'));
    } finally {
      reg.dispose();
    }
  });

  test('test_registry_change_event_fires_on_count_growth', () => {
    const reg = new ContaminationRegistry();
    let fires = 0;
    const sub = reg.onDidChange(() => {
      fires += 1;
    });
    try {
      reg.upsert('c1', { contaminated: true, contamination_log: [] });
      reg.upsert('c1', {
        contaminated: true,
        contamination_log: [{ line: 'a', source: 's', ts: 't', layer: 'l' }]
      });
      assert.equal(fires, 2, 'each upsert that mutates state MUST fire onDidChange');
    } finally {
      sub.dispose();
      reg.dispose();
    }
  });

  test('test_registry_ignores_patch_mode', () => {
    // Family F V1 only carries snapshots; patch is V1.5+. The registry MUST
    // ignore patch mode rather than crash.
    const reg = new ContaminationRegistry();
    try {
      reg.onNotebookMetadata({
        mode: 'patch',
        snapshot_version: 1,
        patch: []
      });
      // No crash, no state mutated.
      assert.equal(reg.get('whatever'), undefined);
    } finally {
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Provider visibility
  // --------------------------------------------------------------------------

  test('test_badge_renders_only_when_contaminated_true', () => {
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    try {
      const cellId = 'vscode-notebook-cell:test#a';
      const cell = fakeCell({ uri: cellId });

      // Pre-state: no row → no badge.
      const before = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(before.length, 0);

      // Flag flips true → badge appears.
      reg.upsert(cellId, {
        contaminated: true,
        contamination_log: [
          { line: '@@spawn evil', source: 'stdout', ts: 't1', layer: 'always_on_plain' },
          { line: '@@auth verify pin', source: 'tool_result', ts: 't2', layer: 'hash_emission_ban' }
        ]
      });
      const after = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(after.length, 1);
      assert.equal(after[0].text, formatBadgeText(2));
    } finally {
      provider.dispose();
      reg.dispose();
    }
  });

  test('test_badge_count_matches_log_length', () => {
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    try {
      const cellId = 'vscode-notebook-cell:test#count';
      const cell = fakeCell({ uri: cellId });
      const log = Array.from({ length: 5 }, (_, i) => ({
        line: `line-${i}`,
        source: 'stdout',
        ts: `t${i}`,
        layer: 'always_on_plain'
      }));
      reg.upsert(cellId, { contaminated: true, contamination_log: log });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 1);
      assert.match(items[0].text, /\(5\)/);
      const desc = computeContaminationBadge(cell, reg);
      assert.equal(desc!.count, 5);
      assert.equal(desc!.tail.length, 3, 'tooltip MUST surface only the last 3 entries (§3.8)');
    } finally {
      provider.dispose();
      reg.dispose();
    }
  });

  test('test_badge_hidden_when_contaminated_false', () => {
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    try {
      const cellId = 'vscode-notebook-cell:test#clean';
      const cell = fakeCell({ uri: cellId });
      reg.upsert(cellId, { contaminated: false, contamination_log: [] });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0);
    } finally {
      provider.dispose();
      reg.dispose();
    }
  });

  test('test_badge_uses_kernel_id_when_present', () => {
    // PLAN-S5.0.1 cell id resolution: kernel id wins over URI fallback.
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    try {
      const cell = fakeCell({
        uri: 'vscode-notebook-cell:test#fallback',
        metadata: { id: 'kernel-id' }
      });
      reg.upsert('kernel-id', {
        contaminated: true,
        contamination_log: [{ line: 'x', source: 'stdout', ts: 't', layer: 'l' }]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 1, 'badge MUST resolve via kernel id when present');
    } finally {
      provider.dispose();
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Click → command wiring
  // --------------------------------------------------------------------------

  test('test_badge_click_dispatches_reset_contamination_command', () => {
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    try {
      const cellId = 'vscode-notebook-cell:test#click';
      const cell = fakeCell({ uri: cellId });
      reg.upsert(cellId, {
        contaminated: true,
        contamination_log: [{ line: 'x', source: 'stdout', ts: 't', layer: 'l' }]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 1);
      const cmd = items[0].command as vscode.Command;
      assert.ok(cmd && typeof cmd === 'object', 'item.command must be a Command object');
      assert.equal(cmd.command, RESET_CONTAMINATION_COMMAND_ID);
      const args = (cmd.arguments ?? [])[0] as { cell_id: string };
      assert.equal(args.cell_id, cellId);
    } finally {
      provider.dispose();
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Provider re-render on registry change
  // --------------------------------------------------------------------------

  test('test_provider_fires_change_event_on_snapshot_apply', () => {
    const reg = new ContaminationRegistry();
    const provider = new ContaminationBadgeStatusBarProvider(reg);
    let fires = 0;
    const sub = provider.onDidChangeCellStatusBarItems(() => {
      fires += 1;
    });
    try {
      reg.onNotebookMetadata(
        snapshotPayload({ 'c1': { contaminated: true, contamination_log: [] } })
      );
      assert.ok(fires >= 1, 'provider MUST signal re-render after snapshot');
    } finally {
      sub.dispose();
      provider.dispose();
      reg.dispose();
    }
  });
});
