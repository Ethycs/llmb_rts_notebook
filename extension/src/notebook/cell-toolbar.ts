// PLAN-S5.0.4 §3.5 — cell-toolbar: Grant / Revoke magic-emit privilege.
//
// VS Code's NotebookCellStatusBarItemProvider is the only documented per-cell
// toolbar slot on Notebook editors (v1.92). This module mirrors the pattern
// used by `cell-badge.ts` / `contamination-badge.ts`: a provider that emits a
// status-bar chip per cell, with a click `command` registered in
// extension.ts activation.
//
// Two affordances per PLAN-S5.0.4 §3.5:
//   - "Grant magic-emit privilege" on every kind=agent cell whose bound agent
//     has NO active grant. Click opens a confirmation modal naming the
//     agent_id and emits `grant_magic_emit_privilege`.
//   - "Revoke magic-emit privilege" on every kind=agent cell whose bound agent
//     HAS an active grant. Click emits `revoke_magic_emit_privilege`.
// They are mutually exclusive on a given cell — paired via the privilege
// state — so the operator never sees both at once.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.4-privileged-magic-emission.md §3.5
//   docs/atoms/discipline/certified-magic-emitter.md (clause 1: operator-action)

import * as vscode from 'vscode';
import type { PrivilegeRegistry } from './header-chips.js';

/** Command ids registered in extension.ts activation. */
export const GRANT_PRIVILEGE_COMMAND_ID = 'llmnb.grantMagicEmitPrivilege';
export const REVOKE_PRIVILEGE_COMMAND_ID = 'llmnb.revokeMagicEmitPrivilege';

/** Visible labels. Exported so tests can assert without coupling to inline
 *  string literals. */
export const GRANT_TOOLBAR_TEXT = '$(key) Grant magic-emit';
export const REVOKE_TOOLBAR_TEXT = '$(key) Revoke magic-emit';

/** Toolbar descriptor returned by `computeCellToolbarItems`. Tests poke this
 *  to assert visibility without spinning up VS Code's status-bar pipeline. */
export interface CellToolbarItemDescriptor {
  command: string;
  text: string;
  tooltip: string;
  agent_id: string;
}

/** Per-cell metadata shape (subset). Only the cell-kind + bound_agent_id
 *  matter for the toolbar decision. */
export interface CellToolbarMetadata {
  kind?: string;
  bound_agent_id?: string | null;
}

/** Pure compute: returns the toolbar item descriptors for the cell.
 *
 *  - Returns an empty list when the cell is not an agent cell (only agent
 *    cells carry a bound_agent_id and only agents can receive grants).
 *  - Returns the "Grant" descriptor when the bound agent has NO active grant.
 *  - Returns the "Revoke" descriptor when the bound agent HAS an active grant.
 *  - Returns an empty list when `bound_agent_id` is null/undefined.
 */
export function computeCellToolbarItems(
  cell: { metadata?: unknown },
  privileges: PrivilegeRegistry
): CellToolbarItemDescriptor[] {
  const meta = readCellMetadata(cell);
  if (!meta) return [];
  if (meta.kind !== undefined && meta.kind !== 'agent') {
    // Markdown / scratch / checkpoint / tool / artifact / control / native
    // never carry a bound_agent_id; skip cleanly.
    return [];
  }
  const agent_id = meta.bound_agent_id;
  if (typeof agent_id !== 'string' || !agent_id) {
    return [];
  }
  if (privileges.hasGrant(agent_id)) {
    return [
      {
        command: REVOKE_PRIVILEGE_COMMAND_ID,
        text: REVOKE_TOOLBAR_TEXT,
        tooltip:
          `Revoke ${agent_id}'s magic-emit privilege.\n` +
          `Future emit_magic_cell calls will reject with K3K.`,
        agent_id
      }
    ];
  }
  return [
    {
      command: GRANT_PRIVILEGE_COMMAND_ID,
      text: GRANT_TOOLBAR_TEXT,
      tooltip:
        `Grant ${agent_id} permission to invoke the emit_magic_cell tool.\n` +
        `Privilege is per (operator, agent_id, zone) and lands in metadata.rts.config.`,
      agent_id
    }
  ];
}

