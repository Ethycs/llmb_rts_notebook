// Contract tests for PLAN-S5.5 Phase 5 — section cells render as markdown
// for VS Code's native fold engine, BUT the serializer must preserve
// `metadata.rts.cell.kind = "section"` rather than force it to "markdown"
// on the markup-cell sanitizer path. Without this guard the round-trip
// would lose the section identity and reduce sections to plain markdown.
//
// Spec references:
//   docs/notebook/PLAN-S5.5-sections.md §5 (Phase 5: collapse via markdown
//     fold)
//   extension/src/llmnb/serializer.ts: MARKUP_RENDERED_KINDS

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

/** Read `metadata.rts.cell.kind` off a NotebookCellData. Returns
 *  undefined if absent. */
function readCellKind(cell: vscode.NotebookCellData): string | undefined {
  const meta = cell.metadata as
    | { rts?: { cell?: { kind?: unknown } } }
    | undefined;
  const k = meta?.rts?.cell?.kind;
  return typeof k === 'string' ? k : undefined;
}

suite('contract: PLAN-S5.5 Phase 5 — section serializer round-trip', () => {

  test('test_section_kind_survives_markup_sanitization', async () => {
    // A section cell as it would appear after magic_to_llmnb: rendered
    // as Markup with source = "# Architecture" and metadata carrying
    // kind=section. The serializer's markup-cell sanitizer MUST NOT
    // force kind to "markdown".
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      '# Architecture',
      'markdown'
    );
    cell.metadata = { rts: { cell: { kind: 'section' } } };
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    assert.equal(out.cells.length, 1);
    assert.equal(out.cells[0].kind, vscode.NotebookCellKind.Markup);
    assert.equal(out.cells[0].value, '# Architecture');
    assert.equal(readCellKind(out.cells[0]), 'section');
  });

  test('test_section_bound_agent_id_still_stripped', async () => {
    // bound_agent_id on a Markup cell is invalid per cell-kinds.md;
    // the sanitizer strips it on both markdown and section cells.
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      '# Foo',
      'markdown'
    );
    cell.metadata = {
      rts: { cell: { kind: 'section', bound_agent_id: 'alpha' } }
    };
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    const meta = out.cells[0].metadata as {
      rts?: { cell?: { bound_agent_id?: unknown } };
    };
    assert.equal(meta.rts?.cell?.bound_agent_id, undefined);
    // The kind survived even with bound_agent_id stripped.
    assert.equal(readCellKind(out.cells[0]), 'section');
  });

  test('test_legacy_markdown_still_forced_to_markdown_kind', async () => {
    // Regression: a Markup cell with NO explicit kind still gets
    // kind="markdown" written to its metadata on round-trip.
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      '# Heading',
      'markdown'
    );
    cell.metadata = {};
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    assert.equal(readCellKind(out.cells[0]), 'markdown');
  });

  test('test_unknown_kind_on_markup_falls_back_to_markdown', async () => {
    // A Markup cell whose kind names a NON-markup-rendered kind
    // (e.g. operator hand-edited "scratch" on a markdown-typed cell)
    // gets normalized to "markdown" — that's the markup invariant.
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      '# heading',
      'markdown'
    );
    cell.metadata = { rts: { cell: { kind: 'scratch' } } };
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    assert.equal(readCellKind(out.cells[0]), 'markdown');
  });

  test('test_legacy_flat_metadata_rts_kind_section_preserved', async () => {
    // Legacy flat shape: metadata.rts.kind = "section" (no cell slot).
    // The sanitizer migrates this to the namespaced metadata.rts.cell.kind
    // slot. Section identity MUST survive the migration; markdown kind
    // would be forced (legacy markdown behavior) but section should stay.
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Markup,
      '# Tests',
      'markdown'
    );
    cell.metadata = { rts: { kind: 'section' } };
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    const meta = out.cells[0].metadata as {
      rts?: { kind?: unknown; cell?: { kind?: unknown } };
    };
    // The flat shape is preserved when the kind is markup-rendered;
    // markdown would have been kept too (no forcing). The namespaced
    // shape is also written by the sanitizer (default "markdown" when
    // no cell slot exists pre-migration).
    assert.equal(meta.rts?.kind, 'section');
  });

  test('test_code_typed_section_legacy_path_preserves_kind', async () => {
    // BACKWARD COMPAT: a section cell saved by a pre-Phase-5 version of
    // the kernel/extension may exist on disk as cell_type="code" with
    // metadata.rts.cell.kind="section". On load it becomes a Code cell.
    // On save the serializer's encode path does NOT run markup
    // sanitization (cell.kind !== Markup), so the metadata passes
    // through verbatim and the section kind survives.
    const cell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      '@@section Architecture\nnotes',
      'llmnb-cell'
    );
    cell.metadata = { rts: { cell: { kind: 'section' } } };
    const data = new vscode.NotebookData([cell]);
    const out = await roundtrip(data);
    assert.equal(out.cells[0].kind, vscode.NotebookCellKind.Code);
    assert.equal(readCellKind(out.cells[0]), 'section');
    // Source is the canonical magic text — unchanged.
    assert.equal(out.cells[0].value, '@@section Architecture\nnotes');
  });

});
