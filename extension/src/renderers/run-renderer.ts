/// <reference lib="dom" />
// Notebook renderer for application/vnd.rts.run+json.
//
// RFC-006 §1 dropped the run-lifecycle envelope: cell outputs now carry one
// OTLP/JSON span (or a `{spanId, event}` partial event payload) directly as
// the MIME value. The renderer dispatches on `attributes["llmnb.run_type"]`:
//
//   - `tool`        → per-tool component (RFC-001 catalog)
//   - `agent_emit`  → agent-emit component (RFC-005 §"agent_emit runs")
//   - other         → generic header
//
// Pattern adapted from
// vendor/vscode-jupyter/src/webviews/extension-side/ — vscode-jupyter's
// renderer entrypoints export an `activate(context)` returning
// `{ renderOutputItem }` from a renderer-context module.
//
// I-X scope: removed RFC-003 envelope dispatch (`message_type` switch),
// added agent_emit dispatch, kept the click-handler surface intact.

import type {
  RendererContext,
  OutputItem,
  ActivationFunction
} from 'vscode-notebook-renderer';
import type {
  RunStartPayload,
  RunCompletePayload,
  RunEventPayload,
  RunMimePayload
} from '../messaging/types.js';
import { decodeAttrs, getStringAttr } from '../otel/attrs.js';
import type { OtlpAttribute, OtlpSpan } from '../otel/attrs.js';
import { BlobResolver } from '../llmnb/blob-resolver.js';
import type { BlobEntry } from '../llmnb/blob-resolver.js';
import {
  renderNotify, renderRequestApproval, renderPropose, renderProposeEdit,
  renderReportProgress, renderReportCompletion, renderReportProblem,
  renderAsk, renderClarify, renderPresent, renderEscalate,
  renderReadFile, renderWriteFile, renderRunCommand,
  renderAgentEmit,
  renderProvenanceChip,
  escapeHtml
} from './components/index.js';

/** Per-tool renderer signature. `runId` is the OTLP spanId of the run. */
type ToolRenderer = (
  args: Record<string, unknown>,
  ctx: RendererContext<unknown>,
  runId: string
) => string;

/** RFC-001 §Native + §Proxied tool dispatch table.
 *
 *  BSP-005 S8: `propose_edit` is added alongside the RFC-001 catalog. It is
 *  not (yet) listed in the published RFC-001 tool taxonomy — see the
 *  `BSP-005-cell-roadmap.md` §S8 callout that introduces it; this slice
 *  pins the renderer-side ABI before the RFC catches up. */
const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  notify: renderNotify,
  request_approval: renderRequestApproval,
  propose: renderPropose,
  propose_edit: renderProposeEdit,
  report_progress: renderReportProgress,
  report_completion: renderReportCompletion,
  report_problem: renderReportProblem,
  ask: renderAsk,
  clarify: renderClarify,
  present: renderPresent,
  escalate: renderEscalate,
  read_file: renderReadFile,
  write_file: renderWriteFile,
  run_command: renderRunCommand
};

const STYLE_TAG_ID = 'rts-renderer-style';

export const activate: ActivationFunction = (ctx: RendererContext<unknown>) => {
  ensureStylesInjected();
  return {
    renderOutputItem(item: OutputItem, element: HTMLElement): void {
      try {
        const payload = item.json() as RunMimePayload;
        // PLAN-S5.0.2 §3.2 — provenance chip prepended above the run output
        // when the cell carries `generated_by`. Renderers don't see cell
        // metadata directly; the kernel mirrors the schema fields onto the
        // span attributes (`llmnb.generated_by`, `llmnb.generated_at`,
        // optional `llmnb.generator_text`) and/or the OutputItem metadata
        // so the chip can render in the webview.
        const provenance = extractProvenanceFromOutputItem(item, payload);
        const chipHtml = provenance
          ? renderProvenanceChip(provenance)
          : '';
        element.innerHTML = chipHtml + renderRunMime(payload, ctx);
        installDelegatedHandlers(element, ctx);
      } catch (err) {
        element.textContent = `[run-renderer] failed to render: ${String(err)}`;
      }
    }
  };
};

