// BSP-008 Inspect mode — contract test for the per-cell status-bar provider.
//
// Exercises `InspectCellStatusBarProvider.provideCellStatusBarItems` with
// a fake NotebookCell + the in-memory metadata source. Pure-stub-kernel
// territory: no live kernel, no notebook editor open.
//
// Spec references:
//   docs/notebook/BSP-008-contextpacker-runframes.md §11 — Inspect-mode minimum
//   atoms/concepts/run-frame.md / atoms/concepts/context-manifest.md

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  InspectCellStatusBarProvider,
  RouterBackedInspectMetadataSource
} from '../../src/inspect/cell-status-provider.js';
import {
  OPEN_MANIFEST_DETAIL_COMMAND_ID
} from '../../src/inspect/manifest-detail-view.js';
import type { NotebookMetadataLike } from '../../src/inspect/run-frame-reader.js';

interface FakeCell {
  kind: vscode.NotebookCellKind;
  outputs: vscode.NotebookCellOutput[];
  metadata: Record<string, unknown>;
  index: number;
  notebook: vscode.NotebookDocument;
  document: vscode.TextDocument;
  executionSummary?: vscode.NotebookCellExecutionSummary;
}

function fakeCell(opts: {
  kind?: vscode.NotebookCellKind;
  metadata?: Record<string, unknown>;
  uri?: string;
  notebookUri?: string;
}): vscode.NotebookCell {
  const cellUri = opts.uri ?? 'cell:c1';
  const docUri = vscode.Uri.parse(cellUri);
  // We need a document.uri.toString() returning a stable string. The real
  // VS Code TextDocument carries more surface; the badge code only ever
  // reads `document.uri`.
  const fakeDoc = { uri: docUri } as unknown as vscode.TextDocument;
  const nbUri = opts.notebookUri ?? 'untitled:Untitled-1';
  const fakeNb = {
    uri: vscode.Uri.parse(nbUri),
    notebookType: 'llmnb'
  } as unknown as vscode.NotebookDocument;
  const cell: FakeCell = {
    kind: opts.kind ?? vscode.NotebookCellKind.Code,
    outputs: [],
    metadata: opts.metadata ?? {},
    index: 0,
    notebook: fakeNb,
    document: fakeDoc
  };
  return cell as unknown as vscode.NotebookCell;
}

function metadataWith(args: {
  run_frames?: Record<string, unknown>;
  context_manifests?: Record<string, unknown>;
}): NotebookMetadataLike {
  return {
    rts: {
      zone: {
        run_frames: args.run_frames,
        context_manifests: args.context_manifests
      }
    }
  };
}

