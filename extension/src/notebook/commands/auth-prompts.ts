// PLAN-S5.0.1 §3.8 — `@auth` cell-magic prompt helpers.
//
// Helper module the pin-status header uses to drive the operator UI for
// the four `@auth` subcommands (`set`, `rotate`, `off`, `verify`) plus the
// destructive `@auth refuse` accept-injection-risk path. Pure UI flow; no
// kernel coupling beyond inserting cells whose text is `@auth set <pin>`
// (etc) and triggering execution. The pin is NEVER stored in the
// extension; it goes through the cell-magic dispatch path so the audit
// trail is preserved (the kernel's MagicRegistry handler in S5.0.1c is
// where verify/rotate/set hash and store the fingerprint).
//
// Why insert a cell instead of posting an envelope directly: PLAN-S5.0.1
// §3.5 commits to the cell-magic vocabulary as the operator audit
// surface — every privileged action lands as a visible cell so the
// notebook IS the audit log. The pin-status header buttons are just
// shortcuts for typing `@auth ...` into a new cell.

import * as vscode from 'vscode';

/** Refuse-injection warning copy. Three options exposed: accept, cancel,
 *  or "tell me more" (which surfaces the spec snippet inline). The accept
 *  path is the only one that inserts a cell. */
export const REFUSE_WARNING_TITLE =
  'You are about to ACCEPT arbitrary code injection from agent outputs.';
export const REFUSE_WARNING_DETAIL =
  'After this is recorded, every operator opening this notebook will see a ' +
  'permanent banner stating that this notebook accepts arbitrary code injection. ' +
  'There is no V1 way to clear the marker; it survives copy / fork / paste. ' +
  'Are you sure?';
export const REFUSE_BUTTON_ACCEPT = 'I understand, accept anyway';
export const REFUSE_BUTTON_CANCEL = 'Cancel';
export const REFUSE_BUTTON_TELL_ME = 'Tell me more';

/** Surface used by the pin-status header to drive the operator UI. The
 *  default implementation routes through `vscode.window`; tests inject a
 *  stub so they can drive the flow synchronously. */
export interface AuthPromptSink {
  /** Prompt for a pin (or new pin / pin-to-verify). Returns the entered
   *  value, or `undefined` if the operator cancelled. The pin is masked. */
  promptPin(args: { kind: 'set' | 'rotate' | 'verify' }): Promise<string | undefined>;
  /** Show a destructive-warning modal. Returns the picked button label, or
   *  `undefined` if the operator dismissed. */
  warn(title: string, detail: string, ...buttons: string[]): Promise<string | undefined>;
  /** Show an information modal (used by "Tell me more"). */
  info(message: string): Promise<void>;
}

/** Production sink wired to the VS Code window APIs. */
export class VsCodeAuthPromptSink implements AuthPromptSink {
  public async promptPin(args: { kind: 'set' | 'rotate' | 'verify' }): Promise<string | undefined> {
    const promptCopy =
      args.kind === 'set'
        ? 'Enter a new pin to enable hash mode (≥12 characters).'
        : args.kind === 'rotate'
        ? 'Enter the new pin to rotate to (≥12 characters).'
        : 'Enter the current pin to verify against the stored fingerprint.';
    return vscode.window.showInputBox({
      prompt: promptCopy,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (typeof v !== 'string' || v.length < 12) {
          return 'Pin must be at least 12 characters (PLAN-S5.0.1 §3.9 K38).';
        }
        return undefined;
      }
    });
  }

  public async warn(
    title: string,
    detail: string,
    ...buttons: string[]
  ): Promise<string | undefined> {
    return vscode.window.showWarningMessage(
      title,
      { modal: true, detail },
      ...buttons
    );
  }

  public async info(message: string): Promise<void> {
    await vscode.window.showInformationMessage(message, { modal: true });
  }
}

/** Build the cell text for an `@auth` cell-magic invocation. Pure; tests
 *  use these constants to assert that the right text lands in the cell. */
export function authCellText(
  kind: 'set' | 'rotate' | 'off' | 'verify' | 'refuse',
  arg?: string
): string {
  switch (kind) {
    case 'set':
      return `@auth set ${arg ?? ''}`.trimEnd();
    case 'rotate':
      return `@auth rotate ${arg ?? ''}`.trimEnd();
    case 'off':
      return '@auth off';
    case 'verify':
      return `@auth verify ${arg ?? ''}`.trimEnd();
    case 'refuse':
      return '@auth refuse';
    default:
      throw new Error(`unknown auth subcommand: ${String(kind)}`);
  }
}

