// Contract tests for PLAN-S5.0.2 §3.2 — `llmnb.revealCell` command.
// Pure-stub-editor exercise; no live notebook required.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.2-magic-code-generators.md §3.2 (extension-side UI)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  REVEAL_CELL_COMMAND_ID,
  FLASH_DURATION_MS,
  findCellIndexByCellId,
  runRevealCellCommand,
  type NotebookEditorProvider,
  type RevealLogger,
  type RevealScheduler
} from '../../src/notebook/commands/reveal-cell.js';

/** A test-only logger that records every warn() call. */
class RecordingLogger implements RevealLogger {
  public warnings: string[] = [];
  public warn(message: string): void {
    this.warnings.push(message);
  }
}

/** Test scheduler that captures the fade-out callback so tests can assert it
 *  was scheduled with the documented delay. The runtime fade is invoked
 *  synchronously to keep the tests deterministic. */
class CapturingScheduler implements RevealScheduler {
  public scheduledDelays: number[] = [];
  public scheduledCallbacks: Array<() => void> = [];
  public scheduleFadeOut(
    callback: () => void,
    delayMs: number
  ): { dispose: () => void } {
    this.scheduledDelays.push(delayMs);
    this.scheduledCallbacks.push(callback);
    return { dispose: (): void => undefined };
  }
  /** Fire all queued fade-out callbacks once. Used in the "selection
   *  cleared after fade" test path. */
  public fireAll(): void {
    for (const cb of this.scheduledCallbacks) cb();
  }
}

/** Build a fake NotebookEditor that VS Code will accept structurally. The
 *  test only reads `notebook.getCells`, `revealRange`, `selection` and
 *  `notebook.notebookType` — all of which we synthesize here. */
function fakeEditor(opts: {
  cells: Array<{ id?: string; uri?: string }>;
  notebookType?: string;
}): {
  editor: vscode.NotebookEditor;
  revealCalls: Array<{ range: vscode.NotebookRange; type: vscode.NotebookEditorRevealType | undefined }>;
  selectionLog: vscode.NotebookRange[];
} {
  const revealCalls: Array<{ range: vscode.NotebookRange; type: vscode.NotebookEditorRevealType | undefined }> = [];
  const selectionLog: vscode.NotebookRange[] = [];
  const cells = opts.cells.map((c, idx): vscode.NotebookCell => ({
    index: idx,
    kind: vscode.NotebookCellKind.Code,
    document: { uri: vscode.Uri.parse(c.uri ?? `vscode-notebook-cell:test#cell-${idx}`) } as unknown as vscode.TextDocument,
    metadata: c.id ? { id: c.id } : {},
    outputs: [],
    notebook: undefined as unknown as vscode.NotebookDocument,
    executionSummary: undefined
  }));
  const editor = {
    notebook: {
      notebookType: opts.notebookType ?? 'llmnb',
      getCells: () => cells
    } as unknown as vscode.NotebookDocument,
    revealRange: (range: vscode.NotebookRange, type?: vscode.NotebookEditorRevealType) => {
      revealCalls.push({ range, type });
    },
    get selection(): vscode.NotebookRange {
      return selectionLog[selectionLog.length - 1] ?? new vscode.NotebookRange(0, 0);
    },
    set selection(value: vscode.NotebookRange) {
      selectionLog.push(value);
    }
  } as unknown as vscode.NotebookEditor;
  return { editor, revealCalls, selectionLog };
}

class FixedEditorProvider implements NotebookEditorProvider {
  public constructor(private readonly editor: vscode.NotebookEditor | undefined) {}
  public getActiveNotebookEditor(): vscode.NotebookEditor | undefined {
    return this.editor;
  }
}

