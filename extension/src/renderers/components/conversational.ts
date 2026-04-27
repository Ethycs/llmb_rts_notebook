// Renderers for the four conversational RFC-001 tools:
//   §ask, §clarify, §present, §escalate.
//
// Interactivity (submit/select/acknowledge) is wired by run-renderer.ts
// via a delegated click/submit listener that reads `data-rts-action`
// attributes and posts an RFC-003 §operator.action envelope to the host
// via ctx.postMessage. The host translates the action into the kernel's
// resolve-side surface for ask/clarify/escalate (RFC-001 outputs) and
// into a vscode.commands.executeCommand call for §present's "Show
// artifact" button.

import type { RendererContext } from 'vscode-notebook-renderer';
import { escapeHtml, escapeAttr } from './escape.js';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

interface ClarifyOption {
  id?: string;
  label?: string;
  description?: string;
}

/** RFC-001 §ask. Free-text question; blocks until answered. */
export function renderAsk(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const id = nextId('ask');
  const inputId = `${id}-answer`;
  const question = String(args['question'] ?? '');
  const context = String(args['context'] ?? '');
  const ctxBlock = context
    ? `<div class="rts-card-body"><em>${escapeHtml(context)}</em></div>`
    : '';
  return `
<div class="rts-card rts-ask" id="${escapeAttr(id)}" data-rts-tool="ask" data-rts-run-id="${escapeAttr(runId)}">
  <div class="rts-card-title">${escapeHtml(question)}</div>
  ${ctxBlock}
  <textarea class="rts-textarea" id="${escapeAttr(inputId)}" rows="3" data-rts-input-for="${escapeAttr(id)}" placeholder="Type your answer…"></textarea>
  <div class="rts-button-row">
    <button type="button" class="rts-button-approve" data-rts-action="ask_response" data-rts-run-id="${escapeAttr(runId)}" data-rts-input-id="${escapeAttr(inputId)}">Submit</button>
  </div>
</div>`;
}

/** RFC-001 §clarify. Discrete option set; renderer surfaces a radio picker. */
export function renderClarify(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const id = nextId('clarify');
  const groupName = `${id}-opt`;
  const question = String(args['question'] ?? '');
  const defaultId = String(args['default_id'] ?? '');
  const options = Array.isArray(args['options'])
    ? (args['options'] as ClarifyOption[])
    : [];
  const items = options
    .map((opt) => {
      const optId = String(opt.id ?? '');
      const label = String(opt.label ?? optId);
      const desc = String(opt.description ?? '');
      const checked = optId === defaultId ? ' checked' : '';
      const descBlock = desc
        ? ` <span class="rts-card-body">${escapeHtml(desc)}</span>`
        : '';
      return `<li><label><input type="radio" name="${escapeAttr(groupName)}" value="${escapeAttr(optId)}"${checked}> ${escapeHtml(label)}</label>${descBlock}</li>`;
    })
    .join('');
  return `
<div class="rts-card rts-clarify" id="${escapeAttr(id)}" data-rts-tool="clarify" data-rts-run-id="${escapeAttr(runId)}">
  <div class="rts-card-title">${escapeHtml(question)}</div>
  <ul class="rts-radio-list">${items}</ul>
  <div class="rts-button-row">
    <button type="button" class="rts-button-approve" data-rts-action="clarify_response" data-rts-run-id="${escapeAttr(runId)}" data-rts-radio-name="${escapeAttr(groupName)}">Submit</button>
  </div>
</div>`;
}

/** RFC-001 §present. Generated artifact lifted to the artifacts surface. */
export function renderPresent(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const id = nextId('present');
  const kind = String(args['kind'] ?? '');
  const summary = String(args['summary'] ?? '');
  const artifact = (args['artifact'] && typeof args['artifact'] === 'object')
    ? (args['artifact'] as Record<string, unknown>)
    : {};
  const uri = String(artifact['uri'] ?? '');
  const language = String(artifact['language'] ?? '');
  // TODO(C2): inline body preview for kind=code|diff|json with syntax
  // highlighting once the present-viewer integration lands.
  return `
<div class="rts-card rts-present" id="${escapeAttr(id)}" data-rts-tool="present" data-rts-run-id="${escapeAttr(runId)}">
  <div class="rts-card-title">[present:${escapeHtml(kind)}] ${escapeHtml(summary)}</div>
  ${uri ? `<div class="rts-card-body"><span class="rts-mono">${escapeHtml(uri)}</span>${language ? ` (${escapeHtml(language)})` : ''}</div>` : ''}
  <div class="rts-button-row">
    <button type="button" class="rts-button-secondary" data-rts-action="present_show" data-rts-run-id="${escapeAttr(runId)}" data-rts-artifact-kind="${escapeAttr(kind)}" data-rts-artifact-uri="${escapeAttr(uri)}">Show artifact</button>
  </div>
</div>`;
}

/** RFC-001 §escalate. Demands urgent operator attention. */
export function renderEscalate(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const id = nextId('escalate');
  const reason = String(args['reason'] ?? '');
  const severity = String(args['severity'] ?? 'medium');
  const context = String(args['context'] ?? '');
  const ctxBlock = context
    ? `<div class="rts-card-body">${escapeHtml(context)}</div>`
    : '';
  return `
<div class="rts-card rts-escalate-banner" id="${escapeAttr(id)}" data-rts-tool="escalate" data-rts-run-id="${escapeAttr(runId)}" data-severity="${escapeAttr(severity)}">
  <div class="rts-card-title"><span class="rts-severity-badge" data-severity="${escapeAttr(severity === 'critical' ? 'fatal' : 'error')}">${escapeHtml(severity)}</span>[ESCALATE] ${escapeHtml(reason)}</div>
  ${ctxBlock}
  <div class="rts-button-row">
    <button type="button" class="rts-button-approve" data-rts-action="dismiss_notification" data-rts-run-id="${escapeAttr(runId)}">Acknowledge</button>
  </div>
</div>`;
}