/** Cell-insertion sink — abstracted so tests can capture inserted text
 *  without spinning up a real NotebookDocument. */
export interface CellInserter {
  /** Insert a NEW code cell at the top of the notebook with the given
   *  text. Returns the (notebook URI, cell index) pair so the caller can
   *  trigger execution. */
  insertTopCell(text: string): Promise<{ uri: vscode.Uri; index: number } | undefined>;
}

/** Production cell inserter. Inserts at index 0 of the active notebook. */
export class ActiveNotebookCellInserter implements CellInserter {
  public constructor(private readonly notebookType: string) {}

  public async insertTopCell(
    text: string
  ): Promise<{ uri: vscode.Uri; index: number } | undefined> {
    const nb = this.findActiveLlmnb();
    if (!nb) {
      return undefined;
    }
    const newCell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      text,
      'llmnb-cell'
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.insertCells(0, [newCell])]);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      return undefined;
    }
    return { uri: nb.uri, index: 0 };
  }

  private findActiveLlmnb(): vscode.NotebookDocument | undefined {
    const active = vscode.window.activeNotebookEditor?.notebook;
    if (active && active.notebookType === this.notebookType) {
      return active;
    }
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType === this.notebookType) {
        return nb;
      }
    }
    return undefined;
  }
}

/** High-level operator flow for the "Set pin" button. Prompts for a pin,
 *  inserts an `@auth set <pin>` cell, and returns the inserted text (for
 *  test assertions). Returns `undefined` when the operator cancels. */
export async function setPinFlow(
  sink: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  const pin = await sink.promptPin({ kind: 'set' });
  if (typeof pin !== 'string' || pin.length === 0) {
    return undefined;
  }
  const text = authCellText('set', pin);
  const result = await inserter.insertTopCell(text);
  return result ? text : undefined;
}

/** High-level flow for the "Rotate pin" button. */
export async function rotatePinFlow(
  sink: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  const pin = await sink.promptPin({ kind: 'rotate' });
  if (typeof pin !== 'string' || pin.length === 0) {
    return undefined;
  }
  const text = authCellText('rotate', pin);
  const result = await inserter.insertTopCell(text);
  return result ? text : undefined;
}

/** High-level flow for the "Verify pin" button. */
export async function verifyPinFlow(
  sink: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  const pin = await sink.promptPin({ kind: 'verify' });
  if (typeof pin !== 'string' || pin.length === 0) {
    return undefined;
  }
  const text = authCellText('verify', pin);
  const result = await inserter.insertTopCell(text);
  return result ? text : undefined;
}

/** High-level flow for the "Disable hash mode" button. No pin prompt; the
 *  kernel-side handler in S5.0.1c rejects an `@auth off` from a notebook
 *  whose pin is locked unless the operator first verifies. */
export async function disableHashModeFlow(
  inserter: CellInserter
): Promise<string | undefined> {
  const text = authCellText('off');
  const result = await inserter.insertTopCell(text);
  return result ? text : undefined;
}

/** High-level flow for the "Refuse hash mode" / accept-injection-risk
 *  button. Surfaces the destructive warning, expands "Tell me more" to a
 *  spec quote, and only inserts the `@auth refuse` cell when the operator
 *  picks the explicit accept button. */
export async function refuseHashModeFlow(
  sink: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  for (;;) {
    const choice = await sink.warn(
      REFUSE_WARNING_TITLE,
      REFUSE_WARNING_DETAIL,
      REFUSE_BUTTON_ACCEPT,
      REFUSE_BUTTON_CANCEL,
      REFUSE_BUTTON_TELL_ME
    );
    if (choice === REFUSE_BUTTON_TELL_ME) {
      // Show the explainer + loop back to the warning so the operator
      // still has to pick accept/cancel.
      await sink.info(
        'PLAN-S5.0.1 §3.11: when contamination is detected and the operator ' +
          'clicks "Continue without protection", the kernel writes a ' +
          'verbatim string to metadata.rts.config.injection_acceptance:\n\n' +
          '"The Operator Has Accepted Arbitrary Code Injection at <ISO8601>"\n\n' +
          'This is permanent in V1 — there is no clear command. The marker ' +
          'survives copy / fork / paste. An always-visible banner appears ' +
          'in the notebook header.'
      );
      continue;
    }
    if (choice !== REFUSE_BUTTON_ACCEPT) {
      return undefined;
    }
    const text = authCellText('refuse');
    const result = await inserter.insertTopCell(text);
    return result ? text : undefined;
  }
}