/** Extract provenance fields for the chip from the run-MIME payload's span
 *  attributes, falling back to the OutputItem's per-output metadata. The
 *  kernel handler may surface the fields on either side; we accept both
 *  for forward compatibility. Returns `undefined` when neither path
 *  carries a `generated_by`. */
function extractProvenanceFromOutputItem(
  item: OutputItem,
  payload: RunMimePayload
): {
  cellId: string;
  generatedBy: string;
  generatedAt: string | null;
  generatorMagicText: string | null;
} | undefined {
  // 1) Span attributes (preferred — flows through the same MIME payload as
  //    the run record itself, no separate metadata channel needed).
  let generatedBy = '';
  let generatedAt: string | null = null;
  let generatorText: string | null = null;
  let cellId = '';
  if (payload && typeof payload === 'object' && 'attributes' in payload) {
    const attrs = (payload as { attributes?: OtlpAttribute[] }).attributes;
    generatedBy = getStringAttr(attrs, 'llmnb.generated_by', '') ?? '';
    const at = getStringAttr(attrs, 'llmnb.generated_at', '');
    generatedAt = typeof at === 'string' && at.length > 0 ? at : null;
    const gt = getStringAttr(attrs, 'llmnb.generator_text', '');
    generatorText = typeof gt === 'string' && gt.length > 0 ? gt : null;
    cellId = getStringAttr(attrs, 'llmnb.cell_id', '') ?? '';
  }
  // 2) OutputItem metadata fallback. The kernel may instead attach the
  //    fields to `cell.outputs[*].metadata.rts` so the renderer picks
  //    them up without polluting the OTLP attribute namespace.
  if (!generatedBy) {
    const meta = item.metadata as { rts?: Record<string, unknown> } | undefined;
    const rts = meta?.rts;
    if (rts && typeof rts === 'object') {
      const gb = (rts as { generated_by?: unknown }).generated_by;
      const ga = (rts as { generated_at?: unknown }).generated_at;
      const gt = (rts as { generator_text?: unknown }).generator_text;
      const cid = (rts as { cell_id?: unknown }).cell_id;
      if (typeof gb === 'string' && gb.length > 0) {
        generatedBy = gb;
      }
      if (typeof ga === 'string' && ga.length > 0) {
        generatedAt = ga;
      }
      if (typeof gt === 'string' && gt.length > 0) {
        generatorText = gt;
      }
      if (typeof cid === 'string' && cid.length > 0) {
        cellId = cid;
      }
    }
  }
  if (generatedBy.length === 0) {
    return undefined;
  }
  return {
    cellId,
    generatedBy,
    generatedAt,
    generatorMagicText: generatorText
  };
}

/** Inject the renderer stylesheet once per webview. */
function ensureStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_TAG_ID;
  link.rel = 'stylesheet';
  link.href = './styles.css';
  document.head.appendChild(link);
}

/** Top-level dispatch on the run-MIME payload. RFC-006 §1: payload is either
 *  a full OtlpSpan (open or closed) or a `{spanId, event}` partial event. */
function renderRunMime(payload: RunMimePayload, ctx: RendererContext<unknown>): string {
  if (!payload || typeof payload !== 'object') {
    return `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  }
  // Partial event shape — `{spanId, event}` (no full span).
  if ('event' in payload && (payload as RunEventPayload).event) {
    const ev = (payload as RunEventPayload).event;
    const evAttrs = decodeAttrs(ev.attributes);
    return `<div class="rts-run-event"><em>${escapeHtml(ev.name)}</em> ${escapeHtml(JSON.stringify(evAttrs))}</div>`;
  }
  // Full span. Distinguish open vs. closed by `endTimeUnixNano`.
  const span = payload as OtlpSpan;
  if (typeof span.spanId !== 'string') {
    return `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  }
  if (span.endTimeUnixNano && span.endTimeUnixNano.length > 0) {
    return renderClosedSpan(span as RunCompletePayload);
  }
  return renderOpenSpan(span as RunStartPayload, ctx);
}

