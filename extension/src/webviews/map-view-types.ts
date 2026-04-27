// Shared types between the host (extension) and the webview script.
//
// The host posts these messages into the webview via panel.webview.postMessage;
// the webview posts back via vscode.postMessage. Both sides MUST agree on
// the discriminated `type` field. These shapes are deliberately minimal —
// they wrap RFC-003 payloads (defined in messaging/types.ts) rather than
// re-declaring them, so the canonical schema lives in exactly one place.
//
// References:
//   docs/dev-guide/07-subtractive-fork-and-storage.md §"Layout tree"
//   docs/rfcs/RFC-003-custom-message-format.md §"Family B — Layout"
//   docs/rfcs/RFC-003-custom-message-format.md §"Family C — Agent graph"

import type {
  LayoutUpdatePayload,
  LayoutEditPayload,
  AgentGraphResponsePayload
} from '../messaging/types.js';

/** Host → webview: the host sends snapshots and graph data this way. */
export type HostToWebviewMessage =
  | { type: 'layout.update'; payload: LayoutUpdatePayload }
  | { type: 'agent_graph.response'; payload: AgentGraphResponsePayload };

/** Webview → host: the only outbound message in V1 is a layout edit
 *  produced by drag-and-drop. (Hover tooltips and zoom stay client-side.) */
export type WebviewToHostMessage = {
  type: 'layout.edit';
  payload: LayoutEditPayload;
};

/** Computed 2-D position for a layout node, in webview-local pixel space. */
export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drag state held by the webview-side renderer while a zone is being moved.
 *  TODO(V1.5): replace with a proper interaction layer once D3 lands. */
export interface DragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}
