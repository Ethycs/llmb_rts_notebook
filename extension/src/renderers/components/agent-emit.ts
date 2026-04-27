// Renderer for RFC-005 §"`agent_emit` runs" — raw agent output.
//
// `agent_emit` spans capture every byte of agent output that did NOT route
// through a structured tool call (free-form prose, pre-tool reasoning,
// Claude Code stream-json system/result/error messages, subprocess stderr,
// malformed tool-use JSON). This refines DR-0010: structured tool calls
// remain primary; raw agent output is captured and surfaced rather than
// silently discarded.
//
// Visual policy (RFC-005 §"`agent_emit` runs"): collapsed by default,
// expand on click. Per-`emit_kind` styling per the I-X spec:
//   prose            — yellow accent (DR-0010 violation in spirit)
//   reasoning        — gray, italic
//   system_message   — blue tint
//   result           — green tint (Claude Code session result)
//   error            — red accent
//   stderr           — gray
//   invalid_tool_use — orange
//   malformed_json   — red
//
// Header format: `[<emit_kind>] agent: <agent_id>` followed by a one-line
// preview of `attributes["llmnb.emit_content"]` truncated to ~80 chars. The
// `data-rts-action="agent_emit_toggle"` attribute hooks into the run-renderer
// click handler in run-renderer.ts so collapse/expand stays consistent with
// the rest of the operator surface.

import type { RendererContext } from 'vscode-notebook-renderer';
import type { OtlpAttribute } from '../../otel/attrs.js';
import { getStringAttr } from '../../otel/attrs.js';
import { escapeHtml, escapeAttr } from './escape.js';

/** RFC-005 §"`agent_emit` runs" — emit_kind enum. */
export type AgentEmitKind =
  | 'prose'
  | 'reasoning'
  | 'system_message'
  | 'result'
  | 'error'
  | 'stderr'
  | 'invalid_tool_use'
  | 'malformed_json';

const PREVIEW_MAX_CHARS = 80;

/** Maps emit_kind to the data-attribute value the stylesheet keys off. The
 *  stylesheet itself ships in styles.css with one rule per `data-emit-kind`. */
function normalizeEmitKind(value: unknown): AgentEmitKind | 'unknown' {
  const s = String(value ?? '');
  switch (s) {
    case 'prose':
    case 'reasoning':
    case 'system_message':
    case 'result':
    case 'error':
    case 'stderr':
    case 'invalid_tool_use':
    case 'malformed_json':
      return s;
    default:
      return 'unknown';
  }
}

/** Truncate the emit-content preview to `PREVIEW_MAX_CHARS`, collapsing line
 *  breaks so the header stays one line. */
function previewOf(content: string): string {
  if (!content) {
    return '';
  }
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX_CHARS) {
    return flat;
  }
  return `${flat.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

/** Render an `agent_emit` span. The dispatch site (run-renderer.ts) routes
 *  here when `attributes["llmnb.run_type"] === "agent_emit"`. The `runId` is
 *  the OTLP `spanId` and is used as the body element id so the click handler
 *  can find the body to toggle. */
export function renderAgentEmit(
  attributes: OtlpAttribute[] | undefined,
  _ctx: RendererContext<unknown>,
  runId: string
): string {
  const kind = normalizeEmitKind(getStringAttr(attributes, 'llmnb.emit_kind'));
  const agentId = getStringAttr(attributes, 'llmnb.agent_id', '?');
  const content = getStringAttr(attributes, 'llmnb.emit_content', '');
  const diagnostic = getStringAttr(attributes, 'llmnb.parser_diagnostic', '');

  const preview = previewOf(content);
  const bodyId = `rts-agent-emit-body-${escapeAttr(runId)}`;
  const diagBlock = diagnostic
    ? `<div class="rts-agent-emit-diagnostic"><strong>parser:</strong> ${escapeHtml(diagnostic)}</div>`
    : '';

  // Body is hidden by default (collapsed). Click on the header toggles it via
  // the data-rts-action="agent_emit_toggle" handler in run-renderer.ts. The
  // generic data-rts-toggle handler ALSO works (toggles `hidden` on the id),
  // so we belt-and-suspenders with both attributes — operators can click
  // anywhere on the header to expand.
  return [
    `<div class="rts-card rts-agent-emit" data-emit-kind="${escapeAttr(kind)}">`,
    `<div class="rts-agent-emit-header" data-rts-action="agent_emit_toggle" data-rts-toggle="${escapeAttr(bodyId)}" data-rts-run-id="${escapeAttr(runId)}">`,
    `<span class="rts-agent-emit-kind">[${escapeHtml(kind)}]</span>`,
    ` <span class="rts-agent-emit-agent">agent: ${escapeHtml(agentId)}</span>`,
    preview ? ` <span class="rts-agent-emit-preview">${escapeHtml(preview)}</span>` : '',
    `</div>`,
    `<div id="${escapeAttr(bodyId)}" class="rts-agent-emit-body" hidden>`,
    `<pre class="rts-agent-emit-content">${escapeHtml(content)}</pre>`,
    diagBlock,
    `</div>`,
    `</div>`
  ].join('');
}