suite('contract: BSP-008 Inspect — cell-status-bar provider', () => {

  test('test_status_item_renders_for_cell_with_recorded_run', () => {
    // Fixture: a cell whose URI matches a recorded RunFrame.
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1',
          cell_id: 'cell:c1',
          executor_id: 'alpha',
          context_manifest_id: 'm1',
          status: 'complete',
          started_at: '2026-04-28T12:00:00Z',
          ended_at: '2026-04-28T12:00:05Z'
        }
      },
      context_manifests: {
        'm1': {
          manifest_id: 'm1',
          cell_id: 'cell:c1',
          inclusion_rules_applied: [
            { rule: 'pinned', cells: ['cell:c1'] }
          ],
          exclusions_applied: [],
          generated_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const source = new RouterBackedInspectMetadataSource();
    source.setSnapshot(meta);
    const provider = new InspectCellStatusBarProvider(source);
    try {
      const cell = fakeCell({ uri: 'cell:c1' });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 1, 'cell with a run frame must surface ONE inspect item');
      assert.match(items[0].text, /\(complete\)/, 'status text must include status word');
      // Click target must be `llmnb.inspect.openManifestDetail` per package.json.
      const cmd = items[0].command as vscode.Command;
      assert.equal(cmd.command, OPEN_MANIFEST_DETAIL_COMMAND_ID);
      assert.equal(
        items[0].alignment,
        vscode.NotebookCellStatusBarAlignment.Right,
        'inspect badge sits on the right (left is reserved for the agent badge)'
      );
      // Args carry the cell+manifest+run ids so the click target can
      // hydrate the detail QuickPick without re-deriving.
      const args = (cmd.arguments ?? [])[0] as {
        cell_id: string; manifest_id: string; run_id: string;
      };
      assert.equal(args.cell_id, 'cell:c1');
      assert.equal(args.manifest_id, 'm1');
      assert.equal(args.run_id, 'r1');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('test_status_item_skipped_for_markdown_cells', () => {
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'cell:c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'complete',
          started_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const source = new RouterBackedInspectMetadataSource();
    source.setSnapshot(meta);
    const provider = new InspectCellStatusBarProvider(source);
    try {
      const cell = fakeCell({
        uri: 'cell:c1',
        kind: vscode.NotebookCellKind.Markup
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0,
        'markdown cells never carry runs — no inspect badge');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('test_status_item_skipped_when_cell_has_no_runs', () => {
    const source = new RouterBackedInspectMetadataSource();
    source.setSnapshot(metadataWith({}));
    const provider = new InspectCellStatusBarProvider(source);
    try {
      const cell = fakeCell({ uri: 'cell:no-runs' });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0);
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('test_metadata_change_event_fires_provider_change', () => {
    // The provider re-fires its onDidChangeCellStatusBarItems whenever
    // the source's onDidChange fires. This is the path that refreshes
    // the badge when a new RunFrame lands.
    const source = new RouterBackedInspectMetadataSource();
    const provider = new InspectCellStatusBarProvider(source);
    try {
      let providerEvents = 0;
      const sub = provider.onDidChangeCellStatusBarItems(() => {
        providerEvents += 1;
      });
      source.setSnapshot(metadataWith({}));
      assert.equal(providerEvents, 1,
        'first snapshot must propagate to the provider');
      source.setSnapshot(metadataWith({
        run_frames: {
          'r1': {
            run_id: 'r1', cell_id: 'cell:c1', executor_id: 'alpha',
            context_manifest_id: 'm1', status: 'complete',
            started_at: '2026-04-28T12:00:00Z'
          }
        }
      }));
      assert.equal(providerEvents, 2,
        'each snapshot fires one provider event');
      sub.dispose();
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('test_router_metadata_observer_captures_snapshot', () => {
    // The metadata source is a NotebookMetadataObserver; verify the
    // onNotebookMetadata path captures the snapshot and exposes it.
    const source = new RouterBackedInspectMetadataSource();
    try {
      source.onNotebookMetadata({
        mode: 'snapshot',
        snapshot_version: 1,
        snapshot: {
          schema_version: '1.0.0',
          zone: {
            run_frames: {
              'r1': {
                run_id: 'r1', cell_id: 'cell:c1', executor_id: 'alpha',
                context_manifest_id: 'm1', status: 'complete',
                started_at: '2026-04-28T12:00:00Z'
              }
            }
          }
        }
      });
      const captured = source.getMetadataFor('any-uri');
      assert.ok(captured, 'snapshot must populate the cache');
      // The wrap is `{ rts: <snapshot> }` so the readers' lookup paths work.
      assert.ok(captured!.rts, 'snapshot is stored under .rts');
      assert.ok(
        (captured!.rts as { zone?: { run_frames?: object } }).zone?.run_frames,
        'zone.run_frames is reachable'
      );
    } finally {
      source.dispose();
    }
  });

  test('test_hydrate_payloads_are_ignored_by_source', () => {
    // The metadata source only consumes `mode: "snapshot"` payloads; the
    // hydrate / patch envelopes are out-of-band and MUST NOT mutate the
    // cache (matches the metadata-applier's W7/W8 discipline).
    const source = new RouterBackedInspectMetadataSource();
    try {
      // Hydrate (extension-emitted, kernel-side handler).
      source.onNotebookMetadata({
        mode: 'hydrate',
        snapshot_version: 1,
        snapshot: { schema_version: '1.0.0' }
      });
      assert.equal(source.getMetadataFor('any'), undefined,
        'hydrate envelope MUST NOT populate the read-side cache');
      // Patch (V1.5+, V1 ignores).
      source.onNotebookMetadata({
        mode: 'patch',
        snapshot_version: 1,
        patch: []
      });
      assert.equal(source.getMetadataFor('any'), undefined,
        'patch envelope (V1.5+) MUST NOT populate the read-side cache');
    } finally {
      source.dispose();
    }
  });
});