suite('contract: PLAN-S5.0.2 §3.2 — llmnb.revealCell command', () => {

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  test('test_command_id_constant_is_llmnb_revealCell', () => {
    assert.equal(REVEAL_CELL_COMMAND_ID, 'llmnb.revealCell');
  });

  test('test_flash_duration_is_documented_1500ms', () => {
    assert.equal(FLASH_DURATION_MS, 1500);
  });

  // --------------------------------------------------------------------------
  // findCellIndexByCellId
  // --------------------------------------------------------------------------

  test('test_find_cell_index_resolves_via_metadata_id_first', () => {
    const { editor } = fakeEditor({
      cells: [
        { id: 'cell-A', uri: 'vscode-notebook-cell:test#A' },
        { id: 'cell-B', uri: 'vscode-notebook-cell:test#B' }
      ]
    });
    assert.equal(findCellIndexByCellId(editor, 'cell-B'), 1);
    assert.equal(findCellIndexByCellId(editor, 'cell-A'), 0);
  });

  test('test_find_cell_index_falls_back_to_uri', () => {
    const { editor } = fakeEditor({
      cells: [
        { uri: 'vscode-notebook-cell:test#alpha' },
        { uri: 'vscode-notebook-cell:test#beta' }
      ]
    });
    assert.equal(
      findCellIndexByCellId(editor, 'vscode-notebook-cell:test#beta'),
      1
    );
  });

  test('test_find_cell_index_returns_minus_one_when_not_found', () => {
    const { editor } = fakeEditor({
      cells: [{ id: 'cell-1' }, { id: 'cell-2' }]
    });
    assert.equal(findCellIndexByCellId(editor, 'cell-999'), -1);
    assert.equal(findCellIndexByCellId(editor, ''), -1);
  });

  // --------------------------------------------------------------------------
  // runRevealCellCommand — happy path
  // --------------------------------------------------------------------------

  test('test_command_calls_revealRange_with_inCenter_for_matching_cell', async () => {
    const { editor, revealCalls } = fakeEditor({
      cells: [{ id: 'cell-A' }, { id: 'cell-B' }, { id: 'cell-C' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(
      { cellId: 'cell-B' },
      provider,
      scheduler,
      logger
    );
    assert.equal(ok, true);
    assert.equal(revealCalls.length, 1);
    assert.equal(revealCalls[0].range.start, 1);
    assert.equal(revealCalls[0].range.end, 2);
    assert.equal(revealCalls[0].type, vscode.NotebookEditorRevealType.InCenter);
  });

  test('test_command_applies_flash_highlight_via_selection', async () => {
    const { editor, selectionLog } = fakeEditor({
      cells: [{ id: 'cell-A' }, { id: 'cell-B' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    await runRevealCellCommand({ cellId: 'cell-A' }, provider, scheduler, logger);
    // First selection mutation marks the cell range; the fade callback is
    // queued (not yet fired).
    assert.ok(selectionLog.length >= 1);
    assert.equal(selectionLog[0].start, 0);
    assert.equal(selectionLog[0].end, 1);
    // The fade callback is scheduled with the documented duration.
    assert.deepEqual(scheduler.scheduledDelays, [FLASH_DURATION_MS]);
  });

  test('test_command_clears_selection_after_fade_runs', async () => {
    const { editor, selectionLog } = fakeEditor({
      cells: [{ id: 'cell-A' }, { id: 'cell-B' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    await runRevealCellCommand({ cellId: 'cell-B' }, provider, scheduler, logger);
    const beforeFade = selectionLog.length;
    scheduler.fireAll();
    // Fade collapses selection to a zero-width range at the cell index.
    assert.ok(selectionLog.length > beforeFade, 'fade MUST mutate selection again');
    const last = selectionLog[selectionLog.length - 1];
    assert.equal(last.start, 1);
    assert.equal(last.end, 1, 'fade-out MUST collapse selection to width 0');
  });

  test('test_command_accepts_snake_case_cell_id_alias', async () => {
    const { editor, revealCalls } = fakeEditor({
      cells: [{ id: 'cell-A' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(
      { cell_id: 'cell-A' },
      provider,
      scheduler,
      logger
    );
    assert.equal(ok, true);
    assert.equal(revealCalls.length, 1);
  });

  // --------------------------------------------------------------------------
  // runRevealCellCommand — no-op paths
  // --------------------------------------------------------------------------

  test('test_command_no_op_when_args_missing_cellId', async () => {
    const { editor, revealCalls } = fakeEditor({
      cells: [{ id: 'cell-A' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(undefined, provider, scheduler, logger);
    assert.equal(ok, false);
    assert.equal(revealCalls.length, 0);
    assert.ok(
      logger.warnings.some((m) => /missing cellId/i.test(m)),
      'missing cellId MUST log a warning'
    );
  });

  test('test_command_no_op_when_no_active_editor', async () => {
    const provider = new FixedEditorProvider(undefined);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(
      { cellId: 'whatever' },
      provider,
      scheduler,
      logger
    );
    assert.equal(ok, false);
    assert.ok(
      logger.warnings.some((m) => /no active llmnb notebook editor/i.test(m))
    );
  });

  test('test_command_no_op_when_cellId_not_found', async () => {
    const { editor, revealCalls } = fakeEditor({
      cells: [{ id: 'cell-A' }, { id: 'cell-B' }]
    });
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(
      { cellId: 'cell-DOES-NOT-EXIST' },
      provider,
      scheduler,
      logger
    );
    assert.equal(ok, false);
    assert.equal(revealCalls.length, 0);
    assert.ok(
      logger.warnings.some((m) => /cellId not found/i.test(m)),
      'unknown cellId MUST log a warning rather than throw'
    );
  });

  test('test_command_does_not_throw_when_revealRange_throws', async () => {
    // The fake editor's revealRange normally captures; replace it with
    // one that throws to assert we swallow + log rather than propagate.
    const { editor } = fakeEditor({
      cells: [{ id: 'cell-A' }]
    });
    (editor as unknown as { revealRange: () => void }).revealRange = (): void => {
      throw new Error('synthetic reveal failure');
    };
    const provider = new FixedEditorProvider(editor);
    const scheduler = new CapturingScheduler();
    const logger = new RecordingLogger();
    const ok = await runRevealCellCommand(
      { cellId: 'cell-A' },
      provider,
      scheduler,
      logger
    );
    // Selection was still set; we still report success because the cell was
    // located (the spec says no-op only on missing cell).
    assert.equal(ok, true);
    assert.ok(
      logger.warnings.some((m) => /revealRange threw/.test(m))
    );
  });
});
