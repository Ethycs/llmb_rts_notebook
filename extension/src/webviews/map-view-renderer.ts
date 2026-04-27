/// <reference lib="dom" />
//
// Map-view webview renderer (runs inside the webview iframe).
//
// Renders the layout-tree storage structure (chapter 07 §"Layout tree") as
// nested SVG rectangles using a deterministic grid layout. Listens for
// `layout.update` snapshots from the host (RFC-003 §Family B) and posts
// `layout.edit` envelopes back when the operator drags a zone.
//
// V1 deliberately uses raw DOM + SVG without D3 to keep the bundle tiny.
// TODO(V1.5): swap the grid layout for a D3 force-directed pass once the
// dependency cost is justified by the agent-graph overlay.

import type {
  LayoutUpdatePayload,
  LayoutEditPayload,
  LayoutNode,
  AgentGraphResponsePayload
} from '../messaging/types.js';
import type {
  HostToWebviewMessage,
  NodePosition,
  DragState
} from './map-view-types.js';

// VS Code injects acquireVsCodeApi() into the webview global scope.
// See https://code.visualstudio.com/api/extension-guides/webview#scripts-and-message-passing
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_COLORS: Record<string, string> = {
  workspace: '#3a3a3a',
  zone: '#4a90e2',
  file: '#f5f5f5',
  agent: '#5cb85c',
  viewpoint: '#9b59b6',
  annotation: '#f0ad4e'
};

const PADDING = 12;
const NODE_HEIGHT_DEFAULT = 28;
const FILE_WIDTH = 96;
const FILE_HEIGHT = 24;

const vscode = acquireVsCodeApi();

const svg = document.getElementById('map') as unknown as SVGSVGElement | null;
const statusEl = document.getElementById('status');
const tooltipEl = document.getElementById('tooltip');

if (!svg) {
  throw new Error('[map-view] #map svg element missing');
}

let positions = new Map<string, NodePosition>();
let nodesById = new Map<string, LayoutNode>();
let drag: DragState | undefined;
let lastTree: LayoutNode | undefined;
let agentOverlay: AgentGraphResponsePayload | undefined;

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as HostToWebviewMessage | undefined;
  if (!msg || typeof (msg as { type?: unknown }).type !== 'string') {
    return;
  }
  if (msg.type === 'layout.update') {
    onLayoutUpdate(msg.payload);
  } else if (msg.type === 'agent_graph.response') {
    agentOverlay = msg.payload;
    renderOverlay();
  }
});

function onLayoutUpdate(payload: LayoutUpdatePayload): void {
  lastTree = payload.tree;
  positions = new Map();
  nodesById = new Map();
  indexNodes(payload.tree);
  layoutTree(payload.tree, PADDING, PADDING, getViewportWidth() - PADDING * 2);
  render();
  setStatus(`layout v${payload.snapshot_version} (${nodesById.size} nodes)`);
}

function indexNodes(node: LayoutNode): void {
  nodesById.set(node.id, node);
  for (const c of node.children) {
    indexNodes(c);
  }
}

/** Deterministic grid layout: workspaces tile horizontally; zones inside a
 *  workspace tile vertically; files inside a zone tile in a left-to-right
 *  grid. If a node carries an explicit `render_hints.position`, that
 *  overrides the computed coordinate (see chapter 07 §"Layout tree"). */
