// PLAN-S10 sidebar-search WebviewView — HTML host.
//
// Mirrors the map-view-html pattern: CSP nonce + asWebviewUri for the
// bundled script. The webview lives inside the `llmnb` activity-bar
// container (see package.json) so the layout is sidebar-narrow; the
// CSS targets that constraint with a vertical flow.

import * as vscode from 'vscode';

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

export function getSearchViewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = makeNonce();
  const cspSource = webview.cspSource;

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'search-view.js')
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} https: data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline' 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LLMNB Find in cells</title>
<style nonce="${nonce}">
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: var(--vscode-sideBar-background, #1e1e1e);
    color: var(--vscode-sideBar-foreground, #cccccc);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }
  body { display: flex; flex-direction: column; }
  .toolbar { padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); }
  .row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  .row:last-child { margin-bottom: 0; }
  input[type="text"] {
    flex: 1;
    box-sizing: border-box;
    padding: 3px 6px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--vscode-focusBorder, #007acc); }
  input[type="text"].error { border-color: var(--vscode-errorForeground, #f48771); }
  select {
    flex: 1;
    padding: 2px 4px;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, #cccccc);
    border: 1px solid var(--vscode-dropdown-border, transparent);
  }
  button.icon {
    background: transparent;
    color: var(--vscode-icon-foreground, #cccccc);
    border: 1px solid transparent;
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
  }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
  button.icon[aria-pressed="true"] {
    background: var(--vscode-inputOption-activeBackground, rgba(14,99,156,0.4));
    border-color: var(--vscode-inputOption-activeBorder, #0e639c);
    color: var(--vscode-inputOption-activeForeground, #ffffff);
  }
  button.icon[disabled] { opacity: 0.4; cursor: default; }
  .counter {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-left: auto;
  }
  .counter.error { color: var(--vscode-errorForeground, #f48771); }
  ul.results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }
  ul.results li {
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.05));
    cursor: pointer;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.4;
    word-break: break-all;
  }
  ul.results li:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
  ul.results li.active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }
  ul.results li .cell-label {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    margin-right: 6px;
  }
  ul.results li mark {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,200,0,0.5));
    color: inherit;
    font-weight: bold;
  }
  ul.results li.active mark {
    background: var(--vscode-editor-findMatchBackground, rgba(234,200,0,0.7));
  }
  .empty {
    padding: 12px 8px;
    color: var(--vscode-descriptionForeground, #888);
    font-style: italic;
  }
  .truncated {
    padding: 6px 8px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.05));
  }
</style>
</head>
<body>
<div class="toolbar">
  <div class="row">
    <input id="query" type="text" placeholder="Find in cells" autocomplete="off" spellcheck="false" />
    <button class="icon" id="toggle-case" title="Match case" aria-pressed="false">Aa</button>
    <button class="icon" id="toggle-word" title="Match whole word" aria-pressed="false">⚫</button>
    <button class="icon" id="toggle-regex" title="Use regex" aria-pressed="false">.*</button>
  </div>
  <div class="row">
    <select id="scope">
      <option value="all">All cells</option>
      <option value="inputs">Inputs only</option>
      <option value="outputs">Outputs only</option>
      <option value="tool_calls">Tool calls only</option>
      <option value="selected">Selected cells only</option>
    </select>
    <button class="icon" id="prev" title="Previous match (Shift+Enter)" disabled>↑</button>
    <button class="icon" id="next" title="Next match (Enter)" disabled>↓</button>
    <span class="counter" id="counter">No results</span>
  </div>
</div>
<ul class="results" id="results"></ul>
<div class="truncated" id="truncated" hidden></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
