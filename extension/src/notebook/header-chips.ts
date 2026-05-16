// PLAN-S5.0.4 §3.5 — privilege-status header chip.
//
// Sits alongside the `🔒 hash mode` chip from `pin-status-header.ts` and
// surfaces the count of active `magic_emit_privileges[]` grants. Click
// opens a QuickPick listing every grant; selecting a grant offers a
// "Revoke" action that emits a `revoke_magic_emit_privilege`
// operator-action envelope.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.4-privileged-magic-emission.md §3.5
//   docs/atoms/discipline/certified-magic-emitter.md (V2+ privileged-agent row)
//
// Mount choice mirrors `pin-status-header.ts`: a scoped status-bar item,
// visible only when the focused tab is an llmnb notebook.

import * as vscode from 'vscode';
import type { NotebookMetadataObserver } from '../messaging/router.js';
import type { NotebookMetadataPayload } from '../messaging/types.js';

/** Command id the chip points at. Activation registers the handler in
 *  extension.ts; click opens a QuickPick over the current grants. */
export const PRIVILEGE_HEADER_COMMAND_ID = 'llmnb.privilegeHeader.openMenu';

/** One entry of `metadata.rts.config.magic_emit_privileges[]` per
 *  PLAN-S5.0.4 §3.2. Scope is `{ magics: [name, ...] | "all" }`. */
export interface MagicEmitPrivilegeEntry {
  agent_id: string;
  zone_id: string;
  granted_at: string;
  scope: { magics: string[] | 'all' };
}

/** Read-only registry of currently-known privilege grants. Driven by
 *  `notebook.metadata` snapshots (Family F); observable so the chip
 *  re-renders when grants change. */
export class PrivilegeRegistry implements NotebookMetadataObserver {
  private entries: MagicEmitPrivilegeEntry[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires every time the grant list changes. */
  public readonly onDidChange = this.changeEmitter.event;

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Read-only snapshot of all grants. */
  public list(): MagicEmitPrivilegeEntry[] {
    return this.entries.map((e) => ({ ...e, scope: { ...e.scope } }));
  }

  /** Convenience for the promotion-chip's `hasGrant(agent_id)` check. */
  public hasGrant(agent_id: string): boolean {
    if (typeof agent_id !== 'string' || !agent_id) return false;
    for (const e of this.entries) {
      if (e.agent_id === agent_id) return true;
    }
    return false;
  }

  /** Test/seam helper. */
  public set(next: MagicEmitPrivilegeEntry[]): void {
    if (sameEntries(this.entries, next)) return;
    this.entries = next.map((e) => ({ ...e, scope: { ...e.scope } }));
    this.changeEmitter.fire();
  }

  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) return;
    const cfg = (payload.snapshot as { config?: Record<string, unknown> }).config;
    if (!cfg || typeof cfg !== 'object') {
      this.set([]);
      return;
    }
    const raw = (cfg as Record<string, unknown>)['magic_emit_privileges'];
    if (!Array.isArray(raw)) {
      this.set([]);
      return;
    }
    const next: MagicEmitPrivilegeEntry[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const agent_id = typeof rec['agent_id'] === 'string' ? rec['agent_id'] : '';
      const zone_id = typeof rec['zone_id'] === 'string' ? rec['zone_id'] : '';
      const granted_at = typeof rec['granted_at'] === 'string' ? rec['granted_at'] : '';
      const scope = rec['scope'] as { magics?: unknown } | undefined;
      let magics: string[] | 'all' = 'all';
      if (scope && Array.isArray(scope.magics)) {
        magics = scope.magics.filter((m): m is string => typeof m === 'string');
      } else if (scope && scope.magics === 'all') {
        magics = 'all';
      }
      if (!agent_id || !zone_id) continue;
      next.push({ agent_id, zone_id, granted_at, scope: { magics } });
    }
    this.set(next);
  }
}

function sameEntries(
  a: MagicEmitPrivilegeEntry[],
  b: MagicEmitPrivilegeEntry[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].agent_id !== b[i].agent_id ||
      a[i].zone_id !== b[i].zone_id ||
      a[i].granted_at !== b[i].granted_at
    ) {
      return false;
    }
    const am = a[i].scope.magics;
    const bm = b[i].scope.magics;
    if (am === 'all' && bm === 'all') continue;
    if (am === 'all' || bm === 'all') return false;
    if (am.length !== bm.length) return false;
    for (let k = 0; k < am.length; k++) {
      if (am[k] !== bm[k]) return false;
    }
  }
  return true;
}

/** Descriptor for the privilege header chip. Pure compute; tests
 *  assert against this without driving VS Code. */
export interface PrivilegeHeaderChip {
  /** Final rendered chip text. */
  text: string;
  tooltip: string;
  /** Grant count -- drives the parenthetical in the chip text. */
  count: number;
}

