// PLAN-S5.5 Phase 3 — section-header NotebookCellStatusBarItemProvider.
//
// Renders a NotebookCellStatusBarItem on every section-member cell:
//
//   First cell in section:  § Architecture (in_progress) · 5 cells
//   Subsequent cells:       ▸ Architecture
//
// Click → opens the section actions QuickPick (rename / delete / set
// status) so the operator can drive section overlay ops without
// memorising the Command Palette command ids. The QuickPick is wired
// in the registration helper; the renderer side only attaches the
// command + args.
//
// Mirrors the InspectCellStatusBarProvider shape — pure compute lives
// in section-header-compute.ts; the provider class wraps the render
// result and listens for metadata changes via an injected source.

import * as vscode from 'vscode';
import {
  computeSectionHeader,
  type NotebookMetadataForSections,
  type SectionStatus
} from './section-header-compute.js';
import { candidateCellIds } from '../contamination-badge.js';
import {
  SECTION_DELETE_COMMAND_ID,
  SECTION_RENAME_COMMAND_ID,
  SECTION_SET_STATUS_COMMAND_ID,
  type SectionDeleteArgs,
  type SectionRenameArgs,
  type SectionSetStatusArgs
} from '../commands/section-ops.js';
import type { NotebookMetadataObserver } from '../../messaging/router.js';
import type { NotebookMetadataPayload } from '../../messaging/types.js';

// Re-exports so callers can import everything from one place.
export {
  computeSectionHeader,
  SECTION_HEADER_PREFIX,
  SECTION_CONTINUATION_PREFIX,
  SECTION_STATUSES,
  type SectionHeaderRender,
  type SectionStatus,
  type NotebookMetadataForSections
} from './section-header-compute.js';

/** Command id for the section-header click handler. Opens a QuickPick
 *  with rename / delete / set-status actions. */
export const SECTION_HEADER_ACTIONS_COMMAND_ID = 'llmnb.section.openActions';

/** Args passed to the section-actions command via the status-bar item.
 *  The provider stamps these onto each item so the QuickPick handler
 *  knows which section to operate on. */
export interface SectionActionsArgs {
  section_id: string;
  title: string;
  status: SectionStatus;
}

/** A handle the provider uses to (a) read a notebook's metadata blob
 *  and (b) be notified when new ``notebook.metadata`` snapshots land. */
export interface SectionMetadataSource extends NotebookMetadataObserver {
  /** Re-fires when metadata changes — the provider hooks it to its
   *  ``onDidChangeCellStatusBarItems`` event. */
  readonly onDidChange: vscode.Event<void>;
  /** Lookup metadata for a particular notebook by uri. */
  getMetadataFor(notebookUri: string): NotebookMetadataForSections | undefined;
}

/** Default SectionMetadataSource: subscribes to the router's metadata
 *  observer surface and caches the most-recent snapshot. Mirrors
 *  RouterBackedInspectMetadataSource. */
export class RouterBackedSectionMetadataSource
  implements SectionMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  private latest: NotebookMetadataForSections | undefined;

  public dispose(): void {
    this.emitter.dispose();
  }

  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) return;
    this.latest = { rts: payload.snapshot } as NotebookMetadataForSections;
    this.emitter.fire();
  }

  public getMetadataFor(_notebookUri: string): NotebookMetadataForSections | undefined {
    return this.latest;
  }

  /** Test seam: inject a snapshot directly. */
  public setSnapshot(metadata: NotebookMetadataForSections | undefined): void {
    this.latest = metadata;
    this.emitter.fire();
  }
}

/** DocumentBacked variant — reads off the live NotebookDocument.metadata
 *  rather than the router. Mirrors DocumentBackedInspectMetadataSource. */
export class DocumentBackedSectionMetadataSource
  implements SectionMetadataSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly notebookType: string) {
    this.subscription = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType !== this.notebookType) return;
      this.emitter.fire();
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public onNotebookMetadata(_payload: NotebookMetadataPayload): void {
    this.emitter.fire();
  }

  public getMetadataFor(notebookUri: string): NotebookMetadataForSections | undefined {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== this.notebookType) continue;
      if (nb.uri.toString() !== notebookUri) continue;
      return nb.metadata as NotebookMetadataForSections;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// vscode.NotebookCellStatusBarItemProvider implementation.