function layoutTree(
  node: LayoutNode,
  x: number,
  y: number,
  availableWidth: number
): NodePosition {
  const hint = readPositionHint(node);
  let nx = hint?.x ?? x;
  let ny = hint?.y ?? y;

  // Files are leaves with a fixed footprint.
  if (node.type === 'file' || node.children.length === 0) {
    const w = node.type === 'file' ? FILE_WIDTH : Math.max(64, availableWidth);
    const h = node.type === 'file' ? FILE_HEIGHT : NODE_HEIGHT_DEFAULT;
    const pos: NodePosition = { x: nx, y: ny, width: w, height: h };
    positions.set(node.id, pos);
    return pos;
  }

  const headerHeight = NODE_HEIGHT_DEFAULT;
  const innerX = nx + PADDING;
  let innerY = ny + headerHeight + PADDING / 2;
  let innerWidth = Math.max(120, availableWidth - PADDING * 2);

  if (node.type === 'workspace') {
    // Workspace: tile zones vertically. Make the workspace as wide as
    // the wide-enough child needs.
    let maxChildW = innerWidth;
    for (const child of node.children) {
      const cpos = layoutTree(child, innerX, innerY, innerWidth);
      innerY = cpos.y + cpos.height + PADDING / 2;
      maxChildW = Math.max(maxChildW, cpos.width);
    }
    const totalH = innerY - ny + PADDING / 2;
    const pos: NodePosition = {
      x: nx,
      y: ny,
      width: maxChildW + PADDING * 2,
      height: Math.max(NODE_HEIGHT_DEFAULT * 2, totalH)
    };
    positions.set(node.id, pos);
    return pos;
  }

  if (node.type === 'zone') {
    // Zone: tile children (files / sub-zones) in a horizontal grid.
    let cursorX = innerX;
    let cursorY = innerY;
    let rowMaxH = 0;
    const wrapAt = nx + innerWidth + PADDING;
    for (const child of node.children) {
      const cpos = layoutTree(child, cursorX, cursorY, FILE_WIDTH);
      if (cursorX + cpos.width > wrapAt && cursorX !== innerX) {
        cursorX = innerX;
        cursorY += rowMaxH + PADDING / 2;
        rowMaxH = 0;
        const wrapped = layoutTree(child, cursorX, cursorY, FILE_WIDTH);
        cursorX += wrapped.width + PADDING / 2;
        rowMaxH = Math.max(rowMaxH, wrapped.height);
      } else {
        cursorX += cpos.width + PADDING / 2;
        rowMaxH = Math.max(rowMaxH, cpos.height);
      }
    }
    const pos: NodePosition = {
      x: nx,
      y: ny,
      width: innerWidth + PADDING * 2,
      height: cursorY + rowMaxH - ny + PADDING
    };
    positions.set(node.id, pos);
    return pos;
  }

  // Default: treat as a generic container with vertical stacking.
  let stackY = innerY;
  for (const child of node.children) {
    const cpos = layoutTree(child, innerX, stackY, innerWidth);
    stackY = cpos.y + cpos.height + PADDING / 2;
  }
  const pos: NodePosition = {
    x: nx,
    y: ny,
    width: innerWidth + PADDING * 2,
    height: stackY - ny + PADDING / 2
  };
  positions.set(node.id, pos);
  return pos;
}

function readPositionHint(node: LayoutNode): { x: number; y: number } | undefined {
  const hints = node.render_hints;
  if (!hints) {
    return undefined;
  }
  const p = (hints as Record<string, unknown>)['position'];
  if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number') {
    return { x: p[0], y: p[1] };
  }
  return undefined;
}

function readColorHint(node: LayoutNode): string {
  const hints = node.render_hints;
  if (hints && typeof (hints as Record<string, unknown>)['color'] === 'string') {
    return (hints as Record<string, string>)['color'];
  }
  return DEFAULT_COLORS[node.type] ?? '#666';
}

function readLabel(node: LayoutNode): string {
  const hints = node.render_hints;
  if (hints && typeof (hints as Record<string, unknown>)['label'] === 'string') {
    return (hints as Record<string, string>)['label'];
  }
  return node.id;
}

function render(): void {
  while (svg!.firstChild) {
    svg!.removeChild(svg!.firstChild);
  }
  if (!lastTree) {
    return;
  }
  const root = document.createElementNS(SVG_NS, 'g');
  root.setAttribute('id', 'map-root');
  svg!.appendChild(root);
  renderNode(lastTree, root);
  renderOverlay();
}

function renderNode(node: LayoutNode, parent: SVGGElement): void {
  const pos = positions.get(node.id);
  if (!pos) {
    return;
  }
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('data-node-id', node.id);
  g.setAttribute('data-node-type', node.type);

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'node-rect');
  rect.setAttribute('x', String(pos.x));
  rect.setAttribute('y', String(pos.y));
  rect.setAttribute('width', String(pos.width));
  rect.setAttribute('height', String(pos.height));
  rect.setAttribute('fill', readColorHint(node));
  rect.setAttribute('fill-opacity', node.type === 'workspace' ? '0.18' : '0.35');
  rect.setAttribute('stroke', readColorHint(node));
  rect.setAttribute('stroke-opacity', '0.8');
  rect.setAttribute('rx', '4');
  g.appendChild(rect);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'node-label');
  label.setAttribute('x', String(pos.x + 6));
  label.setAttribute('y', String(pos.y + 14));
  label.setAttribute('font-size', '11');
  label.textContent = `${readLabel(node)}  [${node.type}]`;
  g.appendChild(label);

  // Drag-and-drop is only enabled for zones (V1 scope).
  if (node.type === 'zone') {
    g.style.cursor = 'move';
    g.addEventListener('mousedown', (e) => beginDrag(node.id, e as MouseEvent));
  }

  g.addEventListener('mousemove', (e) => showTooltip(node, e as MouseEvent));
  g.addEventListener('mouseleave', () => hideTooltip());

  parent.appendChild(g);

  for (const child of node.children) {
    renderNode(child, g);
  }
}

