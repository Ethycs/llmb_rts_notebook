// PLAN-S10 sidebar-search WebviewView — host-side provider.
//
// Registered in extension.ts as the 4th view in the existing `llmnb`
// activity-bar container (Zones / Agents / Recent activity / Find).
//
// Lifecycle:
//   - `resolveWebviewView` builds the HTML, wires postMessage handlers.
//   - On `search` from the webview: run match-finder against the active
//     llmnb notebook, post `results` back. Empty notebook / no editor
//     → empty results (not an error).
//   - On `navigate` from the webview: run `llmnb.revealCell` with the
//     cell id (the existing PLAN-S5.0.2 command).
//   - On notebook content changes (`onDidChangeNotebookDocument`) or
//     active-editor flips, re-run the last query so the operator sees
//     live results without having to retype.

import * as vscode from 'vscode';
import { findMatches } from './match-finder.js';
import { getSearchViewHtml } from './search-view-html.js';
import type {
  HostToWebviewMessage,
  SearchOptions,
  WebviewToHostMessage
} from './types.js';
import { REVEAL_CELL_COMMAND_ID } from '../../notebook/commands/reveal-cell.js';

/** View id registered in `package.json` `contributes.views.llmnb[]`. */
export const SEARCH_VIEW_ID = 'llmnb.search';

/** Minimal indirection so tests can drive the navigate path without
 *  going through VS Code's command surface. */
export interface NavigateRunner {
  reveal(cellId: string): void;
}

/** Production navigator — fires the canonical `llmnb.revealCell`. */
export class CommandNavigateRunner implements NavigateRunner {
  public reveal(cellId: string): void {
    void vscode.commands.executeCommand(REVEAL_CELL_COMMAND_ID, { cell_id: cellId });
  }
}

/** Read the active notebook + the cells the operator currently has
 *  selected. The selection only matters when `scope === "selected"`. */
function readActiveContext(notebookType: string): {
  notebook: vscode.NotebookDocument | undefined;
  selected: ReadonlySet<number>;
} {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== notebookType) {
    return { notebook: undefined, selected: new Set() };
  }
  const selected = new Set<number>();
  for (const sel of editor.selections) {
    for (let i = sel.start; i < sel.end; i += 1) selected.add(i);
  }
  return { notebook: editor.notebook, selected };
}

export class SearchViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private lastOptions: SearchOptions | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly notebookType: string,
    private readonly navigator: NavigateRunner = new CommandNavigateRunner()
  ) {
    // Live updates — re-run the last search when the underlying notebook
    // or active editor changes. The 200ms debounce lives webview-side;
    // host-side re-runs are coalesced via `queueMicrotask` so a single
    // VS Code event doesn't trigger multiple postResults.
    this.subscriptions.push(
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (e.notebook.notebookType === this.notebookType) this.runIfReady();
      }),
      vscode.window.onDidChangeActiveNotebookEditor(() => this.runIfReady()),
      vscode.window.onDidChangeNotebookEditorSelection((e) => {
        if (e.notebookEditor.notebook.notebookType === this.notebookType) {
          // Only matters when the scope is "selected"; we still re-run
          // unconditionally because the cost is bounded by the per-cell
          // / total caps in match-finder.
          this.runIfReady();
        }
      })
    );
  }

  public dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // The `dist/` directory holds the bundled webview script and is
      // the only filesystem root the webview is allowed to read from.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    };
    webviewView.webview.html = getSearchViewHtml(webviewView.webview, this.extensionUri);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => this.handleMessage(raw));
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Test seam — drive a search and synchronously return the result
   *  message that would be posted to the webview. Pure under the
   *  hood (delegates to `findMatches`). */
  public runSearch(options: SearchOptions): HostToWebviewMessage {
    this.lastOptions = options;
    const { notebook, selected } = readActiveContext(this.notebookType);
    const results = findMatches(notebook, selected, options);
    return results;
  }

  private handleMessage(raw: unknown): void {
    const msg = raw as WebviewToHostMessage | undefined;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
      case 'search': {
        const options = msg.type === 'search' ? msg.options : emptyOptions();
        this.lastOptions = options;
        this.postResults(options);
        return;
      }
      case 'navigate':
        if (typeof msg.cellId === 'string' && msg.cellId.length > 0) {
          this.navigator.reveal(msg.cellId);
        }
        return;
    }
  }

  private runIfReady(): void {
    if (!this.view || !this.lastOptions) return;
    // If the operator hasn't typed anything yet, skip — no need to
    // post empty results on every keystroke elsewhere.
    if (this.lastOptions.query.length === 0) return;
    queueMicrotask(() => this.postResults(this.lastOptions!));
  }

  private postResults(options: SearchOptions): void {
    if (!this.view) return;
    const { notebook, selected } = readActiveContext(this.notebookType);
    const results = findMatches(notebook, selected, options);
    void this.view.webview.postMessage(results);
  }
}

function emptyOptions(): SearchOptions {
  return {
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: 'all'
  };
}
