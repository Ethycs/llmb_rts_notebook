// PLAN-S5.0.2 §3.2 — `llmnb.revealCell` VS Code command.
//
// Operator-driven entry point that scrolls a notebook editor to the cell
// matching a given cellId and applies a brief flash highlight so the
// operator can find the source cell at a glance. Driven by the provenance
// chip's click handler in `renderers/components/provenance-chip.ts`.
//
// Flow:
//   1. Provenance chip click invokes this command with `{cellId}`.
//   2. We locate the active llmnb NotebookEditor and scan its cells for
//      one whose id resolves (via candidateCellIds) to `cellId`.
//   3. Scroll to that cell via `revealRange(...)` with `InCenter`.
//   4. Apply a flash highlight via `setNotebookCellSelection` (we mark
//      the cell as selected; VS Code's selection styling provides the
//      visual cue). The "fade out" is a no-op in the v1.92 API since
//      `NotebookEditorDecorationType` is not exposed, so we clear the
//      selection after 1.5s to leave the editor in a clean state.
//   5. Non-existent cellId is a no-op (logs a warning, does not throw).

import * as vscode from 'vscode';
import { candidateCellIds } from '../contamination-badge.js';

/** Command id, mirrored in `renderers/components/provenance-chip.ts`. */
export const REVEAL_CELL_COMMAND_ID = 'llmnb.revealCell';

/** Click-handler argument shape passed via the chip click. The renderer
 *  side ships `{cellId}`; we accept both spellings so a future status-bar
 *  surface that uses `{cell_id}` works without a wrapper. */
export interface RevealCellArgs {
  /** The cell id to reveal. May be the kernel-assigned `cell.metadata.id`,
   *  the namespaced `metadata.rts.cell.id`, or the document URI. */
  cellId?: string;
  /** Snake-case alias accepted for parity with other operator-action
   *  payloads (e.g. `reset_contamination`). */
  cell_id?: string;
}

/** Duration the flash highlight stays applied before being cleared.
 *  PLAN-S5.0.2 §3.2 calls out a 1.5s window. Exported so tests can
 *  override the timing without monkey-patching the timer. */
export const FLASH_DURATION_MS = 1500;

/** Minimal logging sink — abstracted so tests can assert that a missing
 *  cellId path emits a warning rather than throwing. */
export interface RevealLogger {
  warn(message: string): void;
}

/** Active-editor sink. Production routes through `vscode.window`; tests
 *  inject a fake to drive the reveal flow without VS Code's real editor. */
export interface NotebookEditorProvider {
  /** Returns the active llmnb notebook editor, or `undefined` when no
   *  notebook editor is in focus. */
  getActiveNotebookEditor(): vscode.NotebookEditor | undefined;
}

/** Production NotebookEditorProvider — returns `vscode.window.activeNotebookEditor`
 *  when its document.notebookType matches the V1 llmnb type. */
export class WindowActiveNotebookEditorProvider implements NotebookEditorProvider {
  public constructor(private readonly notebookType: string = 'llmnb') {}
  public getActiveNotebookEditor(): vscode.NotebookEditor | undefined {
    const ed = vscode.window.activeNotebookEditor;
    if (!ed) return undefined;
    if (ed.notebook.notebookType !== this.notebookType) return undefined;
    return ed;
  }
}

/** Scheduler abstraction so tests can drive the flash-fade timing
 *  deterministically without `setTimeout` shenanigans. */
export interface RevealScheduler {
  scheduleFadeOut(callback: () => void, delayMs: number): { dispose: () => void };
}

/** Production scheduler — wraps `setTimeout`. */
export class TimeoutRevealScheduler implements RevealScheduler {
  public scheduleFadeOut(
    callback: () => void,
    delayMs: number
  ): { dispose: () => void } {
    const handle = setTimeout(callback, delayMs);
    return { dispose: (): void => clearTimeout(handle) };
  }
}

/** Locate the index in the editor's notebook of the cell whose id resolves
 *  to `cellId`. Returns `-1` if no cell matches. Pure helper — exported so
 *  tests can validate the matching logic against synthetic notebooks. */
export function findCellIndexByCellId(
  editor: vscode.NotebookEditor,
  cellId: string
): number {
  if (typeof cellId !== 'string' || cellId.length === 0) return -1;
  const cells = editor.notebook.getCells();
  for (let i = 0; i < cells.length; i += 1) {
    const ids = candidateCellIds(cells[i]);
    if (ids.includes(cellId)) {
      return i;
    }
  }
  return -1;
}

/** Core command implementation. Returns `true` when the editor scrolled
 *  to a matching cell, `false` otherwise (no editor, no match, or invalid
 *  args). Exported so tests can drive the full flow. */
export async function runRevealCellCommand(
  args: RevealCellArgs | undefined,
  provider: NotebookEditorProvider,
  scheduler: RevealScheduler,
  logger: RevealLogger
): Promise<boolean> {
  const cellId =
    typeof args?.cellId === 'string' && args.cellId.length > 0
      ? args.cellId
      : typeof args?.cell_id === 'string' && args.cell_id.length > 0
      ? args.cell_id
      : '';
  if (cellId.length === 0) {
    logger.warn('[llmnb.revealCell] missing cellId; ignoring invocation');
    return false;
  }
  const editor = provider.getActiveNotebookEditor();
  if (!editor) {
    logger.warn('[llmnb.revealCell] no active llmnb notebook editor; ignoring');
    return false;
  }
  const index = findCellIndexByCellId(editor, cellId);
  if (index < 0) {
    logger.warn(
      `[llmnb.revealCell] cellId not found in active notebook: ${cellId}`
    );
    return false;
  }
  const range = new vscode.NotebookRange(index, index + 1);
  // Scroll the cell into view per PLAN-S5.0.2 §3.2.
  try {
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
  } catch (err) {
    logger.warn(`[llmnb.revealCell] revealRange threw: ${String(err)}`);
  }
  // Flash highlight via cell selection. v1.92 doesn't expose
  // NotebookEditorDecorationType, so the fallback per the spec is to set
  // selection so VS Code's native selection styling acts as the visual
  // cue. Clear after FLASH_DURATION_MS so the editor doesn't stay in a
  // sticky-selected state.
  try {
    editor.selection = range;
    const editorAny = editor as unknown as { selections?: vscode.NotebookRange[] };
    if (Array.isArray(editorAny.selections)) {
      editorAny.selections = [range];
    }
  } catch (err) {
    logger.warn(`[llmnb.revealCell] setting selection threw: ${String(err)}`);
  }
  scheduler.scheduleFadeOut(() => {
    try {
      // Clear selection by collapsing to a zero-width range at the cell.
      editor.selection = new vscode.NotebookRange(index, index);
    } catch {
      /* swallow — the editor may have been disposed during the fade. */
    }
  }, FLASH_DURATION_MS);
  return true;
}

/** Convenience: register the command with VS Code. The activation glue
 *  calls this and pushes the returned disposable into the extension
 *  context subscriptions. */
export function registerRevealCellCommand(
  notebookType: string = 'llmnb',
  provider: NotebookEditorProvider = new WindowActiveNotebookEditorProvider(notebookType),
  scheduler: RevealScheduler = new TimeoutRevealScheduler(),
  logger: RevealLogger = {
    warn: (msg) => console.warn(msg)
  }
): vscode.Disposable {
  return vscode.commands.registerCommand(
    REVEAL_CELL_COMMAND_ID,
    (args: RevealCellArgs | undefined) =>
      runRevealCellCommand(args, provider, scheduler, logger)
  );
}