/** Render a closed/terminal span. The status code maps to the V1 UI label. */
function renderClosedSpan(span: RunCompletePayload): string {
  const code = span.status?.code ?? 'STATUS_CODE_UNSET';
  const label = code === 'STATUS_CODE_OK'
    ? 'success'
    : code === 'STATUS_CODE_ERROR'
    ? 'error'
    : 'unset';
  return `<div class="rts-run-complete">[done: ${escapeHtml(label)}]</div>`;
}

/** Render an open/in-progress span. RFC-006 §1: re-emissions are last-writer-
 *  wins; the renderer just re-runs against whatever payload it sees. */
function renderOpenSpan(
  span: RunStartPayload,
  ctx: RendererContext<unknown>
): string {
  const runType = getStringAttr(span.attributes, 'llmnb.run_type');
  const name = span.name;
  const id = span.spanId;
  // RFC-005 §"agent_emit runs": route on llmnb.run_type === "agent_emit".
  if (runType === 'agent_emit') {
    return renderAgentEmit(span.attributes, ctx, id);
  }
  // OpenInference convention: tools put their name in `tool.name`. The
  // domain-aliased `llmnb.tool_name` is also accepted.
  const toolName =
    getStringAttr(span.attributes, 'tool.name') ||
    getStringAttr(span.attributes, 'llmnb.tool_name') ||
    name;
  if (runType === 'tool') {
    const args = parseInputValue(span.attributes);
    // BSP-005 S8: surface the kernel-managed `decision_recorded` flag (set on
    // the span attributes once the operator's Approve/Reject lands) into the
    // args dict so the propose_edit renderer can hide buttons idempotently.
    // Other approval-style tools may opt into the same convention later.
    const recorded = getStringAttr(span.attributes, 'llmnb.approval.decision_recorded');
    if (recorded === 'true') {
      args['decision_recorded'] = true;
    }
    const fn = TOOL_RENDERERS[toolName];
    if (fn) return fn(args, ctx, id);
    return `<div class="rts-tool-generic">[${escapeHtml(toolName)}] ${escapeHtml(JSON.stringify(args))}</div>`;
  }
  return `<div class="rts-run-start"><strong>[${escapeHtml(runType || 'unknown')}] ${escapeHtml(name)}</strong></div>`;
}

/** Resolve an attribute string through the active BlobResolver (if any).
 *  RFC-005 §"metadata.rts.blobs" — string attribute values may carry a
 *  `$blob:sha256:<hex>` sentinel; the resolver looks the content up in the
 *  in-memory blob table. The blob table is published to the renderer
 *  context via a webview-scoped global (`__llmnbBlobs__`); when absent,
 *  the resolver passes strings through unchanged. */
function getActiveBlobResolver(): BlobResolver {
  const g = globalThis as { __llmnbBlobs__?: Record<string, BlobEntry> };
  return new BlobResolver(g.__llmnbBlobs__ ?? {});
}

/** Pull the OpenInference `input.value` attribute and JSON-parse it. The
 *  resolver replaces any nested `$blob:` sentinels with their content
 *  before the renderer materializes argument values. */
