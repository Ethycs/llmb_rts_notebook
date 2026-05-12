// BSP-008 Inspect mode — unit tests for the run-frame reader.
//
// FSP-003 Pillar C T0: pure-module tests, no vscode, no kernel, no I/O.
// These tests exercise run-frame-reader.ts directly. The reader has no
// vscode imports; it operates over a plain `metadata.rts` blob.

import * as assert from 'node:assert/strict';
import {
  latestRunFrameForCell,
  runFrameHistoryForCell,
  manifestById,
  runCountForCell,
  runFramesOf,
  contextManifestsOf,
  parseRunFrame,
  parseContextManifest,
  type NotebookMetadataLike
} from '../../../src/inspect/run-frame-reader.js';

// Build a metadata blob with a zone substructure. Mirrors the on-disk
// shape produced by vendor/LLMKernel/llm_kernel/metadata_writer.py
// (storage key: metadata.rts.zone.run_frames / .context_manifests).
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

suite('unit: BSP-008 Inspect — run-frame-reader', () => {

  // -------------------------------------------------------------------------
  // parseRunFrame — defensive parsing
  // -------------------------------------------------------------------------

  test('parseRunFrame_accepts_minimal_running_frame', () => {
    const raw = {
      run_id: 'r1',
      cell_id: 'c1',
      executor_id: 'alpha',
      context_manifest_id: 'm1',
      status: 'running',
      started_at: '2026-04-28T12:00:00Z'
    };
    const f = parseRunFrame('r1', raw);
    assert.ok(f, 'minimal running frame must parse');
    assert.equal(f!.run_id, 'r1');
    assert.equal(f!.cell_id, 'c1');
    assert.equal(f!.status, 'running');
    assert.equal(f!.turn_head_before, null, 'missing turn_head_before defaults to null');
    assert.equal(f!.turn_head_after, null, 'missing turn_head_after defaults to null');
    assert.equal(f!.ended_at, undefined, 'running frame may omit ended_at');
  });

  test('parseRunFrame_accepts_terminal_frame_all_fields', () => {
    const raw = {
      run_id: 'r2',
      cell_id: 'c1',
      executor_id: 'alpha',
      context_manifest_id: 'm2',
      status: 'complete',
      started_at: '2026-04-28T12:00:00Z',
      ended_at: '2026-04-28T12:00:05Z',
      turn_head_before: 't1',
      turn_head_after: 't2'
    };
    const f = parseRunFrame('r2', raw);
    assert.ok(f);
    assert.equal(f!.status, 'complete');
    assert.equal(f!.turn_head_before, 't1');
    assert.equal(f!.turn_head_after, 't2');
    assert.equal(f!.ended_at, '2026-04-28T12:00:05Z');
  });

  test('parseRunFrame_rejects_missing_required_fields', () => {
    // Missing cell_id.
    assert.equal(parseRunFrame('r3', {
      run_id: 'r3', status: 'complete', started_at: '2026-04-28T12:00:00Z'
    }), null);
    // Missing started_at.
    assert.equal(parseRunFrame('r4', {
      run_id: 'r4', cell_id: 'c1', status: 'complete'
    }), null);
    // Unknown status.
    assert.equal(parseRunFrame('r5', {
      run_id: 'r5', cell_id: 'c1', status: 'mystery', started_at: '2026-04-28T12:00:00Z'
    }), null);
    // Non-object input.
    assert.equal(parseRunFrame('', null), null);
    assert.equal(parseRunFrame('', 'not a dict'), null);
  });

  test('parseRunFrame_uses_map_key_as_run_id_fallback', () => {
    // The kernel's writer keys run_frames by run_id and stores the field
    // inside the record; if a record drops the inner run_id (forward-compat
    // safety), we fall back to the map key.
    const raw = {
      cell_id: 'c1',
      executor_id: 'alpha',
      context_manifest_id: 'm1',
      status: 'complete',
      started_at: '2026-04-28T12:00:00Z'
    };
    const f = parseRunFrame('r-from-key', raw);
    assert.ok(f);
    assert.equal(f!.run_id, 'r-from-key');
  });

  // -------------------------------------------------------------------------
  // parseContextManifest — defensive parsing + on-disk-shape divergence
  // -------------------------------------------------------------------------

  test('parseContextManifest_accepts_kernel_on_disk_shape', () => {
    // Today's vendor/LLMKernel emits `cell_refs` (not `turn_ids`) and
    // `generated_at` (not `created_at`). The reader tolerates this.
    const raw = {
      manifest_id: 'm1',
      cell_id: 'c1',
      cell_refs: ['c1', 'c2', 'c3'],
      inclusion_rules_applied: [
        { rule: 'pinned', cells: ['c1'] }
      ],
      exclusions_applied: [],
      generated_at: '2026-04-28T12:00:00Z'
    };
    const m = parseContextManifest('m1', raw);
    assert.ok(m);
    assert.equal(m!.manifest_id, 'm1');
    assert.equal(m!.cell_id, 'c1');
    assert.deepEqual(m!.cell_refs, ['c1', 'c2', 'c3']);
    assert.deepEqual(m!.turn_ids, [], 'on-disk shape lacks turn_ids — defaults to []');
    assert.equal(m!.created_at, '2026-04-28T12:00:00Z',
      'generated_at maps onto created_at when created_at absent');
    assert.equal(m!.total_token_estimate, null,
      'on-disk shape lacks total_token_estimate — V1 spec value is null');
    assert.equal(m!.total_turn_count, 0, 'derived from turn_ids.length when absent');
    assert.equal(m!.section_id, null);
  });

  test('parseContextManifest_accepts_spec_shape', () => {
    // The BSP-008 §4 spec shape (with turn_ids, total_turn_count,
    // total_token_estimate, created_at, section_id) MUST also parse.
    const raw = {
      manifest_id: 'm-spec',
      cell_id: 'c-spec',
      section_id: 'sec-1',
      turn_ids: ['t1', 't2', 't3'],
      inclusion_rules_applied: [
        { rule: 'pinned', cells: ['c1'] }
      ],
      exclusions_applied: [
        { reason: 'scratch', cells: ['c2'] }
      ],
      total_turn_count: 3,
      total_token_estimate: 1234,
      created_at: '2026-04-28T12:00:00Z'
    };
    const m = parseContextManifest('m-spec', raw);
    assert.ok(m);
    assert.deepEqual(m!.turn_ids, ['t1', 't2', 't3']);
    assert.equal(m!.total_turn_count, 3);
    assert.equal(m!.total_token_estimate, 1234);
    assert.equal(m!.section_id, 'sec-1');
    assert.equal(m!.created_at, '2026-04-28T12:00:00Z');
  });

  test('parseContextManifest_rejects_missing_required', () => {
    assert.equal(parseContextManifest('', { cell_id: 'c1' }), null,
      'missing manifest_id (no key fallback) rejects');
    assert.equal(parseContextManifest('m1', { manifest_id: 'm1' }), null,
      'missing cell_id rejects');
  });

  // -------------------------------------------------------------------------
  // latestRunFrameForCell — happy path, sort, terminal-vs-running preference
  // -------------------------------------------------------------------------

  test('latest_returns_terminal_when_running_and_terminal_for_same_run_id', () => {
    // BSP-008 §8 lifecycle: kernel writes a `running` start frame, then
    // updates-in-place to a terminal status. If both records exist for the
    // same run_id, prefer the terminal one.
    const meta = metadataWith({
      run_frames: {
        // Same run_id, both 'running' and 'complete'. (In practice the
        // writer overwrites in place — we cover the case where two
        // records survived a hand-edit / sync glitch.)
        'r1__start': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'running',
          started_at: '2026-04-28T12:00:00Z'
        },
        'r1__end': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'complete',
          started_at: '2026-04-28T12:00:00Z',
          ended_at: '2026-04-28T12:00:05Z'
        }
      }
    });
    const f = latestRunFrameForCell(meta, 'c1');
    assert.ok(f);
    assert.equal(f!.status, 'complete', 'terminal frame wins over running for same run_id');
  });

  test('latest_returns_running_when_no_terminal_yet', () => {
    // V1 ambiguity decision: if a run is `status: running` with no
    // terminal frame, still surface it so the operator sees the in-flight
    // execution + its staleness.
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'running',
          started_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const f = latestRunFrameForCell(meta, 'c1');
    assert.ok(f);
    assert.equal(f!.status, 'running');
  });

  test('latest_returns_null_when_no_frames_for_cell', () => {
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'other-cell', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'complete',
          started_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    assert.equal(latestRunFrameForCell(meta, 'c1'), null,
      'no frames for the target cell — returns null');
    assert.equal(latestRunFrameForCell(undefined, 'c1'), null,
      'undefined metadata — returns null');
    assert.equal(latestRunFrameForCell(meta, ''), null,
      'empty cellId — returns null');
  });

  test('latest_uses_started_at_descending_when_multiple_runs', () => {
    // Brief V1 decision: sort key is `started_at` descending.
    const meta = metadataWith({
      run_frames: {
        'old': {
          run_id: 'old', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-old', status: 'complete',
          started_at: '2026-04-28T10:00:00Z',
          ended_at: '2026-04-28T10:00:01Z'
        },
        'mid': {
          run_id: 'mid', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-mid', status: 'failed',
          started_at: '2026-04-28T11:00:00Z',
          ended_at: '2026-04-28T11:00:02Z'
        },
        'new': {
          run_id: 'new', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-new', status: 'complete',
          started_at: '2026-04-28T12:00:00Z',
          ended_at: '2026-04-28T12:00:03Z'
        }
      }
    });
    const f = latestRunFrameForCell(meta, 'c1');
    assert.ok(f);
    assert.equal(f!.run_id, 'new', 'highest started_at wins');
  });

  // -------------------------------------------------------------------------
  // runFrameHistoryForCell
  // -------------------------------------------------------------------------

  test('history_returns_terminal_frames_chronological', () => {
    const meta = metadataWith({
      run_frames: {
        'old': {
          run_id: 'old', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-old', status: 'complete',
          started_at: '2026-04-28T10:00:00Z'
        },
        'mid': {
          run_id: 'mid', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-mid', status: 'failed',
          started_at: '2026-04-28T11:00:00Z'
        },
        'new': {
          run_id: 'new', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm-new', status: 'interrupted',
          started_at: '2026-04-28T12:00:00Z'
        },
        // Different cell — must be filtered.
        'other': {
          run_id: 'other', cell_id: 'c-other', executor_id: 'alpha',
          context_manifest_id: 'm-other', status: 'complete',
          started_at: '2026-04-28T11:30:00Z'
        }
      }
    });
    const hist = runFrameHistoryForCell(meta, 'c1');
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.map((f) => f.run_id), ['old', 'mid', 'new'],
      'history is oldest first');
  });

  test('history_excludes_running_only_frames', () => {
    // History view shows completed runs only; in-flight `running` frames
    // are surfaced via latestRunFrameForCell instead.
    const meta = metadataWith({
      run_frames: {
        'r1': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'running',
          started_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    const hist = runFrameHistoryForCell(meta, 'c1');
    assert.equal(hist.length, 0,
      'pure-running frames are excluded from history');
  });

  // -------------------------------------------------------------------------
  // manifestById + runCountForCell
  // -------------------------------------------------------------------------

  test('manifestById_returns_null_when_absent', () => {
    const meta = metadataWith({
      context_manifests: {
        'm1': {
          manifest_id: 'm1', cell_id: 'c1',
          inclusion_rules_applied: [], exclusions_applied: [],
          generated_at: '2026-04-28T12:00:00Z'
        }
      }
    });
    assert.ok(manifestById(meta, 'm1'));
    assert.equal(manifestById(meta, 'never-seen'), null,
      'BSP-008 §11 missing-manifest sentinel path: lookup returns null');
    assert.equal(manifestById(undefined, 'm1'), null);
    assert.equal(manifestById(meta, ''), null);
  });

  test('runCountForCell_counts_distinct_run_ids', () => {
    const meta = metadataWith({
      run_frames: {
        // Same run_id appearing twice (start + terminal) counts as ONE run.
        'r1__start': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'running',
          started_at: '2026-04-28T12:00:00Z'
        },
        'r1__end': {
          run_id: 'r1', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'complete',
          started_at: '2026-04-28T12:00:00Z',
          ended_at: '2026-04-28T12:00:05Z'
        },
        'r2': {
          run_id: 'r2', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm2', status: 'failed',
          started_at: '2026-04-28T13:00:00Z'
        },
        // Different cell.
        'r3': {
          run_id: 'r3', cell_id: 'c2', executor_id: 'alpha',
          context_manifest_id: 'm3', status: 'complete',
          started_at: '2026-04-28T14:00:00Z'
        }
      }
    });
    assert.equal(runCountForCell(meta, 'c1'), 2,
      'distinct run_ids for c1: {r1, r2} == 2');
    assert.equal(runCountForCell(meta, 'c2'), 1);
    assert.equal(runCountForCell(meta, 'c-other'), 0);
  });

  // -------------------------------------------------------------------------
  // runFramesOf / contextManifestsOf — forward-compat / missing keys
  // -------------------------------------------------------------------------

  test('runFramesOf_handles_missing_zone', () => {
    assert.deepEqual(runFramesOf(undefined), {});
    assert.deepEqual(runFramesOf(null), {});
    assert.deepEqual(runFramesOf({}), {});
    assert.deepEqual(runFramesOf({ rts: {} }), {});
    assert.deepEqual(runFramesOf({ rts: { zone: {} } }), {});
  });

  test('contextManifestsOf_handles_missing_zone', () => {
    assert.deepEqual(contextManifestsOf(undefined), {});
    assert.deepEqual(contextManifestsOf({}), {});
    assert.deepEqual(contextManifestsOf({ rts: { zone: {} } }), {});
  });

  test('runFramesOf_skips_malformed_records', () => {
    // Forward-compat: garbage or partial records (e.g. from a future kernel
    // that uses additional fields we haven't typed yet) are skipped, not
    // crashed-on. The reader's job is to surface valid data and stay quiet
    // about the rest.
    const meta = metadataWith({
      run_frames: {
        'good': {
          run_id: 'good', cell_id: 'c1', executor_id: 'alpha',
          context_manifest_id: 'm1', status: 'complete',
          started_at: '2026-04-28T12:00:00Z'
        },
        'bad-no-status': {
          run_id: 'bad-no-status', cell_id: 'c1',
          started_at: '2026-04-28T12:00:00Z'
        },
        'bad-not-object': 'just a string',
        'bad-null': null
      }
    });
    const frames = runFramesOf(meta);
    assert.equal(Object.keys(frames).length, 1, 'only the well-formed record survives');
    assert.ok(frames['good']);
  });
});
