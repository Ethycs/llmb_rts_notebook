// BSP-008 Inspect mode — unit tests for the per-cell status item compute.
//
// FSP-003 Pillar C T0: pure-module tests, no vscode. We exercise
// `computeInspectCellStatus` directly. The vscode-bound provider class
// (InspectCellStatusBarProvider) is covered by the contract tier so the
// real `NotebookCellStatusBarItem` constructor path is exercised.

import * as assert from 'node:assert/strict';
import {
  computeInspectCellStatus,
  shortRunId,
  INSPECT_BADGE_PREFIX
} from '../../../src/inspect/cell-status-compute.js';
import {
  OPEN_MANIFEST_DETAIL_COMMAND_ID
} from '../../../src/inspect/manifest-detail-view.js';
import type { NotebookMetadataLike } from '../../../src/inspect/run-frame-reader.js';

// Build a metadata blob mirroring the on-disk shape produced by
// vendor/LLMKernel/llm_kernel/metadata_writer.py.
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

suite('unit: BSP-008 Inspect — cell-status-provider compute', () => {

  test('returns_undefined_when_cell_has_no_runs', () => {
    const meta = metadataWith({});
    assert.equal(computeInspectCellStatus({ cellId: 'c1', metadata: meta }), undefined,
      'no run frames → no badge');
    assert.equal(computeInspectCellStatus({ cellId: '', metadata: meta }), undefined,
      'empty cellId → no badge');
    assert.equal(computeInspectCellStatus({ cellId: 'c1', metadata: undefined }), undefined,
      'no metadata → no badge');
  });

  test('builds_status_with_short_run_id_and_counts', () => {
    const meta = metadataWith({
      run_frames: {
        'run-abcdef-12345': {
          run_id: 'run-abcdef-12345',
          cell_id: 'c1',
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
          cell_id: 'c1',
          inclusion_rules_applied: [
            { rule: 'pinned', cells: ['c1', 'c2'] },
            { rule: 'section_predecessor', cells: ['c3', 'c4', 'c5'] }
          ],
          exclusions_applied: [
            { reason: 'scratch', cells: ['c6'] }
          ],
          generated_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const status = computeInspectCellStatus({ cellId: 'c1', metadata: meta });
    assert.ok(status, 'cell with a run frame must produce a status');
    assert.equal(status!.cell_id, 'c1');
    // Text format: `▶ <short-id> (status) · N cells / K excluded`
    assert.equal(
      status!.text,
      `${INSPECT_BADGE_PREFIX} run-abcd (complete) · 5 cells / 1 excluded`
    );
    // Tooltip carries the BSP-008 §11 per-cell summary.
    assert.match(
      status!.tooltip,
      /this cell ran 1 time; latest run = run-abcdef-12345 \(status: complete\) with manifest = m1 \(5 cells included, 1 excluded\)/
    );
    // Click target: the manifest-detail command + args.
    assert.deepEqual(status!.command_args, {
      cell_id: 'c1',
      manifest_id: 'm1',
      run_id: 'run-abcdef-12345'
    });
  });

  test('falls_back_to_missing_manifest_text_when_manifest_unavailable', () => {
    // BSP-008 ambiguity decision: if `context_manifest_id` references a
    // manifest not in `context_manifests`, render the manifest-unavailable
    // sentinel instead of swallowing the cell.
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-pruned', status: 'complete',
          started_at: '2026-04-28T12:00:00Z'
        }
      },
      context_manifests: { /* m-pruned absent — referenced but unwritten */ }
    });
    const status = computeInspectCellStatus({ cellId: 'c1', metadata: meta });
    assert.ok(status, 'badge MUST still appear so operator sees the run');
    assert.match(status!.text, /manifest unavailable/);
    assert.match(status!.tooltip, /manifest unavailable \(id=m-pruned\)/);
  });

  test('renders_running_status_for_in_flight_runs', () => {
    // V1 ambiguity decision: still show as running; let the operator see
    // the staleness.
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'running',
          started_at: '2026-04-28T12:00:00Z'
        }
      },
      context_manifests: {
        'm1': {
          manifest_id: 'm1', cell_id: 'c1',
          inclusion_rules_applied: [],
          exclusions_applied: [],
          generated_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const status = computeInspectCellStatus({ cellId: 'c1', metadata: meta });
    assert.ok(status);
    assert.match(status!.text, /\(running\)/);
  });

  test('command_id_matches_package_json_contribution', () => {
    // The package.json manifest contributes
    // `llmnb.inspect.openManifestDetail`; the click target MUST agree.
    assert.equal(
      OPEN_MANIFEST_DETAIL_COMMAND_ID,
      'llmnb.inspect.openManifestDetail'
    );
  });

  test('shortRunId_truncates_long_ids', () => {
    assert.equal(shortRunId('r1'), 'r1', 'short ids unchanged');
    assert.equal(shortRunId('0123456789'), '0123456789', '<= 10 chars unchanged');
    assert.equal(shortRunId('0123456789ab'), '01234567', '> 10 chars → first 8');
    assert.equal(
      shortRunId('01234567-89ab-4def-8123-fedcba987654'),
      '01234567'
    );
  });
});
