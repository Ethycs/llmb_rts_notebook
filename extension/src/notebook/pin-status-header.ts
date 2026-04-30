// PLAN-S5.0.1 §3.8 — pin-status header.
//
// Top-of-notebook strip showing hash-mode state and the operator-action
// buttons that drive the `@auth` cell-magic vocabulary. PLAN-S5.0.1 §3.8
// describes a "notebook header" surface; VS Code's NotebookEditor API
// (v1.92) does NOT expose a clean per-document toolbar slot, so this
// implementation mounts a `vscode.window.createStatusBarItem` scoped to
// the active llmnb editor (visible only when an llmnb notebook is the
// focused tab). Click the chip to open a QuickPick of the available
// actions for the current state. This keeps the audit-trail invariant
// (every privileged action lands as a `@auth` cell, see auth-prompts.ts)
// while sidestepping the missing notebook-toolbar slot.
//
// Mount choice rationale (see slice dispatch "Anticipated ambiguity"):
//   - A `NotebookCellOutput` pinned at index 0 would pollute the notebook
//     with a sentinel cell; this conflicts with the cell-as-agent invariant
//     (atoms/concepts/cell.md — every cell binds to an agent).
//   - An Activity Bar tree-view item is too far removed from the notebook
//     editor; operators who open multiple notebooks would lose context.
//   - A scoped status-bar item is VS-Code-native, themes correctly, and
//     has a documented `command` slot for click handling.
// We retain the renderers/components/contamination-badge.ts module as the
// V1.5+ surface for an in-document panel (the renderer-side module is
// reserved for when we expand contamination chips into inline panels).
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.5

import * as vscode from 'vscode';
import type { NotebookMetadataObserver } from '../messaging/router.js';
import type { NotebookMetadataPayload } from '../messaging/types.js';
import {
  AuthPromptSink,
  CellInserter,
  VsCodeAuthPromptSink,
  ActiveNotebookCellInserter,
  setPinFlow,
  rotatePinFlow,
  verifyPinFlow,
  disableHashModeFlow,
  refuseHashModeFlow
} from './commands/auth-prompts.js';

/** Command id the status-bar chip points at. Clicking the chip opens a
 *  QuickPick of context-sensitive actions; the picked action then runs
 *  the matching `@auth` flow from `auth-prompts.ts`. */
export const PIN_STATUS_HEADER_COMMAND_ID = 'llmnb.pinStatusHeader.openMenu';

/** Sub-slot of `notebook.metadata.rts.config` per PLAN-S5.0.1 §3.7 schema.
 *  Forward-compat: extra keys ignored. */
export interface RtsConfigSlot {
  magic_hash_enabled?: boolean;
  magic_pin_fingerprint?: string | null;
  /** PLAN-S5.0.1 §3.11 — verbatim string written when the operator accepts
   *  arbitrary code injection. When non-null, the always-visible banner
   *  text in the chip surfaces the acceptance state. */
  injection_acceptance?: string | null;
}

/** Notebook-scoped registry for the config slot. Driven by Family F
 *  snapshots (NotebookMetadataPayload). Observable so the status-bar
 *  surfaces re-render when hash mode flips. */
export class PinStatusRegistry implements NotebookMetadataObserver {
  private state: RtsConfigSlot = {
    magic_hash_enabled: false,
    magic_pin_fingerprint: null,
    injection_acceptance: null
  };
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires every time a snapshot mutates the config slot. */
  public readonly onDidChange = this.changeEmitter.event;

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Read-only snapshot of the current config. */
  public get(): RtsConfigSlot {
    return { ...this.state };
  }

  /** Test/seam helper. */
  public set(next: RtsConfigSlot): void {
    if (
      this.state.magic_hash_enabled === next.magic_hash_enabled &&
      this.state.magic_pin_fingerprint === next.magic_pin_fingerprint &&
      this.state.injection_acceptance === next.injection_acceptance
    ) {
      return;
    }
    this.state = { ...next };
    this.changeEmitter.fire();
  }

  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) {
      return;
    }
    const cfg = (payload.snapshot as { config?: Record<string, unknown> }).config;
    if (!cfg || typeof cfg !== 'object') {
      return;
    }
    const next: RtsConfigSlot = {
      magic_hash_enabled: cfg['magic_hash_enabled'] === true,
      magic_pin_fingerprint:
        typeof cfg['magic_pin_fingerprint'] === 'string'
          ? (cfg['magic_pin_fingerprint'] as string)
          : null,
      injection_acceptance:
        typeof cfg['injection_acceptance'] === 'string'
          ? (cfg['injection_acceptance'] as string)
          : null
    };
    this.set(next);
  }
}

