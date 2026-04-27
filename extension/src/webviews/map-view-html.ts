// Map-view webview HTML generator.
//
// The VS Code Webview API requires that resource URIs go through
// webview.asWebviewUri (see https://code.visualstudio.com/api/extension-guides/webview)
// and that any scripts/styles declare a CSP nonce when allowed. V1 uses a
// permissive CSP that admits inline scripts behind a nonce; V1.5 will tighten
// this once the renderer ships from a bundled module.
//
// Pattern adapted from VS Code Webview docs and from
// vendor/vscode-jupyter/src/platform/webviews/webviewHost.ts (CSP shape).

import * as vscode from 'vscode';

/** Generate a cryptographically-strong nonce for inline script CSP. */
function makeNonce(): string {
  // Use Web Crypto when available (Node 20+ fulfills this); fall back to
  // Math.random for environments that lack it. The nonce is per-load.
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
  for (const b of buf) {
    out += chars[b % chars.length];
  }
  return out;
}

/** Build the HTML string for the map-view webview panel.
 *
 *  TODO(security): the V1 CSP allows 'unsafe-inline' for the renderer script
 *  because we ship the renderer as a single inlined module for development
 *  velocity. V1.5 will switch to a bundled `dist/map-view.js` loaded via
 *  webview.asWebviewUri and drop 'unsafe-inline'. */
export function getMapViewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = makeNonce();
  const cspSource = webview.cspSource;

  // The bundled webview script. esbuild emits dist/map-view.js from
  // map-view-renderer.ts (see build pipeline in package.json scripts).
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'map-view.js')
  );

  // TODO(security): tighten in V1.5 — drop 'unsafe-inline' from script-src
  // and style-src once the renderer is fully out-of-line bundled.
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} https: data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline' 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}' 'unsafe-inline'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LLMNB Map View</title>
  <style nonce="${nonce}">
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ddd);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
    }
    #map {
      display: block;
      width: 100%;
      height: 100vh;
    }
    #status {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 4px;
      pointer-events: none;
      font-size: 11px;
    }
    #tooltip {
      position: absolute;
      pointer-events: none;
      background: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, #ccc);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      display: none;
      z-index: 10;
    }
    .node-label {
      pointer-events: none;
      fill: currentColor;
    }
    .node-rect.dragging {
      stroke: var(--vscode-focusBorder, #007acc);
      stroke-width: 2;
    }
  </style>
</head>
<body>
  <svg id="map" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="status">layout: waiting…</div>
  <div id="tooltip"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
