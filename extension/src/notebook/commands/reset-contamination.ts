// PLAN-S5.0.1 §3.10 + §3.8 — `llmnb.resetContamination` VS Code command.
//
// Operator-only entry point that flips a cell's contamination flag false.
// PLAN-S5.0.1 §3.10 K3F: this is the ONLY code path on either side that
// is allowed to clear the flag — every other intent that tries to flip it
// is rejected with K3F. The kernel-side handler (`reset_contamination`,
// landing in S5.0.1c) audits the clear and writes the resulting snapshot.
//
// Flow:
//   1. Status-bar badge click invokes this command with `{cell_id}`.
//   2. Operator confirms via `showInformationMessage` (the spec calls out
//      that the cell content is unchanged; only the flag clears).
//   3. We emit an `operator.action` envelope with
//      `action_type: "reset_contamination"` and the cell_id parameter.
//   4. The kernel processes the envelope, clears the flag, and ships back
//      a `notebook.metadata` snapshot which the registry observes; the
//      badge then disappears via the normal status-bar refresh path.

import * as vscode from 'vscode';
import type { MessageRouter } from '../../messaging/router.js';
import type {
  OperatorActionPayload,
  RtsV2Envelope
} from '../../messaging/types.js';

/** Command id, mirrored in `contamination-badge.ts` so the badge's
 *  `command` field stays in sync. */
export const RESET_CONTAMINATION_COMMAND_ID = 'llmnb.resetContamination';

/** Click-handler argument shape passed via the status-bar item's `command`
 *  (or by the renderer-host bridge when the panel reset button is clicked). */
export interface ResetContaminationArgs {
  /** The cell id whose contamination flag to clear. May be either the
   *  kernel-assigned `cell.metadata.id` or the document URI; the kernel
   *  resolves either form against its cells map. */
  cell_id?: string;
  /** Renderer-side bridges (panel reset button) ship the same key under
   *  `cellId`. We accept both spellings to make the bridge code simpler. */
  cellId?: string;
}

/** Confirmation modal options. Exported so tests can assert that the
 *  command surfaces a confirmation step rather than firing eagerly. */
export const CONFIRM_RESET_TITLE =
  'Reset contamination on this cell? The contamination flag will clear ' +
  'so structural ops (split / merge / move / promote / set_kind) become ' +
  'allowed again. The cell content is unchanged.';
export const CONFIRM_RESET_ACCEPT = 'Reset';
export const CONFIRM_RESET_CANCEL = 'Cancel';

/** Build the operator-action envelope for a reset. Pure; no side-effects.
 *  Tests call this directly to assert the wire shape without spinning up
 *  the router. */
export function buildResetContaminationEnvelope(
  cell_id: string
): RtsV2Envelope<OperatorActionPayload & { cell_id: string }> {
  return {
    type: 'operator.action',
    payload: {
      action_type: 'reset_contamination',
      // Mirror the cell_id at payload root for parity with the locked
      // shape used by `agent_interrupt` (BSP-005 §S9). Kernel-side
      // dispatchers reading `parameters.cell_id` continue to work.
      cell_id,
      parameters: { cell_id },
      originating_cell_id: cell_id
    }
  };
}

/** Minimal modal sink the command depends on — abstracted so tests can
 *  drive the confirmation flow without VS Code's modal bus. */
export interface ConfirmationSink {
  /** Returns the operator's chosen action label, or `undefined` if they
   *  dismissed the modal. */
  ask(message: string, ...actions: string[]): Promise<string | undefined>;
}

/** Production sink: routes through `vscode.window.showInformationMessage`. */
export class VsCodeConfirmationSink implements ConfirmationSink {
  public async ask(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> {
    return vscode.window.showInformationMessage(
      message,
      { modal: true },
      ...actions
    );
  }
}

/** Core command implementation. Returns `true` when the envelope was
 *  enqueued, `false` when the operator cancelled or the args were invalid.
 *  Exported so tests can drive the full flow. */
export async function runResetContaminationCommand(
  args: ResetContaminationArgs | undefined,
  router: MessageRouter,
  confirm: ConfirmationSink
): Promise<boolean> {
  const cellId =
    typeof args?.cell_id === 'string' && args.cell_id.length > 0
      ? args.cell_id
      : typeof args?.cellId === 'string' && args.cellId.length > 0
      ? args.cellId
      : '';
  if (cellId.length === 0) {
    return false;
  }
  const choice = await confirm.ask(
    CONFIRM_RESET_TITLE,
    CONFIRM_RESET_ACCEPT,
    CONFIRM_RESET_CANCEL
  );
  if (choice !== CONFIRM_RESET_ACCEPT) {
    return false;
  }
  router.enqueueOutbound(buildResetContaminationEnvelope(cellId));
  return true;
}

/** Convenience: register the command with VS Code. The activation glue
 *  calls this and pushes the returned disposable into the extension
 *  context subscriptions. */
export function registerResetContaminationCommand(
  router: MessageRouter,
  confirm: ConfirmationSink = new VsCodeConfirmationSink()
): vscode.Disposable {
  return vscode.commands.registerCommand(
    RESET_CONTAMINATION_COMMAND_ID,
    (args: ResetContaminationArgs | undefined) =>
      runResetContaminationCommand(args, router, confirm)
  );
}
