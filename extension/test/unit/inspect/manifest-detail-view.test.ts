// BSP-008 Inspect mode — unit tests for the manifest detail-view renderer.
//
// FSP-003 Pillar C T0: pure-module tests, no vscode. These tests assert
// the rendered text matches the BSP-008 §11 per-manifest format
// byte-for-byte. The vscode-bound QuickPick host
// (registerOpenManifestDetailCommand) is covered by the contract tier so
// the real `showQuickPick` path is exercised.

import * as assert from 'node:assert/strict';
import {
  renderManifestDetail,
  renderCellRunSummary,
  MISSING_MANIFEST_DETAIL_LINES
} from '../../../src/inspect/manifest-detail-view.js';
import type { ContextManifest, RunFrame } from '../../../src/inspect/types.js';

/** Build a ContextManifest fixture matching the BSP-008 §11 example
 *  prose (cells, rules, reasons, totals). */
function exampleManifest(): ContextManifest {
  return {
    manifest_id: 'manifest_Y',
    cell_id: 'c_15',
    section_id: 'sec_42',
    turn_ids: ['t_72.1', 't_71', 't_70', 't_69', 't_68', 't_67', 't_66', 't_65'],
    cell_refs: ['c_3', 'c_8', 'c_12', 'c_13', 'c_14', 'c_15'],
    inclusion_rules_applied: [
      { rule: 'pinned', cells: ['c_3', 'c_8'] },
      { rule: 'section_predecessor', cells: ['c_12', 'c_13', 'c_14'] },
      { rule: 'current_cell_sub_turns', cells: ['c_15'], turn_ids: ['t_72.1'] }
    ],
    exclusions_applied: [
      { reason: 'scratch', cells: ['c_11'] },
      { reason: 'excluded', cells: ['c_5'] },
      { reason: 'obsolete', cells: ['c_99'] }
    ],
    total_turn_count: 8,
    total_token_estimate: null,
    created_at: '2026-04-28T12:00:00Z'
  };
}

