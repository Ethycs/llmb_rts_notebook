// Contract tests for PLAN-S5.0.2 §6 — provenance schema round-trip.
//
// The kernel writes per-cell provenance fields under
//   notebook.metadata.rts.cells[<cell_id>].generated_by
//   notebook.metadata.rts.cells[<cell_id>].generated_at
// The .llmnb serializer is intentionally shallow (RFC-005 §"Persistence
// strategy" — kernel is the single logical writer of metadata.rts; this
// module preserves the namespace verbatim). We assert that pin invariant
// here: writing a notebook whose metadata.rts carries provenance and
// reading it back yields byte-identical values.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.2-magic-code-generators.md §6 (provenance schema)
//   docs/atoms/concepts/magic-code-generator.md (provenance fields)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LlmnbNotebookSerializer } from '../../src/llmnb/serializer.js';

/** Roundtrip a NotebookData through the serializer. Returns the parsed
 *  back NotebookData so tests can assert metadata equality. */
async function roundtrip(data: vscode.NotebookData): Promise<vscode.NotebookData> {
  const serializer = new LlmnbNotebookSerializer();
  const tokenSource = new vscode.CancellationTokenSource();
  try {
    const bytes = await serializer.serializeNotebook(data, tokenSource.token);
    const decoded = await serializer.deserializeNotebook(bytes, tokenSource.token);
    return decoded;
  } finally {
    tokenSource.dispose();
  }
}

suite('contract: PLAN-S5.0.2 §6 — provenance round-trip', () => {

  test('test_generated_by_and_at_roundtrip_byte_identical', async () => {
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        'print("generator")',
        'llmnb-cell'
      ),
      new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        '# generated child cell',
        'llmnb-cell'
      )
    ]);
    data.metadata = {
      rts: {
        schema_version: '1.0.0',
        cells: {
          'cell-generator': {
            generated_by: null,
            generated_at: null
          },
          'cell-child': {
            generated_by: 'cell-generator',
            generated_at: '2026-04-29T12:34:56.789Z'
          }
        }
      }
    };
    const out = await roundtrip(data);
    const cells = (out.metadata?.['rts'] as { cells?: Record<string, unknown> } | undefined)?.cells;
    assert.ok(cells, 'metadata.rts.cells MUST round-trip');
    assert.deepEqual(
      (cells as Record<string, { generated_by: unknown; generated_at: unknown }>)['cell-generator'],
      { generated_by: null, generated_at: null }
    );
    assert.deepEqual(
      (cells as Record<string, { generated_by: unknown; generated_at: unknown }>)['cell-child'],
      {
        generated_by: 'cell-generator',
        generated_at: '2026-04-29T12:34:56.789Z'
      }
    );
  });

  test('test_provenance_coexists_with_other_per_cell_fields', async () => {
    // The schema allows generated_by alongside the contamination fields
    // (S5.0.1) and any future per-cell rows. The serializer MUST preserve
    // unrelated keys verbatim — this is the same shallowness guarantee the
    // metadata-loader / metadata-applier rely on.
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'llmnb-cell')
    ]);
    data.metadata = {
      rts: {
        schema_version: '1.0.0',
        cells: {
          'cell-X': {
            contaminated: false,
            contamination_log: [],
            generated_by: 'cell-W',
            generated_at: '2026-04-29T01:00:00Z',
            // Unknown forward-compatible field: serializer MUST preserve.
            future_field: { nested: [1, 2, 3] }
          }
        }
      }
    };
    const out = await roundtrip(data);
    const slot = (((out.metadata?.['rts'] as { cells?: Record<string, unknown> }).cells) ?? {})['cell-X'] as Record<string, unknown>;
    assert.equal(slot['contaminated'], false);
    assert.equal(slot['generated_by'], 'cell-W');
    assert.equal(slot['generated_at'], '2026-04-29T01:00:00Z');
    assert.deepEqual(slot['future_field'], { nested: [1, 2, 3] });
  });

  test('test_serializer_preserves_provenance_through_two_roundtrips', async () => {
    // Save → reopen → save → reopen MUST converge; this is the canonical
    // smoke for "serializer is a fixed point on metadata.rts".
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x', 'llmnb-cell')
    ]);
    data.metadata = {
      rts: {
        cells: {
          'c1': {
            generated_by: 'parent-id',
            generated_at: '2026-04-29T00:00:00Z'
          }
        }
      }
    };
    const once = await roundtrip(data);
    const twice = await roundtrip(once);
    assert.deepEqual(twice.metadata, once.metadata);
    const slot = ((twice.metadata?.['rts'] as { cells: Record<string, unknown> }).cells)['c1'] as Record<string, unknown>;
    assert.equal(slot['generated_by'], 'parent-id');
    assert.equal(slot['generated_at'], '2026-04-29T00:00:00Z');
  });

  test('test_null_provenance_rendered_as_explicit_null_in_json', async () => {
    // The kernel writes `null` rather than omitting the field for
    // generator cells (which have no parent). The serializer MUST keep
    // the explicit null so the per-cell schema stays uniform.
    const serializer = new LlmnbNotebookSerializer();
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x', 'llmnb-cell')
    ]);
    data.metadata = {
      rts: {
        cells: {
          'cell-G': { generated_by: null, generated_at: null }
        }
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const bytes = await serializer.serializeNotebook(data, tokenSource.token);
      const text = new TextDecoder('utf-8').decode(bytes);
      assert.match(text, /"generated_by"\s*:\s*null/);
      assert.match(text, /"generated_at"\s*:\s*null/);
    } finally {
      tokenSource.dispose();
    }
  });
});
