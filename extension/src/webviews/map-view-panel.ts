// Map-view webview panel — host side.
//
// Renders the layout-tree storage structure (chapter 07 §"Layout tree") plus
// optional agent-graph overlay (chapter 07 §"Agent state graph"). The panel
// receives RFC-003 `layout.update` envelopes from the kernel via the
// MessageRouter and emits `layout.edit` envelopes back when the operator
// drags a zone or adds a file. See RFC-003 §"Family B — Layout".
//
// Pattern adapted from
// vendor/vscode-jupyter/src/webviews/extension-side/dataviewer/dataViewer.ts
// (singleton-style panel with reveal/dispose lifecycle) and from VS Code's
// "Markdown Preview" — only one panel exists per workspace.

import * as vscode from 'vscode';
import type {
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphResponsePayload
} from '../messaging/types.js';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage
} from './map-view-types.js';
import { getMapViewHtml } from './map-view-html.js';

/** VS Code view type id for the panel; must be unique per extension. */
const VIEW_TYPE = 'llmnb.mapView';
const PANEL_TITLE = 'LLMNB Map View';

/** Singleton-style host wrapper around `vscode.WebviewPanel`.
 *
 *  V1: one panel per workspace; reopening the command focuses the existing
 *  panel rather than creating a second one. This mirrors the Markdown
 *  Preview pattern shipped with VS Code core. */
export class MapViewPanel {
  private static current: MapViewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly logger: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly editEmitter = new vscode.EventEmitter<LayoutEditPayload>();
  private lastLayout: LayoutUpdatePayload | undefined;
  private lastGraph: AgentGraphResponsePayload | undefined;
  private disposed = false;

  /** Public accessor used by extension.ts to wire the panel into the
   *  MessageRouter's outbound stream after a `show()` call. */
  public readonly onLayoutEditEvent = this.editEmitter.event;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    logger: vscode.LogOutputChannel
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.logger = logger;

    this.panel.webview.html = getMapViewHtml(this.panel.webview, extensionUri);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((raw: unknown) =>
        this.handleWebviewMessage(raw)
      ),
      // When the panel becomes visible after being hidden, re-send the last
      // known state so the webview can re-render. Webviews lose DOM state
      // on hide unless retainContextWhenHidden is set (we don't, to save
      // memory), so we treat resends as the recovery path.
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          if (this.lastLayout) {
            this.postToWebview({ type: 'layout.update', payload: this.lastLayout });
          }
          if (this.lastGraph) {
            this.postToWebview({ type: 'agent_graph.response', payload: this.lastGraph });
          }
        }
      })
    );
  }

  /** Singleton entry point used by the `llmnb.openMapView` command. Creates
   *  or focuses the panel. */
  public static show(
    extensionUri: vscode.Uri,
    logger: vscode.LogOutputChannel
  ): MapViewPanel {
    if (MapViewPanel.current && !MapViewPanel.current.disposed) {
      MapViewPanel.current.panel.reveal(vscode.ViewColumn.Beside, false);
      return MapViewPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        enableCommandUris: false,
        // Restrict resource roots to the extension's dist/ folder where the
        // bundled map-view.js lives. See VS Code Webview API docs.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    MapViewPanel.current = new MapViewPanel(panel, extensionUri, logger);
    return MapViewPanel.current;
  }

  /** Returns the active panel, if any. Used by the router to forward
   *  inbound `layout.update` / `agent_graph.response` envelopes. */
  public static get active(): MapViewPanel | undefined {
    return MapViewPanel.current;
  }

  /** Forward a `layout.update` payload (RFC-003 §Family B) to the webview. */
  public applyLayoutUpdate(payload: LayoutUpdatePayload): void {
    if (this.disposed) {
      return;
    }
    this.lastLayout = payload;
    this.logger.debug(
      `[map-view] layout.update v=${payload.snapshot_version} root=${payload.tree.id}`
    );
    this.postToWebview({ type: 'layout.update', payload });
  }

  /** Forward an `agent_graph.response` payload (RFC-003 §Family C) to the
   *  webview as overlay data. V1 renders agents as circles on top of the
   *  layout tree; full graph rendering lands in V1.5.
   *  TODO(V1.5): force-directed layout for the agent graph. */
  public applyAgentGraphResponse(payload: AgentGraphResponsePayload): void {
    if (this.disposed) {
      return;
    }
    this.lastGraph = payload;
    this.logger.debug(
      `[map-view] agent_graph.response nodes=${payload.nodes.length} edges=${payload.edges.length}`
    );
    this.postToWebview({ type: 'agent_graph.response', payload });
  }

  /** Subscribe to `layout.edit` envelopes produced by the webview (drag-drop
   *  of zones, file moves, etc.). The subscriber should wrap each payload in
   *  an RFC-003 envelope and forward it to the kernel via the router's
   *  outbound queue. */
  public onLayoutEdit(
    callback: (payload: LayoutEditPayload) => void
  ): vscode.Disposable {
    return this.editEmitter.event(callback);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (MapViewPanel.current === this) {
      MapViewPanel.current = undefined;
    }
    while (this.disposables.length > 0) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch (err) {
        this.logger.warn(`[map-view] dispose threw: ${String(err)}`);
      }
    }
    this.editEmitter.dispose();
    try {
      this.panel.dispose();
    } catch {
      // already disposed
    }
  }

  // --- internals -----------------------------------------------------------

  private postToWebview(message: HostToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private handleWebviewMessage(raw: unknown): void {
    if (!isObject(raw) || typeof raw['type'] !== 'string') {
      this.logger.warn('[map-view] discarded webview message: not an object');
      return;
    }
    const msg = raw as Partial<WebviewToHostMessage> & { type: string };
    if (msg.type === 'layout.edit' && isObject(msg.payload)) {
      const payload = msg.payload as LayoutEditPayload;
      if (typeof payload.operation !== 'string' || !isObject(payload.parameters)) {
        this.logger.warn('[map-view] malformed layout.edit from webview');
        return;
      }
      this.editEmitter.fire(payload);
      return;
    }
    this.logger.debug(`[map-view] ignoring webview message: type=${msg.type}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