/** Pure-compute descriptor for the status-bar chip. Tests assert this
 *  directly without spinning up VS Code's status-bar pipeline. */
export interface PinStatusChip {
  /** Final rendered text. PLAN-S5.0.1 §3.8 spec:
   *   - `🔒 hash mode (fingerprint: <last4>)` when ON
   *   - `🔓 unprotected` when OFF
   *   - `⚠ injection-accepted` overrides display when injection_acceptance
   *     is set (per §3.11 always-visible banner) — combined with the
   *     hash-mode state when both are present. */
  text: string;
  tooltip: string;
  /** True when hash mode is on; drives which actions appear in the menu. */
  hashEnabled: boolean;
  /** True when the notebook has accepted arbitrary code injection. */
  injectionAccepted: boolean;
  /** Last 4 chars of the fingerprint (when present), surfaced inline. */
  fingerprintTail: string | null;
}

const CHIP_LOCK_ON = '$(lock) hash mode';
const CHIP_LOCK_OFF = '$(unlock) unprotected';
const INJECTION_PREFIX = '$(warning) injection-accepted ';

/** Pure-compute: derive the chip from a config slot. */
export function computePinStatusChip(cfg: RtsConfigSlot): PinStatusChip {
  const hashEnabled = cfg.magic_hash_enabled === true;
  const fingerprint =
    typeof cfg.magic_pin_fingerprint === 'string' ? cfg.magic_pin_fingerprint : null;
  const tail = fingerprint && fingerprint.length >= 4 ? fingerprint.slice(-4) : null;
  const injectionAccepted = typeof cfg.injection_acceptance === 'string';

  let text: string;
  if (hashEnabled) {
    text = tail ? `${CHIP_LOCK_ON} (…${tail})` : CHIP_LOCK_ON;
  } else {
    text = CHIP_LOCK_OFF;
  }
  if (injectionAccepted) {
    text = INJECTION_PREFIX + text;
  }
  // Tooltip surfaces the acceptance verbatim per §3.11 ("plain English
  // statement in any JSON inspection or git diff"); we mirror that to the
  // hover so an operator can audit it without opening DevTools.
  let tooltip = hashEnabled
    ? `Magic-cell hash mode is ON.${tail ? ` Pin fingerprint ends …${tail}.` : ''}\n` +
      'Click to verify pin / rotate pin / disable hash mode.'
    : 'Magic-cell hash mode is OFF.\n' +
      'Click to set pin (enables hash mode) or refuse hash mode (records arbitrary-injection acceptance).';
  if (injectionAccepted) {
    tooltip =
      `WARNING: this notebook accepts arbitrary code injection from agent outputs.\n` +
      `Verbatim record: ${cfg.injection_acceptance}\n\n` +
      tooltip;
  }
  return { text, tooltip, hashEnabled, injectionAccepted, fingerprintTail: tail };
}

/** PLAN-S5.0.1 §3.8 — labels for the QuickPick menu actions. Exported so
 *  tests can assert which actions appear in each state without coupling
 *  to inline string literals. */
export const ACTION_SET_PIN = 'Set pin (enable hash mode)';
export const ACTION_ROTATE_PIN = 'Rotate pin';
export const ACTION_VERIFY_PIN = 'Verify pin';
export const ACTION_DISABLE_HASH_MODE = 'Disable hash mode';
export const ACTION_REFUSE_HASH_MODE = 'Refuse hash mode (accept injection risk)';

/** Pure-compute: actions visible for a given chip state. PLAN-S5.0.1 §3.8:
 *   - When OFF: Set pin + Refuse hash mode
 *   - When ON: Rotate pin + Verify pin + Disable hash mode
 *   - When injection_acceptance is recorded: only set/rotate/verify shown
 *     (refuse becomes a no-op since the marker is permanent in V1). */