/** Chip prefix; codepoint is "key" (🔑). */
export const PRIVILEGE_CHIP_PREFIX = '$(key) magic-emit';

/** Pure compute: derive the chip from the current grant list. */
export function computePrivilegeHeaderChip(
  entries: MagicEmitPrivilegeEntry[]
): PrivilegeHeaderChip {
  const count = entries.length;
  const text = `${PRIVILEGE_CHIP_PREFIX} (${count})`;
  let tooltip: string;
  if (count === 0) {
    tooltip =
      'No magic-emit privilege grants are active.\n' +
      'Click to manage grants (no agent can currently invoke emit_magic_cell).';
  } else {
    const lines = entries.map(
      (e) =>
        `  • ${e.agent_id} in ${e.zone_id} — ` +
        (e.scope.magics === 'all'
          ? 'all magics'
          : `[${e.scope.magics.join(', ')}]`)
    );
    tooltip =
      `${count} active magic-emit privilege grant${count === 1 ? '' : 's'}:\n` +
      lines.join('\n') +
      '\nClick to review or revoke.';
  }
  return { text, tooltip, count };
}

/** QuickPick sink for the privilege menu. Abstracted so tests can
 *  drive the menu without VS Code. */
export interface PrivilegeQuickPickSink {
  pick(items: string[], placeholder: string): Promise<string | undefined>;
}

/** Build the QuickPick item list for the open-menu flow. */
export function buildMenuItems(entries: MagicEmitPrivilegeEntry[]): string[] {
  if (entries.length === 0) {
    return ['(no active grants)'];
  }
  return entries.map(
    (e) =>
      `Revoke: ${e.agent_id} in ${e.zone_id} (${
        e.scope.magics === 'all' ? 'all' : e.scope.magics.join(',')
      })`
  );
}

/** Parse a menu-item picked by the operator and extract the grant
 *  it refers to. Returns ``null`` when the item is a sentinel
 *  (e.g. "(no active grants)") so callers can no-op cleanly. */
export function parseMenuPick(
  pick: string,
  entries: MagicEmitPrivilegeEntry[]
): MagicEmitPrivilegeEntry | null {
  if (!pick || !pick.startsWith('Revoke: ')) {
    return null;
  }
  for (const e of entries) {
    const expected = `Revoke: ${e.agent_id} in ${e.zone_id} (${
      e.scope.magics === 'all' ? 'all' : e.scope.magics.join(',')
    })`;
    if (pick === expected) return e;
  }
  return null;
}

/** Operator-action emitter -- abstracted so tests can capture
 *  outgoing envelopes without a kernel wire. */
export interface OperatorActionEmitter {
  emit(action_type: string, parameters: Record<string, unknown>): void;
}

/** Open the menu for the current state. Tests call this directly to
 *  assert that picking a "Revoke" item emits the right envelope. */
export async function openPrivilegeMenu(
  registry: PrivilegeRegistry,
  pickSink: PrivilegeQuickPickSink,
  emitter: OperatorActionEmitter
): Promise<MagicEmitPrivilegeEntry | undefined> {
  const entries = registry.list();
  const items = buildMenuItems(entries);
  const placeholder =
    entries.length === 0
      ? 'No active grants -- use the cell toolbar to grant a privilege'
      : 'Pick a grant to revoke';
  const picked = await pickSink.pick(items, placeholder);
  if (typeof picked !== 'string') {
    return undefined;
  }
  const target = parseMenuPick(picked, entries);
  if (target === null) {
    return undefined;
  }
  emitter.emit('revoke_magic_emit_privilege', {
    agent_id: target.agent_id,
    zone_id: target.zone_id
  });
  return target;
}

/** Status-bar host owning the chip lifecycle. Mirror of
 *  ``PinStatusHeaderHost`` from pin-status-header.ts. */
export class PrivilegeHeaderHost implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly notebookType: string,
    private readonly registry: PrivilegeRegistry
  ) {
    // Sit just to the right of the pin-status chip (priority 999 vs
    // pin's 1000).
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      999
    );
    this.item.command = PRIVILEGE_HEADER_COMMAND_ID;
    this.refresh();

    this.disposables.push(this.item);
    this.disposables.push(this.registry.onDidChange(() => this.refresh()));
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor(() => this.refresh())
    );
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** Re-evaluate chip text + visibility against the current state. */
  public refresh(): void {
    const active = vscode.window.activeNotebookEditor?.notebook;
    const llmnbActive = !!active && active.notebookType === this.notebookType;
    if (!llmnbActive) {
      this.item.hide();
      return;
    }
    const chip = computePrivilegeHeaderChip(this.registry.list());
    this.item.text = chip.text;
    this.item.tooltip = chip.tooltip;
    this.item.show();
  }
}
