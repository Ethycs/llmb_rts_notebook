// PLAN-S10 §3.1 (reduced) — contract tests for the streaming + artifact
// cell status-bar badges.
//
// The pure-compute helper `computeThreePaneBadges` is the load-bearing
// surface; the provider class wraps it for VS Code. We exercise both.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ARTIFACT_BADGE_TEXT,
  STREAMING_BADGE_TEXT,
  ThreePaneBadgeStatusBarProvider,
  computeThreePaneBadges,
  findActiveRunFrame,
  readCellKind
} from '../../src/notebook/three-pane-badges.js';
import {
  InMemorySidebarMetadataSource,
  type NotebookSnapshot
} from '../../src/sidebar/metadata-source.js';
import type { RtsSnapshot } from '../../src/sidebar/types.js';

const NOTEBOOK_TYPE = 'llmnb';

async function newNotebook(): Promise<vscode.NotebookDocument> {
  const code = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    '@@spawn alpha task:"do thing"',
    'llmnb-cell'
  );
  const markup = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Markup,
    '# Heading',
    'markdown'
  );
  const data = new vscode.NotebookData([code, markup]);
  return vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
}

function activeSnapshot(uri: vscode.Uri, rts: RtsSnapshot): NotebookSnapshot {
  return { uri, label: 'x.llmnb', metadata: rts };
}

suite('contract: PLAN-S10 three-pane badges', () => {
  test('test_streaming_decoration_active_during_run', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const cell = nb.cellAt(0);
    const snapshot: RtsSnapshot = {
      zone: {
        run_frames: {
          r1: {
            run_id: 'r1',
            cell_id: cell.document.uri.toString(),
            executor_id: 'alpha',
            status: 'running',
            started_at: '2026-05-19T00:00:00Z',
            ended_at: null
          }
        }
      }
    };
    const { streaming, artifact } = computeThreePaneBadges(cell, snapshot);
    assert.equal(streaming, true);
    assert.equal(artifact, false);
  });

  test('streaming flag is false once the RunFrame transitions to a terminal status', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const cell = nb.cellAt(0);
    const snapshot: RtsSnapshot = {
      zone: {
        run_frames: {
          r1: {
            run_id: 'r1',
            cell_id: cell.document.uri.toString(),
            executor_id: 'alpha',
            status: 'complete',
            started_at: '2026-05-19T00:00:00Z',
            ended_at: '2026-05-19T00:00:05Z'
          }
        }
      }
    };
    const { streaming } = computeThreePaneBadges(cell, snapshot);
    assert.equal(streaming, false);
  });

  test('test_artifact_cell_badge_renders', async function (): Promise<void> {
    this.timeout(15000);
    const data = new vscode.NotebookData([
      Object.assign(
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'artifact body', 'llmnb-cell'),
        { metadata: { rts: { cell: { kind: 'artifact' } } } }
      )
    ]);
    const nb = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
    const { streaming, artifact } = computeThreePaneBadges(nb.cellAt(0), {});
    assert.equal(streaming, false);
    assert.equal(artifact, true);
  });

  test('test_current_cell_focused_decoration_is_handled_natively', async function (): Promise<void> {
    // V1 reality (PLAN-S10 (reduced) §"Out of scope"): VS Code's notebook
    // editor highlights the focused cell natively. The provider MUST NOT
    // add a "current" badge — adding one would duplicate the native cue
    // and clutter the right side. This test pins that decision against
    // future "let's add a current badge" drift.
    this.timeout(15000);
    const nb = await newNotebook();
    const result = computeThreePaneBadges(nb.cellAt(0), {});
    // Neither flag fires for an unselected, non-streaming, non-artifact cell.
    assert.deepEqual(result, { streaming: false, artifact: false });
  });

  test('markup cells never receive a streaming or artifact badge', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    // Cell 1 is the Markup cell.
    const markup = nb.cellAt(1);
    const snapshot: RtsSnapshot = {
      zone: {
        run_frames: {
          r1: {
            run_id: 'r1',
            cell_id: markup.document.uri.toString(),
            status: 'running',
            started_at: '2026-05-19T00:00:00Z'
          }
        }
      }
    };
    const { streaming, artifact } = computeThreePaneBadges(markup, snapshot);
    assert.equal(streaming, false);
    assert.equal(artifact, false);
  });

  test('findActiveRunFrame matches across candidate id forms', () => {
    const rf = findActiveRunFrame(
      ['cell:metadata-id', 'vscode-notebook-cell:/file.llmnb#abc'],
      {
        r1: {
          run_id: 'r1',
          cell_id: 'cell:metadata-id',
          status: 'running',
          started_at: '2026-05-19T00:00:00Z',
          ended_at: null
        },
        r2: {
          run_id: 'r2',
          cell_id: 'cell:other',
          status: 'running',
          started_at: '2026-05-19T00:00:00Z'
        }
      }
    );
    assert.ok(rf);
    assert.equal(rf!.run_id, 'r1');
  });

  test('readCellKind honors the namespaced metadata.rts.cell.kind slot', () => {
    const cell = {
      metadata: { rts: { cell: { kind: 'artifact' } } }
    } as unknown as vscode.NotebookCell;
    assert.equal(readCellKind(cell), 'artifact');
  });

  test('readCellKind falls back to legacy flat metadata.rts.kind', () => {
    const cell = {
      metadata: { rts: { kind: 'section' } }
    } as unknown as vscode.NotebookCell;
    assert.equal(readCellKind(cell), 'section');
  });

  test('provider returns no items when the cell belongs to an inactive notebook', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const cell = nb.cellAt(0);
    const src = new InMemorySidebarMetadataSource();
    // Set an active zone pointing at a DIFFERENT URI than the cell's
    // notebook — emulates the operator looking at notebook A while
    // notebook B has an active run.
    src.set([
      activeSnapshot(vscode.Uri.parse('file:///workspace/different.llmnb'), {
        zone: {
          run_frames: {
            r1: {
              run_id: 'r1',
              cell_id: cell.document.uri.toString(),
              status: 'running',
              started_at: '2026-05-19T00:00:00Z'
            }
          }
        }
      })
    ]);
    const provider = new ThreePaneBadgeStatusBarProvider(src);
    try {
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      );
      assert.equal(items.length, 0);
    } finally {
      provider.dispose();
      src.dispose();
    }
  });

  test('provider materialises STREAMING_BADGE_TEXT for an active in-flight cell', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await newNotebook();
    const cell = nb.cellAt(0);
    const src = new InMemorySidebarMetadataSource();
    src.set([
      activeSnapshot(cell.notebook.uri, {
        zone: {
          run_frames: {
            r1: {
              run_id: 'r1',
              cell_id: cell.document.uri.toString(),
              status: 'running',
              started_at: '2026-05-19T00:00:00Z'
            }
          }
        }
      })
    ]);
    const provider = new ThreePaneBadgeStatusBarProvider(src);
    try {
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      );
      const texts = items.map((i) => i.text);
      assert.ok(texts.includes(STREAMING_BADGE_TEXT), `expected streaming badge; got ${JSON.stringify(texts)}`);
      assert.ok(!texts.includes(ARTIFACT_BADGE_TEXT));
    } finally {
      provider.dispose();
      src.dispose();
    }
  });
});