export function actionsForChip(chip: PinStatusChip): string[] {
  if (chip.hashEnabled) {
    return [ACTION_VERIFY_PIN, ACTION_ROTATE_PIN, ACTION_DISABLE_HASH_MODE];
  }
  if (chip.injectionAccepted) {
    // Refuse already recorded; only the pin-enable path is offered.
    return [ACTION_SET_PIN];
  }
  return [ACTION_SET_PIN, ACTION_REFUSE_HASH_MODE];
}

/** QuickPick sink — abstracted so tests can drive the menu flow without
 *  VS Code's UI. */
export interface QuickPickSink {
  pick(items: string[], placeholder: string): Promise<string | undefined>;
}

/** Production sink. */
export class VsCodeQuickPickSink implements QuickPickSink {
  public async pick(items: string[], placeholder: string): Promise<string | undefined> {
    return vscode.window.showQuickPick(items, { placeHolder: placeholder });
  }
}

/** Dispatch a picked action to the matching `auth-prompts.ts` flow. Returns
 *  the inserted cell text (or `undefined` when cancelled). */
export async function dispatchPinAction(
  action: string,
  prompts: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  switch (action) {
    case ACTION_SET_PIN:
      return setPinFlow(prompts, inserter);
    case ACTION_ROTATE_PIN:
      return rotatePinFlow(prompts, inserter);
    case ACTION_VERIFY_PIN:
      return verifyPinFlow(prompts, inserter);
    case ACTION_DISABLE_HASH_MODE:
      return disableHashModeFlow(inserter);
    case ACTION_REFUSE_HASH_MODE:
      return refuseHashModeFlow(prompts, inserter);
    default:
      return undefined;
  }
}

/** Open the menu for the current state. Tests call this directly to
 *  assert dispatch wiring. */
export async function openPinStatusMenu(
  registry: PinStatusRegistry,
  pickSink: QuickPickSink,
  prompts: AuthPromptSink,
  inserter: CellInserter
): Promise<string | undefined> {
  const chip = computePinStatusChip(registry.get());
  const actions = actionsForChip(chip);
  if (actions.length === 0) {
    return undefined;
  }
  const placeholder = chip.hashEnabled
    ? 'Hash mode is ON — pick an action'
    : 'Hash mode is OFF — pick an action';
  const picked = await pickSink.pick(actions, placeholder);
  if (typeof picked !== 'string') {
    return undefined;
  }
  return dispatchPinAction(picked, prompts, inserter);
}

/** Status-bar host that owns the chip's lifecycle. Visible only when an
 *  llmnb notebook is the focused editor; hidden otherwise to avoid
 *  cluttering non-llmnb workflows. */
export class PinStatusHeaderHost implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly notebookType: string,
    private readonly registry: PinStatusRegistry
  ) {
    // Far-left alignment with high priority so the chip sits next to the
    // editor's filename in the status bar.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      1000
    );
    this.item.command = PIN_STATUS_HEADER_COMMAND_ID;
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

  /** Re-evaluate visibility + chip text against the current registry state
   *  and active editor. Idempotent. */
  public refresh(): void {
    const active = vscode.window.activeNotebookEditor?.notebook;
    const llmnbActive = !!active && active.notebookType === this.notebookType;
    if (!llmnbActive) {
      this.item.hide();
      return;
    }
    const chip = computePinStatusChip(this.registry.get());
    this.item.text = chip.text;
    this.item.tooltip = chip.tooltip;
    // Surface the warning tone via background color when injection is accepted.
    if (chip.injectionAccepted) {
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }
}

/** Convenience: register the open-menu command. The activation glue
 *  invokes this and pushes the disposable into context.subscriptions. */
export function registerPinStatusHeaderCommand(
  registry: PinStatusRegistry,
  notebookType: string,
  pickSink: QuickPickSink = new VsCodeQuickPickSink(),
  prompts: AuthPromptSink = new VsCodeAuthPromptSink(),
  inserter: CellInserter = new ActiveNotebookCellInserter(notebookType)
): vscode.Disposable {
  return vscode.commands.registerCommand(
    PIN_STATUS_HEADER_COMMAND_ID,
    () => openPinStatusMenu(registry, pickSink, prompts, inserter)
  );
}