function renderOverlay(): void {
  if (!agentOverlay || !svg) {
    return;
  }
  // TODO(V1.5): edges as curved paths; clusters; agent inspector popup.
  const existing = svg.querySelector('#agent-overlay');
  if (existing) {
    existing.remove();
  }
  const overlay = document.createElementNS(SVG_NS, 'g');
  overlay.setAttribute('id', 'agent-overlay');

  // Edges first so they sit beneath nodes.
  for (const edge of agentOverlay.edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) {
      continue;
    }
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x + a.width / 2));
    line.setAttribute('y1', String(a.y + a.height / 2));
    line.setAttribute('x2', String(b.x + b.width / 2));
    line.setAttribute('y2', String(b.y + b.height / 2));
    line.setAttribute('stroke', '#888');
    line.setAttribute('stroke-opacity', '0.4');
    line.setAttribute('stroke-width', '1');
    overlay.appendChild(line);
  }

  // Agents render as small circles anchored to their associated zone.
  for (const node of agentOverlay.nodes) {
    if (node.type !== 'agent') {
      continue;
    }
    let anchor = positions.get(node.id);
    if (!anchor) {
      // Find an in_zone edge to locate the agent.
      const zoneEdge = agentOverlay.edges.find(
        (e) => e.source === node.id && e.kind === 'in_zone'
      );
      if (zoneEdge) {
        anchor = positions.get(zoneEdge.target);
      }
    }
    if (!anchor) {
      continue;
    }
    const cx = anchor.x + 14;
    const cy = anchor.y + anchor.height - 14;
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '6');
    circle.setAttribute('fill', DEFAULT_COLORS['agent']);
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('data-agent-id', node.id);
    overlay.appendChild(circle);
  }

  svg.appendChild(overlay);
}

// --- drag handling --------------------------------------------------------

function beginDrag(nodeId: string, ev: MouseEvent): void {
  const pos = positions.get(nodeId);
  if (!pos) {
    return;
  }
  ev.preventDefault();
  drag = {
    nodeId,
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    startX: pos.x,
    startY: pos.y,
    currentX: pos.x,
    currentY: pos.y
  };
  const g = svg!.querySelector(`g[data-node-id="${cssEscape(nodeId)}"] rect.node-rect`);
  g?.classList.add('dragging');
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

function onDragMove(ev: MouseEvent): void {
  if (!drag) {
    return;
  }
  const dx = ev.clientX - drag.startClientX;
  const dy = ev.clientY - drag.startClientY;
  drag.currentX = drag.startX + dx;
  drag.currentY = drag.startY + dy;
  // Move only the dragged subtree's outermost <g> via transform; cheaper
  // than a full relayout while the operator drags.
  const node = svg!.querySelector(`g[data-node-id="${cssEscape(drag.nodeId)}"]`);
  if (node) {
    (node as SVGGElement).setAttribute('transform', `translate(${dx}, ${dy})`);
  }
}

function onDragEnd(_ev: MouseEvent): void {
  if (!drag) {
    return;
  }
  const finished = drag;
  drag = undefined;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  const rect = svg!.querySelector(`g[data-node-id="${cssEscape(finished.nodeId)}"] rect.node-rect`);
  rect?.classList.remove('dragging');

  const edit: LayoutEditPayload = {
    operation: 'update_render_hints',
    parameters: {
      node_id: finished.nodeId,
      render_hints: { position: [finished.currentX, finished.currentY] }
    }
  };
  vscode.postMessage({ type: 'layout.edit', payload: edit });
  setStatus(`edit posted: move ${finished.nodeId}`);
}

// --- tooltip --------------------------------------------------------------

function showTooltip(node: LayoutNode, ev: MouseEvent): void {
  if (!tooltipEl) {
    return;
  }
  tooltipEl.textContent = `${node.id} (${node.type}) — ${node.children.length} child(ren)`;
  tooltipEl.style.display = 'block';
  tooltipEl.style.left = `${ev.clientX + 12}px`;
  tooltipEl.style.top = `${ev.clientY + 12}px`;
}

function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

// --- helpers --------------------------------------------------------------

function getViewportWidth(): number {
  return Math.max(400, window.innerWidth || 800);
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function cssEscape(s: string): string {
  // Subset of CSS.escape that is safe for our id charset.
  return s.replace(/(["\\])/g, '\\$1');
}

window.addEventListener('resize', () => {
  if (lastTree) {
    positions = new Map();
    layoutTree(lastTree, PADDING, PADDING, getViewportWidth() - PADDING * 2);
    render();
  }
});

// Tell the host we are ready (no envelope; just a UI signal).
setStatus('layout: ready (waiting for snapshot)…');