suite('unit: BSP-008 Inspect — manifest-detail-view', () => {

  // -------------------------------------------------------------------------
  // renderManifestDetail — BSP-008 §11 per-manifest format
  // -------------------------------------------------------------------------

  test('renders_full_manifest_per_BSP008_section_11_example', () => {
    const lines = renderManifestDetail(exampleManifest());
    // Header line.
    assert.equal(lines[0], 'manifest manifest_Y:');
    // BSP-008 §11 example prose:
    //   - included by rule pinned: cells [c_3, c_8]
    //   - included by rule section_predecessor: cells [c_12, c_13, c_14]
    //   - included by rule current_cell_sub_turns: cell c_15, turns [t_72.1]
    //   - excluded as scratch: cells [c_11]
    //   - excluded as excluded: cells [c_5]
    //   - total turns: 8; total tokens: (V1: not estimated)
    assert.equal(lines[1], '- included by rule pinned: cells [c_3, c_8]');
    assert.equal(lines[2], '- included by rule section_predecessor: cells [c_12, c_13, c_14]');
    assert.equal(lines[3], '- included by rule current_cell_sub_turns: cell c_15, turns [t_72.1]');
    assert.equal(lines[4], '- excluded as scratch: cells [c_11]');
    assert.equal(lines[5], '- excluded as excluded: cells [c_5]');
    assert.equal(lines[6], '- excluded as obsolete: cells [c_99]');
    assert.equal(lines[7], '- total turns: 8; total tokens: (V1: not estimated)');
    assert.equal(lines.length, 8);
  });

  test('skips_empty_inclusion_and_exclusion_buckets', () => {
    const m: ContextManifest = {
      ...exampleManifest(),
      inclusion_rules_applied: [
        { rule: 'pinned', cells: ['c_only'] }
      ],
      exclusions_applied: [],
      total_turn_count: 1
    };
    const lines = renderManifestDetail(m);
    // Header + one inclusion + total summary; no exclusion lines.
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'manifest manifest_Y:');
    assert.equal(lines[1], '- included by rule pinned: cells [c_only]');
    assert.equal(lines[2], '- total turns: 1; total tokens: (V1: not estimated)');
  });

  test('renders_token_estimate_when_present', () => {
    // Forward-compat: V2 will fill `total_token_estimate`. The renderer
    // surfaces it as a plain number when non-null.
    const m: ContextManifest = {
      ...exampleManifest(),
      total_token_estimate: 4096
    };
    const lines = renderManifestDetail(m);
    const summary = lines[lines.length - 1];
    assert.equal(summary, '- total turns: 8; total tokens: 4096');
  });

  test('renders_unknown_inclusion_rule_verbatim', () => {
    // §11.4 "no silent drops": forward-compat — a future kernel emitting
    // a new rule name (e.g. `semantic_match`) MUST surface in the trace.
    const m: ContextManifest = {
      ...exampleManifest(),
      inclusion_rules_applied: [
        { rule: 'semantic_match', cells: ['c_x', 'c_y'] }
      ],
      exclusions_applied: []
    };
    const lines = renderManifestDetail(m);
    assert.equal(lines[1], '- included by rule semantic_match: cells [c_x, c_y]');
  });

  test('current_cell_sub_turns_falls_back_to_manifest_cell_id_when_cells_empty', () => {
    // Defensive: if a future kernel emits the rule with empty `cells`,
    // we substitute the manifest's own cell_id.
    const m: ContextManifest = {
      ...exampleManifest(),
      inclusion_rules_applied: [
        { rule: 'current_cell_sub_turns', cells: [], turn_ids: ['t_99'] }
      ],
      exclusions_applied: []
    };
    const lines = renderManifestDetail(m);
    assert.equal(
      lines[1],
      '- included by rule current_cell_sub_turns: cell c_15, turns [t_99]'
    );
  });

  // -------------------------------------------------------------------------
  // renderCellRunSummary — per-cell view (tooltip / QuickPick title)
  // -------------------------------------------------------------------------

  test('cell_run_summary_renders_BSP008_section_11_per_cell_format', () => {
    const latest: RunFrame = {
      run_id: 'run_X',
      cell_id: 'c_15',
      executor_id: 'alpha',
      turn_head_before: 't_71',
      turn_head_after: 't_72.1',
      context_manifest_id: 'manifest_Y',
      status: 'complete',
      started_at: '2026-04-28T12:00:00Z',
      ended_at: '2026-04-28T12:00:05Z'
    };
    const m = exampleManifest();
    const text = renderCellRunSummary({ runCount: 3, latest, manifest: m });
    // BSP-008 §11 per-cell view example:
    //   "this cell ran 3 times; latest run = run_X (status: complete)
    //    with manifest = manifest_Y (M cells included, K excluded)"
    // Counts: 6 included cells (2+3+1), 3 excluded (1+1+1).
    assert.equal(
      text,
      'this cell ran 3 times; latest run = run_X (status: complete) ' +
        'with manifest = manifest_Y (6 cells included, 3 excluded)'
    );
  });

  test('cell_run_summary_singular_run_count', () => {
    const latest: RunFrame = {
      run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
      turn_head_before: null, turn_head_after: null,
      context_manifest_id: 'm1', status: 'failed',
      started_at: '2026-04-28T12:00:00Z'
    };
    const m: ContextManifest = {
      manifest_id: 'm1', cell_id: 'c1', section_id: null,
      turn_ids: [], cell_refs: [],
      inclusion_rules_applied: [], exclusions_applied: [],
      total_turn_count: 0, total_token_estimate: null,
      created_at: '2026-04-28T12:00:00Z'
    };
    const text = renderCellRunSummary({ runCount: 1, latest, manifest: m });
    assert.match(text, /^this cell ran 1 time;/);
  });

  test('cell_run_summary_handles_missing_manifest', () => {
    const latest: RunFrame = {
      run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
      turn_head_before: null, turn_head_after: null,
      context_manifest_id: 'm-pruned', status: 'complete',
      started_at: '2026-04-28T12:00:00Z'
    };
    const text = renderCellRunSummary({ runCount: 1, latest, manifest: null });
    assert.match(text, /manifest unavailable \(id=m-pruned\)/);
  });

  // -------------------------------------------------------------------------
  // Sentinel — BSP-008 missing-manifest fallback
  // -------------------------------------------------------------------------

  test('missing_manifest_sentinel_lines_match_spec', () => {
    // V1 spec phrase, BSP-008 §11 ambiguity:
    //   "render '(manifest unavailable; run may be from a prior session)'
    //    and continue".
    assert.equal(MISSING_MANIFEST_DETAIL_LINES.length, 1);
    assert.equal(
      MISSING_MANIFEST_DETAIL_LINES[0],
      '(manifest unavailable; run may be from a prior session)'
    );
  });
});
