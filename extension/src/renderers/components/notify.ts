// Renderer for RFC-001 §notify.
//
// Fire-and-forget annotation; no operator interaction. Renders the
// observation text alongside an importance badge color-coded per the
// RFC-001 §notify enum (trace=gray, info=blue, warn=yellow).

import type { RendererContext } from 'vscode-notebook-renderer';
import { escapeHtml, escapeAttr } from './escape.js';

/** RFC-001 §notify importance enum. */
type Importance = 'trace' | 'info' | 'warn';

function normImportance(value: unknown): Importance | '' {
  const s = String(value ?? '');
  return s === 'trace' || s === 'info' || s === 'warn' ? s : '';
}

/**
 * Renders RFC-001 §notify. Preserved byte-for-byte where possible from
 * the original run-renderer.ts implementation; the trailing badge shape
 * is the additive change for Stage 5 S2.
 */
export function renderNotify(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const obs = String(args['observation'] ?? '');
  const imp = normImportance(args['importance']);
  const badge = imp
    ? `<span class="rts-importance-badge" data-importance="${escapeAttr(imp)}">${escapeHtml(imp)}</span>`
    : '';
  // Original V1 line preserved as the body so existing smoke tests still match the text.
  const legacy = `[NOTIFY] ${escapeHtml(obs)} &mdash; importance: ${escapeHtml(imp)}`;
  return `<div class="rts-card rts-notify">${badge}<span class="rts-card-body">${legacy}</span></div>`;
}
