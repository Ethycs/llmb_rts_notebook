// Renderer for RFC-001 §request_approval and RFC-001 §propose.
//
// Both render an approval-style card with action title, rationale,
// risk/scope badge, an optional "Show diff" affordance, two action
// buttons (Approve/Reject) and an optional "Show alternatives" toggle.
// On click, the renderer posts an RFC-003 §operator.action envelope of
// action_type=approval_response back to the extension host via
// ctx.postMessage; the host forwards it to the kernel.
//
// Interactivity is wired by run-renderer.ts via a delegated click
// handler that inspects `data-rts-action` / `data-rts-toggle` attributes
// (innerHTML-injected <script> tags do not execute, hence delegation).

import type { RendererContext } from 'vscode-notebook-renderer';
import { escapeHtml, escapeAttr } from './escape.js';

let cardCounter = 0;
function nextCardId(prefix: string): string {
  cardCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${cardCounter}`;
}

interface DiffPreview {
  kind?: string;
  body?: string;
  file_a?: string;
  file_b?: string;
}

interface Alternative {
  label?: string;
  description?: string;
}

function readDiffPreview(args: Record<string, unknown>): DiffPreview | null {
  const dp = args['diff_preview'];
  if (!dp || typeof dp !== 'object') return null;
  return dp as DiffPreview;
}

function readAlternatives(args: Record<string, unknown>): Alternative[] {
  const alts = args['alternatives'];
  return Array.isArray(alts) ? (alts as Alternative[]) : [];
}

function readPreview(args: Record<string, unknown>): DiffPreview | null {
  // RFC-001 §propose uses `preview` (not `diff_preview`); same shape suffices.
  const p = args['preview'];
  if (!p || typeof p !== 'object') return null;
  return p as DiffPreview;
}

/** Shared HTML generator for approval-style cards. */
function buildCard(opts: {
  toolName: 'request_approval' | 'propose';
  action: string;
  rationale: string;
  riskOrScope: string;
  riskAttr: 'risk' | 'scope';
  preview: DiffPreview | null;
  alternatives: Alternative[];
  runId: string;
}): string {
  const cardId = nextCardId(opts.toolName);
  const altsId = `${cardId}-alts`;
  const diffId = `${cardId}-diff`;
  const runIdAttr = escapeAttr(opts.runId);
  const previewBlock = opts.preview && opts.preview.body
    ? `<pre class="rts-terminal-block" id="${escapeAttr(diffId)}" hidden>${escapeHtml(String(opts.preview.body))}</pre>`
    : '';
  const showDiff = opts.preview
    ? `<button type="button" class="rts-button-secondary" data-rts-toggle="${escapeAttr(diffId)}">Show diff</button>`
    : '';
  const altsBlock = opts.alternatives.length
    ? `<ul class="rts-artifact-list" id="${escapeAttr(altsId)}" hidden>${opts.alternatives
        .map((a) =>
          `<li><strong>${escapeHtml(String(a.label ?? ''))}</strong>: ${escapeHtml(String(a.description ?? ''))}</li>`
        )
        .join('')}</ul>`
    : '';
  const showAlts = opts.alternatives.length
    ? `<button type="button" class="rts-button-secondary" data-rts-toggle="${escapeAttr(altsId)}">Show alternatives (${opts.alternatives.length})</button>`
    : '';
  // TODO(C2): expose modify/defer decisions per RFC-001 §request_approval
  // output enum once the operator-action router supports the richer set.
  return `
<div class="rts-card rts-approval-card" data-${opts.riskAttr}="${escapeAttr(opts.riskOrScope)}" id="${escapeAttr(cardId)}" data-rts-tool="${escapeAttr(opts.toolName)}" data-rts-run-id="${runIdAttr}">
  <div class="rts-card-title">[${escapeHtml(opts.toolName)}] ${escapeHtml(opts.action)}<span class="rts-risk-badge">${escapeHtml(opts.riskOrScope)}</span></div>
  <div class="rts-card-body">${escapeHtml(opts.rationale)}</div>
  ${previewBlock}
  <div class="rts-button-row">
    <button type="button" class="rts-button-approve" data-rts-action="approval_response" data-rts-decision="approve" data-rts-run-id="${runIdAttr}">Approve</button>
    <button type="button" class="rts-button-reject" data-rts-action="approval_response" data-rts-decision="reject" data-rts-run-id="${runIdAttr}">Reject</button>
    ${showDiff}
    ${showAlts}
  </div>
  ${altsBlock}
</div>`;
}

/** RFC-001 §request_approval. Hard gate; operator MUST act. */
export function renderRequestApproval(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const action = String(args['action'] ?? '');
  const rationale = String(args['rationale'] ?? args['description'] ?? '');
  const risk = String(args['risk_level'] ?? 'medium');
  return buildCard({
    toolName: 'request_approval',
    action,
    rationale,
    riskOrScope: risk,
    riskAttr: 'risk',
    preview: readDiffPreview(args),
    alternatives: readAlternatives(args),
    runId
  });
}

/** RFC-001 §propose. Coarse-grained design decision; richer than approval. */
export function renderPropose(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const action = String(args['action'] ?? '');
  const rationale = String(args['rationale'] ?? '');
  const scope = String(args['scope'] ?? 'one_shot');
  // TODO(C2): render `propose.preview` (kind=text|diff|plan|code|json)
  // with kind-aware syntax highlighting; deferred to S3's diff integration.
  return buildCard({
    toolName: 'propose',
    action,
    rationale,
    riskOrScope: scope,
    riskAttr: 'scope',
    preview: readPreview(args),
    alternatives: [],
    runId
  });
}
