// PLAN-S5.5 Phase 2 — section operator commands.
//
// Four VS Code commands exposing the kernel-side section overlay ops to
// the operator from the Command Palette / cell context menus:
//
//   llmnb.section.create     — prompt for title; create + optionally
//                              move-cells-into-section in one commit.
//   llmnb.section.rename     — prompt for new title.
//   llmnb.section.delete     — confirm + delete (empty sections only).
//   llmnb.section.setStatus  — pick status from the 4-value enum.
//
// All four ship `operator.action` envelopes carrying `action_type:
// "zone_mutate"` + `intent_kind: "apply_overlay_commit"` — the same wire
// shape kernel-side tests use, so the envelope is byte-compatible with
// the kernel's `_OPERATION_DISPATCH` table.
//
// Failure surfaces (K90 unknown_section, K90 nested_sections_forbidden,
// K95 forbidden_section_transition, K90 section_membership_mismatch)
// arrive back as `notebook.metadata` snapshots that the registry
// observes; the kernel produces no synchronous response at this layer.
// PLAN-S5.5 §3 step 6.

import * as vscode from 'vscode';
import type { MessageRouter } from '../../messaging/router.js';
import type {
  OperatorActionPayload,
  RtsV2Envelope
} from '../../messaging/types.js';

// --------------------------------------------------------------------------
// Command ids
// --------------------------------------------------------------------------

export const SECTION_CREATE_COMMAND_ID = 'llmnb.section.create';
export const SECTION_RENAME_COMMAND_ID = 'llmnb.section.rename';
export const SECTION_DELETE_COMMAND_ID = 'llmnb.section.delete';
export const SECTION_SET_STATUS_COMMAND_ID = 'llmnb.section.setStatus';

// --------------------------------------------------------------------------
// Section status enum — must mirror the kernel-side _SECTION_STATUSES in
// vendor/LLMKernel/llm_kernel/overlay_applier.py. Operators see these
// strings in the QuickPick; do NOT translate.
// --------------------------------------------------------------------------

