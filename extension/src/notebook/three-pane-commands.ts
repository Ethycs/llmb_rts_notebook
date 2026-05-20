// PLAN-S10 §3.2-§3.3 (reduced) — bulk-collapse + find-in-cells commands.
//
// V1 scope (verified against VS Code v1.92 surface):
//   - `llmnb.collapseAllInputs`  → built-in `notebook.cell.collapseAllCellInput`
//   - `llmnb.collapseAllOutputs` → built-in `notebook.cell.collapseAllCellOutput`
//   - `llmnb.expandAllInputs`    → built-in `notebook.cell.expandAllCellInput`
//   - `llmnb.expandAllOutputs`   → built-in `notebook.cell.expandAllCellOutput`
//   - `llmnb.findInCells`        → built-in `actions.find` (the native
//                                   notebook find widget that Ctrl+F also
//                                   triggers).
//
// Out of scope vs. PLAN-S10 as written:
//   - The floating search bar with M-of-N counter, scope selector, regex
//     toggle, and the WorkspaceState-backed collapse Memento.
//   - VS Code v1.92 exposes no API to overlay a webview above the
//     notebook editor and no API to mutate cell metadata in a way the
//     renderer honors for collapse. Instead we wire to the engine's
//     own commands so the operator gets the standard VS Code affordance
//     via our command palette / keybindings.
//   - Mixed-state indicator on the toolbar — the engine's own toolbar
//     handles per-cell chevron state; the extension cannot read or
//     decorate VS Code's collapse glyph from outside.

import * as vscode from 'vscode';

/** Allow-list of built-in collapse commands the engine actually
 *  registers. Exported so tests can assert the wiring without running
 *  `vscode.commands.getCommands`. */
export const BUILTIN_COLLAPSE_COMMANDS = {
  collapseAllInputs:  'notebook.cell.collapseAllCellInput',
  collapseAllOutputs: 'notebook.cell.collapseAllCellOutput',
  expandAllInputs:    'notebook.cell.expandAllCellInput',
  expandAllOutputs:   'notebook.cell.expandAllCellOutput'
} as const;

/** Wrapper command ids contributed in `package.json`. */
export const COLLAPSE_ALL_INPUTS_COMMAND_ID  = 'llmnb.collapseAllInputs';
export const COLLAPSE_ALL_OUTPUTS_COMMAND_ID = 'llmnb.collapseAllOutputs';
export const EXPAND_ALL_INPUTS_COMMAND_ID    = 'llmnb.expandAllInputs';
export const EXPAND_ALL_OUTPUTS_COMMAND_ID   = 'llmnb.expandAllOutputs';
export const FIND_IN_CELLS_COMMAND_ID        = 'llmnb.findInCells';

/** The built-in find action VS Code exposes in notebook editors. The
 *  same command is bound to Ctrl+F when a notebook is focused; the
 *  wrapper just lets us advertise it in the command palette and from
 *  a status-bar shortcut later. */
export const BUILTIN_FIND_COMMAND = 'actions.find';

/** Minimal indirection so tests can substitute `vscode.commands.executeCommand`
 *  without spinning the extension host. */
export interface CommandRunner {
  execute(command: string): Promise<unknown>;
}

/** Production runner — delegates to VS Code's command surface. */
export class VsCodeCommandRunner implements CommandRunner {
  public execute(command: string): Promise<unknown> {
    return Promise.resolve(vscode.commands.executeCommand(command));
  }
}

/** Canonical mapping from wrapper command id to the engine-builtin it
 *  fans out to. The single source of truth — the registration loop and
 *  the contract tests both read off this map. */
export const WRAPPER_TO_BUILTIN: ReadonlyMap<string, string> = new Map([
  [COLLAPSE_ALL_INPUTS_COMMAND_ID,  BUILTIN_COLLAPSE_COMMANDS.collapseAllInputs],
  [COLLAPSE_ALL_OUTPUTS_COMMAND_ID, BUILTIN_COLLAPSE_COMMANDS.collapseAllOutputs],
  [EXPAND_ALL_INPUTS_COMMAND_ID,    BUILTIN_COLLAPSE_COMMANDS.expandAllInputs],
  [EXPAND_ALL_OUTPUTS_COMMAND_ID,   BUILTIN_COLLAPSE_COMMANDS.expandAllOutputs],
  [FIND_IN_CELLS_COMMAND_ID,        BUILTIN_FIND_COMMAND]
]);

/** Build the per-wrapper handler closure without registering it. Pure
 *  function — exported so tests can verify the fan-out without driving
 *  VS Code's command surface. */
export function makeWrapperHandler(
  wrapperId: string,
  runner: CommandRunner
): () => Promise<unknown> {
  const builtin = WRAPPER_TO_BUILTIN.get(wrapperId);
  if (!builtin) {
    throw new Error(`unknown wrapper command id: ${wrapperId}`);
  }
  return () => runner.execute(builtin);
}

/** Register the five S10 wrapper commands. Each one delegates to a
 *  built-in. Returns the array of disposables for the activation glue
 *  to push into `context.subscriptions`. */
export function registerThreePaneCommands(
  runner: CommandRunner = new VsCodeCommandRunner()
): vscode.Disposable[] {
  const out: vscode.Disposable[] = [];
  for (const wrapperId of WRAPPER_TO_BUILTIN.keys()) {
    out.push(vscode.commands.registerCommand(wrapperId, makeWrapperHandler(wrapperId, runner)));
  }
  return out;
}

/** Test-only collector — records which built-in command each wrapper
 *  fires. Used by `three-pane-commands.test.ts` to verify the wrapper
 *  → built-in mapping without invoking VS Code's command surface. */
export class RecordingCommandRunner implements CommandRunner {
  public readonly invocations: string[] = [];
  public execute(command: string): Promise<unknown> {
    this.invocations.push(command);
    return Promise.resolve(undefined);
  }
}