function readCellMetadata(cell: { metadata?: unknown }): CellToolbarMetadata | undefined {
  const m = cell.metadata as
    | { kind?: unknown; bound_agent_id?: unknown; rts?: { cell?: { kind?: unknown; bound_agent_id?: unknown } } }
    | undefined;
  if (!m) return undefined;
  // Some serializers nest the cell record under .rts.cell; we read either
  // surface for compatibility with cell-badge.ts's existing convention.
  const inner = m.rts?.cell;
  const kind =
    typeof m.kind === 'string'
      ? m.kind
      : typeof inner?.kind === 'string'
        ? inner.kind
        : undefined;
  const bound_agent_id =
    typeof m.bound_agent_id === 'string'
      ? m.bound_agent_id
      : typeof inner?.bound_agent_id === 'string'
        ? inner.bound_agent_id
        : null;
  return { kind, bound_agent_id };
}

/** Operator-action emitter — same shape as `header-chips.ts`. */
export interface OperatorActionEmitter {
  emit(action_type: string, parameters: Record<string, unknown>): void;
}

/** Default confirmation flow for the Grant action — a modal listing the
 *  agent_id and the (operator-typed) magic scope. Returns the picked scope
 *  or undefined when cancelled. Exported as a seam so tests can stub. */
export interface GrantConfirmSink {
  confirm(agent_id: string): Promise<{ scope: { magics: string[] | 'all' } } | undefined>;
}

/** Default sink wired to VS Code window modals. Production code passes one
 *  of these; tests pass a stub. */
export class VsCodeGrantConfirmSink implements GrantConfirmSink {
  public async confirm(
    agent_id: string
  ): Promise<{ scope: { magics: string[] | 'all' } } | undefined> {
    const picked = await vscode.window.showInformationMessage(
      `Grant magic-emit privilege to ${agent_id}?\n\n` +
        `The agent will be able to invoke the emit_magic_cell MCP tool to ` +
        `produce new cells on your behalf. Stream-based emission remains banned.`,
      { modal: true },
      'Grant (all magics)',
      'Grant (specific magics…)'
    );
    if (picked === 'Grant (all magics)') {
      return { scope: { magics: 'all' } };
    }
    if (picked === 'Grant (specific magics…)') {
      const list = await vscode.window.showInputBox({
        prompt: 'Comma-separated magic names (e.g. spawn,scratch)',
        placeHolder: 'spawn,scratch'
      });
      if (typeof list !== 'string' || !list.trim()) {
        return undefined;
      }
      const magics = list
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (magics.length === 0) return undefined;
      return { scope: { magics } };
    }
    return undefined;
  }
}

/** Handler for the Grant command click. Pure async function so tests
 *  drive it directly. */
export async function runGrantCommand(
  args: { agent_id: string; zone_id?: string },
  confirm: GrantConfirmSink,
  emitter: OperatorActionEmitter
): Promise<boolean> {
  if (!args || typeof args.agent_id !== 'string' || !args.agent_id) {
    return false;
  }
  const confirmed = await confirm.confirm(args.agent_id);
  if (!confirmed) {
    return false;
  }
  emitter.emit('grant_magic_emit_privilege', {
    agent_id: args.agent_id,
    zone_id: args.zone_id,
    scope: confirmed.scope
  });
  return true;
}

/** Handler for the Revoke command click. Pure async function so tests
 *  drive it directly. */
export async function runRevokeCommand(
  args: { agent_id: string; zone_id?: string },
  emitter: OperatorActionEmitter
): Promise<boolean> {
  if (!args || typeof args.agent_id !== 'string' || !args.agent_id) {
    return false;
  }
  emitter.emit('revoke_magic_emit_privilege', {
    agent_id: args.agent_id,
    zone_id: args.zone_id
  });
  return true;
}

/** Status-bar provider rendering Grant/Revoke chips per cell. */
export class CellToolbarStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  public constructor(
    private readonly privileges: PrivilegeRegistry &
      { onDidChange?: vscode.Event<void> }
  ) {
    if (privileges.onDidChange) {
      this.subs.push(privileges.onDidChange(() => this.emitter.fire()));
    }
  }

  public dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const items = computeCellToolbarItems(cell, this.privileges);
    return items.map((desc) => {
      const item = new vscode.NotebookCellStatusBarItem(
        desc.text,
        vscode.NotebookCellStatusBarAlignment.Right
      );
      item.tooltip = desc.tooltip;
      item.command = {
        command: desc.command,
        title: desc.text,
        arguments: [{ agent_id: desc.agent_id }]
      };
      return item;
    });
  }
}