function parseInputValue(attrs: OtlpAttribute[] | undefined): Record<string, unknown> {
  const raw = getStringAttr(attrs, 'input.value', '');
  if (!raw) {
    return {};
  }
  // Resolve the outermost string first (covers the case where the entire
  // value is a single $blob: ref).
  const resolver = getActiveBlobResolver();
  const resolvedRaw = resolver.resolveString(raw);
  try {
    const parsed = JSON.parse(resolvedRaw);
    if (parsed && typeof parsed === 'object') {
      // Recurse into the parsed object so nested $blob: refs resolve.
      return resolver.resolve(parsed) as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Wire delegated click handlers for interactive widgets (RFC-006 Family D —
 *  `operator.action`). */
function installDelegatedHandlers(
  element: HTMLElement,
  ctx: RendererContext<unknown>
): void {
  if (typeof element.addEventListener !== 'function') return;
  element.addEventListener('click', (ev: MouseEvent) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    // PLAN-S5.0.2 §3.2 — provenance chip click → llmnb.revealCell. Resolved
    // BEFORE the toggle/action dispatch below so the chip can short-circuit
    // (it has no toggle/action attributes; the early return is purely a
    // dispatch-ordering nicety).
    const owningReveal = t.closest('[data-rts-reveal-cell]') as HTMLElement | null;
    if (owningReveal) {
      const cellId = owningReveal.getAttribute('data-rts-reveal-cell');
      if (cellId && cellId.length > 0 && typeof ctx.postMessage === 'function') {
        ctx.postMessage({
          type: 'command.invoke',
          payload: { command: 'llmnb.revealCell', args: { cellId } }
        });
      }
      return;
    }
    // The agent_emit toggle uses both data-rts-action and data-rts-toggle so
    // either click path fires the body show/hide. Resolve the toggle first.
    const owningToggle = t.closest('[data-rts-toggle]') as HTMLElement | null;
    if (owningToggle) {
      const toggleId = owningToggle.getAttribute('data-rts-toggle');
      if (toggleId) {
        const node = element.querySelector(`#${cssEscape(toggleId)}`);
        if (node instanceof HTMLElement) node.hidden = !node.hidden;
        // Fall through to action dispatch below so a click that has BOTH
        // toggle and action attributes still emits an operator.action when
        // the consumer cares (e.g. agent_emit_toggle telemetry).
      }
    }
    const owningAction = t.closest('[data-rts-action]') as HTMLElement | null;
    if (!owningAction) return;
    const action = owningAction.getAttribute('data-rts-action');
    if (!action) return;
    // agent_emit_toggle is a UI-local action: do not pester the kernel with
    // it. Only emit operator.action for kernel-bound actions.
    if (action === 'agent_emit_toggle') return;
    const params = collectParams(element, owningAction);
    if (typeof ctx.postMessage === 'function') {
      // RFC-006 §3 thin envelope — no direction/timestamp/rfc_version.
      ctx.postMessage({
        type: 'operator.action',
        payload: { action_type: action, parameters: params }
      });
    }
  });
}

function collectParams(root: HTMLElement, t: HTMLElement): Record<string, unknown> {
  const params: Record<string, unknown> = {
    run_id: t.getAttribute('data-rts-run-id') ?? ''
  };
  const decision = t.getAttribute('data-rts-decision');
  if (decision) params['decision'] = decision;
  const inputId = t.getAttribute('data-rts-input-id');
  if (inputId) {
    const input = root.querySelector(`#${cssEscape(inputId)}`);
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      // BSP-005 S8: when the input belongs to a propose_edit card, the
      // textarea carries the proposed file bytes the host bridge must hand
      // to `vscode.diff` on the right-hand side. Surface it under a
      // dedicated key so it never collides with `ask`/`clarify` answers.
      const isProposed = input.classList?.contains('rts-propose-edit-payload') ?? false;
      if (isProposed) {
        params['proposed_content'] = input.value;
      } else {
        params['answer'] = input.value;
      }
    }
  }
  const radioName = t.getAttribute('data-rts-radio-name');
  if (radioName) {
    const checked = root.querySelector(
      `input[type="radio"][name="${cssEscape(radioName)}"]:checked`
    );
    if (checked instanceof HTMLInputElement) params['selected_id'] = checked.value;
  }
  const ak = t.getAttribute('data-rts-artifact-kind');
  if (ak) params['artifact_kind'] = ak;
  const au = t.getAttribute('data-rts-artifact-uri');
  if (au) params['artifact_uri'] = au;
  const p = t.getAttribute('data-rts-path');
  if (p) params['path'] = p;
  // BSP-005 S8 — `approval_response` and `propose_edit_review` correlate via
  // the kernel-issued `approval_id`. The renderer attaches it to every
  // propose_edit button; passthrough as-is so the host bridge / kernel can
  // tie a decision back to the originating tool call.
  const ai = t.getAttribute('data-rts-approval-id');
  if (ai) params['approval_id'] = ai;
  return params;
}

/** Minimal CSS.escape polyfill for renderer environments without it. */
function cssEscape(s: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