export const SECTION_STATUSES = ['open', 'in_progress', 'complete', 'frozen'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

// --------------------------------------------------------------------------
// Intent-id minting. Per BSP-003 every overlay-commit envelope carries an
// intent_id the writer uses for idempotency. We mint via crypto.randomUUID
// where available, falling back to Date.now() for older runtimes.
// --------------------------------------------------------------------------

export function mintIntentId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${rand}`;
}

// --------------------------------------------------------------------------
// Envelope builders — pure, testable, no I/O.
// --------------------------------------------------------------------------

interface OverlayCommitInner {
  action_type: 'zone_mutate';
  intent_kind: 'apply_overlay_commit';
  parameters: {
    operations: Record<string, unknown>[];
    message: string;
  };
  intent_id: string;
}

function buildOverlayCommitEnvelope(
  operations: Record<string, unknown>[],
  message: string,
  intentPrefix: string
): RtsV2Envelope<OperatorActionPayload & OverlayCommitInner> {
  return {
    type: 'operator.action',
    payload: {
      action_type: 'zone_mutate',
      intent_kind: 'apply_overlay_commit',
      parameters: { operations, message },
      intent_id: mintIntentId(intentPrefix)
    } as unknown as OperatorActionPayload & OverlayCommitInner
  };
}

export function buildCreateSectionEnvelope(
  section_id: string,
  title: string,
  cell_range?: string[]
): RtsV2Envelope<OperatorActionPayload> {
  const ops: Record<string, unknown>[] = [
    { kind: 'create_section', section_id, title }
  ];
  if (Array.isArray(cell_range) && cell_range.length > 0) {
    ops.push({
      kind: 'move_cells_into_section',
      target_section_id: section_id,
      cell_ids: cell_range,
      position: 0
    });
  }
  return buildOverlayCommitEnvelope(
    ops,
    `create section ${section_id}`,
    `sec-create-${section_id.slice(0, 12)}`
  );
}

export function buildRenameSectionEnvelope(
  section_id: string,
  title: string
): RtsV2Envelope<OperatorActionPayload> {
  return buildOverlayCommitEnvelope(
    [{ kind: 'rename_section', section_id, title }],
    `rename section ${section_id}`,
    `sec-rename-${section_id.slice(0, 12)}`
  );
}

export function buildDeleteSectionEnvelope(
  section_id: string
): RtsV2Envelope<OperatorActionPayload> {
  return buildOverlayCommitEnvelope(
    [{ kind: 'delete_section', section_id }],
    `delete section ${section_id}`,
    `sec-delete-${section_id.slice(0, 12)}`
  );
}

export function buildSetSectionStatusEnvelope(
  section_id: string,
  new_status: SectionStatus
): RtsV2Envelope<OperatorActionPayload> {
  return buildOverlayCommitEnvelope(
    [{ kind: 'set_section_status', section_id, new_status }],
    `set section ${section_id} status → ${new_status}`,
    `sec-status-${section_id.slice(0, 12)}`
  );
}

// --------------------------------------------------------------------------
// Prompt sinks — abstracted so tests drive without VS Code's modal bus.
// --------------------------------------------------------------------------

export interface SectionPromptSink {
  /** Free-text input. Returns the operator's input, or undefined if
   *  cancelled / empty. */
  inputBox(opts: { prompt: string; placeHolder?: string; value?: string }): Promise<string | undefined>;
  /** Pick from a list of items. Returns the selected label, or
   *  undefined if cancelled. */
  quickPick(items: string[], placeHolder: string): Promise<string | undefined>;
  /** Modal confirmation. Returns the chosen action, or undefined on
   *  dismiss. */
  confirm(message: string, ...actions: string[]): Promise<string | undefined>;
}

export class VsCodeSectionPromptSink implements SectionPromptSink {
  public async inputBox(opts: {
    prompt: string;
    placeHolder?: string;
    value?: string;
  }): Promise<string | undefined> {
    const v = await vscode.window.showInputBox(opts);
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  public async quickPick(
    items: string[],
    placeHolder: string
  ): Promise<string | undefined> {
    return vscode.window.showQuickPick(items, { placeHolder });
  }
  public async confirm(
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

// --------------------------------------------------------------------------
// Section-id minting. Operator-facing section_ids should be readable
// (e.g. derived from title) so the create flow auto-generates one based on
// the title plus a short random tail. Operators can also rename later
// without touching the id (rename only mutates title).
// --------------------------------------------------------------------------

/** Parse the raw args string of an ``@@section`` cell magic into
 *  typed fields (title + optional explicit section_id). Mirrors the
 *  kernel-side ``_SectionCellMagic._refine_args`` semantics so the
 *  extension's dispatch produces the same overlay-commit envelope the
 *  CLI driver's ``_derive_cell_envelope`` produces. Pure; tests call
 *  this directly without spinning up the pty-kernel client.
 *
 *  Accepted forms:
 *
 *    @@section MyTitle
 *    @@section "Multi Word Title"
 *    @@section title:"Multi Word Title"
 *    @@section MyTitle id:"sec_explicit"
 *
 *  Returns ``{}`` when no title can be extracted; the caller falls
 *  through to the generic ``set_cell_metadata`` path (cell records as
 *  kind=section but no section is created — operator can fix by
 *  retyping with a title). */
export function parseSectionMagicArgs(
  argsStr: string
): { title?: string; section_id?: string } {
  if (typeof argsStr !== 'string') return {};
  const out: { title?: string; section_id?: string } = {};

  // Optional explicit ``id:"sec_..."``. Match first so we can strip it
  // before extracting the title (otherwise the positional match might
  // accidentally consume part of the id).
  const idMatch = argsStr.match(/id:"([^"]+)"/);
  if (idMatch) {
    out.section_id = idMatch[1];
  }

  // Title resolution: try ``title:"..."`` named arg, then leading
  // quoted token, then leading unquoted token.
  const titleNamedMatch = argsStr.match(/title:"([^"]+)"/);
  if (titleNamedMatch) {
    out.title = titleNamedMatch[1];
    return out;
  }
  const trimmed = argsStr.trim();
  if (trimmed.startsWith('"')) {
    const quoted = trimmed.match(/^"([^"]+)"/);
    if (quoted) {
      out.title = quoted[1];
      return out;
    }
  }
  const positional = trimmed.match(/^(\S+)/);
  if (positional && positional[1] !== 'id:' && !positional[1].startsWith('id:')) {
    out.title = positional[1];
  }
  return out;
}


export function mintSectionIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const tail =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `sec_${slug.length > 0 ? slug + '_' : ''}${tail}`;
}

// --------------------------------------------------------------------------
// Command runners. Each returns `true` when an envelope was enqueued,
// `false` when the operator cancelled or the args were invalid.
// --------------------------------------------------------------------------

export interface SectionCreateArgs {
  /** Optional explicit cell range (cell ids in display order). If
   *  omitted, the create is "empty section" — operator moves cells in
   *  later via the rename/setStatus UI or by editing the notebook. */
  cell_ids?: string[];
}

export async function runSectionCreateCommand(
  args: SectionCreateArgs | undefined,
  router: MessageRouter,
  sink: SectionPromptSink
): Promise<boolean> {
  const title = await sink.inputBox({
    prompt: 'Section title',
    placeHolder: 'e.g. Architecture'
  });
  if (!title) return false;
  const section_id = mintSectionIdFromTitle(title);
  const cell_ids = Array.isArray(args?.cell_ids) ? args.cell_ids : undefined;
  router.enqueueOutbound(
    buildCreateSectionEnvelope(section_id, title, cell_ids)
  );
  return true;
}

export interface SectionRenameArgs {
  section_id?: string;
  /** Pre-filled prompt value (e.g. the current title). */
  current_title?: string;
}

export async function runSectionRenameCommand(
  args: SectionRenameArgs | undefined,
  router: MessageRouter,
  sink: SectionPromptSink
): Promise<boolean> {
  const section_id =
    typeof args?.section_id === 'string' && args.section_id.length > 0
      ? args.section_id
      : '';
  if (!section_id) return false;
  const title = await sink.inputBox({
    prompt: 'New title',
    value: args?.current_title
  });
  if (!title) return false;
  router.enqueueOutbound(buildRenameSectionEnvelope(section_id, title));
  return true;
}

export interface SectionDeleteArgs {
  section_id?: string;
  /** Pre-resolved display title for the confirmation modal. */
  title?: string;
}

export const SECTION_DELETE_ACCEPT = 'Delete';
export const SECTION_DELETE_CANCEL = 'Cancel';

export async function runSectionDeleteCommand(
  args: SectionDeleteArgs | undefined,
  router: MessageRouter,
  sink: SectionPromptSink
): Promise<boolean> {
  const section_id =
    typeof args?.section_id === 'string' && args.section_id.length > 0
      ? args.section_id
      : '';
  if (!section_id) return false;
  const label = args?.title ? `"${args.title}"` : section_id;
  const choice = await sink.confirm(
    `Delete section ${label}? The section must be empty — cells must ` +
      'be moved out first or the kernel will refuse with K90 ' +
      'section_not_empty.',
    SECTION_DELETE_ACCEPT,
    SECTION_DELETE_CANCEL
  );
  if (choice !== SECTION_DELETE_ACCEPT) return false;
  router.enqueueOutbound(buildDeleteSectionEnvelope(section_id));
  return true;
}

export interface SectionSetStatusArgs {
  section_id?: string;
  /** Pre-supplied target status; when present, skips the QuickPick. */
  new_status?: SectionStatus;
}

export async function runSectionSetStatusCommand(
  args: SectionSetStatusArgs | undefined,
  router: MessageRouter,
  sink: SectionPromptSink
): Promise<boolean> {
  const section_id =
    typeof args?.section_id === 'string' && args.section_id.length > 0
      ? args.section_id
      : '';
  if (!section_id) return false;
  let status: SectionStatus | undefined;
  if (
    typeof args?.new_status === 'string' &&
    (SECTION_STATUSES as readonly string[]).includes(args.new_status)
  ) {
    status = args.new_status;
  } else {
    const picked = await sink.quickPick(
      [...SECTION_STATUSES],
      'Section status'
    );
    if (!picked) return false;
    if (!(SECTION_STATUSES as readonly string[]).includes(picked)) return false;
    status = picked as SectionStatus;
  }
  router.enqueueOutbound(buildSetSectionStatusEnvelope(section_id, status));
  return true;
}

// --------------------------------------------------------------------------
// Registration. Wired from extension.ts on activation.
// --------------------------------------------------------------------------

export function registerSectionCommands(
  router: MessageRouter,
  sink: SectionPromptSink = new VsCodeSectionPromptSink()
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      SECTION_CREATE_COMMAND_ID,
      (args: SectionCreateArgs | undefined) =>
        runSectionCreateCommand(args, router, sink)
    ),
    vscode.commands.registerCommand(
      SECTION_RENAME_COMMAND_ID,
      (args: SectionRenameArgs | undefined) =>
        runSectionRenameCommand(args, router, sink)
    ),
    vscode.commands.registerCommand(
      SECTION_DELETE_COMMAND_ID,
      (args: SectionDeleteArgs | undefined) =>
        runSectionDeleteCommand(args, router, sink)
    ),
    vscode.commands.registerCommand(
      SECTION_SET_STATUS_COMMAND_ID,
      (args: SectionSetStatusArgs | undefined) =>
        runSectionSetStatusCommand(args, router, sink)
    )
  ];
}
