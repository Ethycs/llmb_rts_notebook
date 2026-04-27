// Renderers for RFC-001 §report_progress, §report_completion, and
// §report_problem. All three are non-interactive (no operator response).
//
// - report_progress: progress bar + status + optional blockers list
// - report_completion: green check icon + summary + artifact list
// - report_problem: severity badge + description + remediation

import type { RendererContext } from 'vscode-notebook-renderer';
import { escapeHtml, escapeAttr } from './escape.js';

/** RFC-001 §report_progress. Non-blocking status update. */
export function renderReportProgress(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const status = String(args['status'] ?? '');
  const percentRaw = args['percent'];
  const percent = typeof percentRaw === 'number'
    ? Math.max(0, Math.min(100, percentRaw))
    : null;
  const blockers = Array.isArray(args['blockers']) ? (args['blockers'] as unknown[]) : [];
  const bar = percent !== null
    ? `<div class="rts-progress-bar" role="progressbar" aria-valuenow="${escapeAttr(String(percent))}" aria-valuemin="0" aria-valuemax="100"><div class="rts-progress-fill" style="width:${percent}%"></div></div>`
    : '';
  const blockersList = blockers.length
    ? `<ul class="rts-artifact-list">${blockers.map((b) => `<li>${escapeHtml(String(b))}</li>`).join('')}</ul>`
    : '';
  const pctLabel = percent !== null ? ` (${percent}%)` : '';
  return `<div class="rts-card rts-report-progress"><div class="rts-card-title">${escapeHtml(status)}${pctLabel}</div>${bar}${blockersList}</div>`;
}

/** RFC-001 §report_completion. Final success/partial/aborted signal. */
export function renderReportCompletion(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const summary = String(args['summary'] ?? '');
  const outcome = String(args['outcome'] ?? 'success');
  const artifactsRaw = Array.isArray(args['artifacts'])
    ? (args['artifacts'] as Array<Record<string, unknown>>)
    : [];
  // Preserve the V1 token "[COMPLETED]" so existing smoke tests still match.
  const items = artifactsRaw
    .map((a) => {
      const kind = escapeHtml(String(a['kind'] ?? ''));
      const uri = String(a['uri'] ?? '');
      const title = String(a['title'] ?? uri);
      const link = uri
        ? `<a href="${escapeAttr(uri)}">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      return `<li>${kind}: ${uri ? `${link} ` : ''}<span class="rts-mono">${escapeHtml(uri)}</span></li>`;
    })
    .join('');
  const list = items ? `<ul class="rts-artifact-list">${items}</ul>` : '';
  return `<div class="rts-card rts-report-completion" data-outcome="${escapeAttr(outcome)}"><div class="rts-card-title"><span class="rts-check-icon" aria-hidden="true"></span>[COMPLETED] ${escapeHtml(summary)}</div>${list}</div>`;
}

/** RFC-001 §report_problem. Documented fault; severity-tagged. */
export function renderReportProblem(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const severity = String(args['severity'] ?? 'info');
  const description = String(args['description'] ?? '');
  const remediation = args['suggested_remediation'];
  const related = Array.isArray(args['related_artifacts'])
    ? (args['related_artifacts'] as unknown[])
    : [];
  const remBlock = remediation
    ? `<div class="rts-card-body"><strong>Remediation:</strong> ${escapeHtml(String(remediation))}</div>`
    : '';
  const relBlock = related.length
    ? `<ul class="rts-artifact-list">${related.map((r) => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>`
    : '';
  return `<div class="rts-card rts-report-problem"><div class="rts-card-title"><span class="rts-severity-badge" data-severity="${escapeAttr(severity)}">${escapeHtml(severity)}</span>${escapeHtml(description)}</div>${remBlock}${relBlock}</div>`;
}