// ---------------------------------------------------------------------------

export class SectionHeaderStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly source: SectionMetadataSource) {
    this.subscription = source.onDidChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const metadata = this.source.getMetadataFor(cell.notebook.uri.toString());
    if (!metadata) return [];
    // Try each candidate cell id; the first that yields a section render wins.
    for (const cellId of candidateCellIds(cell)) {
      const render = computeSectionHeader({ cellId, metadata });
      if (!render) continue;
      const item = new vscode.NotebookCellStatusBarItem(
        render.text,
        vscode.NotebookCellStatusBarAlignment.Left
      );
      item.tooltip = render.tooltip;
      const args: SectionActionsArgs = {
        section_id: render.section_id,
        title: render.title,
        status: render.status
      };
      item.command = {
        command: SECTION_HEADER_ACTIONS_COMMAND_ID,
        title: 'LLMNB: Section — actions',
        arguments: [args]
      };
      return [item];
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section-actions QuickPick command. Surfaced from the status-bar item
// click; routes to the rename / delete / set-status commands shipped in
// section-ops.ts (Phase 2).
// ---------------------------------------------------------------------------

/** The QuickPick action labels. Exported so tests pin the strings. */
export const ACTION_RENAME = 'Rename';
export const ACTION_DELETE = 'Delete';
export const ACTION_SET_STATUS = 'Set status…';

/** Minimal QuickPick abstraction — same shape as SectionPromptSink but
 *  scoped to the actions menu. Tests inject a fake. */
export interface SectionActionsPicker {
  pickAction(items: string[]): Promise<string | undefined>;
}

export class VsCodeSectionActionsPicker implements SectionActionsPicker {
  public async pickAction(items: string[]): Promise<string | undefined> {
    return vscode.window.showQuickPick(items, {
      placeHolder: 'Section action'
    });
  }
}

/** Core action-router: open the QuickPick, dispatch to the right
 *  Phase 2 command. Returns the action chosen (for test assertions),
 *  or undefined when the operator cancels. Pure-vscode-free outside
 *  the executeCommand bridge.
 */
export async function runSectionActionsCommand(
  args: SectionActionsArgs | undefined,
  picker: SectionActionsPicker,
  executeCommand: (id: string, ...args: unknown[]) => Thenable<unknown>
): Promise<string | undefined> {
  if (!args || typeof args.section_id !== 'string' || !args.section_id) {
    return undefined;
  }
  const actions = [ACTION_RENAME, ACTION_SET_STATUS, ACTION_DELETE];
  const choice = await picker.pickAction(actions);
  if (!choice) return undefined;
  if (choice === ACTION_RENAME) {
    const renameArgs: SectionRenameArgs = {
      section_id: args.section_id,
      current_title: args.title
    };
    await executeCommand(SECTION_RENAME_COMMAND_ID, renameArgs);
  } else if (choice === ACTION_DELETE) {
    const deleteArgs: SectionDeleteArgs = {
      section_id: args.section_id,
      title: args.title
    };
    await executeCommand(SECTION_DELETE_COMMAND_ID, deleteArgs);
  } else if (choice === ACTION_SET_STATUS) {
    const statusArgs: SectionSetStatusArgs = {
      section_id: args.section_id
    };
    await executeCommand(SECTION_SET_STATUS_COMMAND_ID, statusArgs);
  }
  return choice;
}

/** Convenience: register both the actions command AND the status-bar
 *  provider with VS Code. Returns the disposables for the extension
 *  activation glue to push into context.subscriptions. */
export function registerSectionHeaderProvider(
  notebookType: string,
  source: SectionMetadataSource,
  picker: SectionActionsPicker = new VsCodeSectionActionsPicker()
): vscode.Disposable[] {
  const provider = new SectionHeaderStatusBarProvider(source);
  const actionsCmd = vscode.commands.registerCommand(
    SECTION_HEADER_ACTIONS_COMMAND_ID,
    (args: SectionActionsArgs | undefined) =>
      runSectionActionsCommand(args, picker, vscode.commands.executeCommand)
  );
  const registration = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
    notebookType,
    provider
  );
  return [provider, actionsCmd, registration];
}
