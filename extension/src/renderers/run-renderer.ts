// Notebook renderer for application/vnd.rts.run+json.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/webviews/extension-side/ — vscode-jupyter's
// renderer entrypoints export an `activate(context)` function returning
// `{ renderOutputItem }` from a renderer-context module. This file is the
// renderer-target bundle that the VS Code notebook UI loads.
//
// V1 dispatches on RFC-001's 13 tool names plus RFC-003's run_type. Two
// tool renderers have real shapes (notify, report_completion). The other
// 11 tools fall through to a generic "[tool_name] {args}" placeholder
// suitable for V1 smoke testing; richer cards are TODO(C2).

import type {
  RendererContext,
  OutputItem,
  ActivationFunction
} from 'vscode-notebook-renderer';
import type {
  Rfc003Envelope,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../messaging/types.js';

type AnyRunPayload = RunStartPayload | RunEventPayload | RunCompletePayload;

export const activate: ActivationFunction = (_ctx: RendererContext<unknown>) => ({
  renderOutputItem(item: OutputItem, element: HTMLElement): void {
    try {
      const env = item.json() as Rfc003Envelope<AnyRunPayload>;
      element.innerHTML = renderEnvelope(env);
    } catch (err) {
      element.textContent = `[run-renderer] failed to render: ${String(err)}`;
    }
  }
});

function renderEnvelope(env: Rfc003Envelope<AnyRunPayload>): string {
  switch (env.message_type) {
    case 'run.start':
      return renderRunStart(env as Rfc003Envelope<RunStartPayload>);
    case 'run.event':
      return renderRunEvent(env as Rfc003Envelope<RunEventPayload>);
    case 'run.complete':
      return renderRunComplete(env as Rfc003Envelope<RunCompletePayload>);
    default:
      return `<pre>${escapeHtml(JSON.stringify(env, null, 2))}</pre>`;
  }
}

function renderRunStart(env: Rfc003Envelope<RunStartPayload>): string {
  const { run_type, name, inputs } = env.payload;
  if (run_type === 'tool') {
    return renderToolCall(name, inputs);
  }
  return `<div class="rts-run-start"><strong>[${escapeHtml(run_type)}] ${escapeHtml(name)}</strong></div>`;
}

function renderRunEvent(env: Rfc003Envelope<RunEventPayload>): string {
  const { event_type, data } = env.payload;
  return `<div class="rts-run-event"><em>${escapeHtml(event_type)}</em> ${escapeHtml(JSON.stringify(data))}</div>`;
}

function renderRunComplete(env: Rfc003Envelope<RunCompletePayload>): string {
  const { status } = env.payload;
  return `<div class="rts-run-complete">[done: ${escapeHtml(status)}]</div>`;
}

/** RFC-001 dispatch on tool name. */
function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'notify': {
      const obs = String(args['observation'] ?? '');
      const imp = String(args['importance'] ?? '');
      return `<div class="rts-notify">[NOTIFY] ${escapeHtml(obs)} &mdash; importance: ${escapeHtml(imp)}</div>`;
    }
    case 'report_completion': {
      const summary = String(args['summary'] ?? '');
      const artifacts = Array.isArray(args['artifacts']) ? (args['artifacts'] as Array<Record<string, unknown>>) : [];
      const items = artifacts
        .map((a) => `<li>${escapeHtml(String(a['kind'] ?? ''))}: ${escapeHtml(String(a['uri'] ?? ''))}</li>`)
        .join('');
      return `<div class="rts-report-completion">[COMPLETED] ${escapeHtml(summary)}${items ? `<ul>${items}</ul>` : ''}</div>`;
    }
    // TODO(C2): real renderers for ask, clarify, propose, request_approval,
    // report_progress, report_problem, present, escalate, read_file,
    // write_file, run_command (RFC-001 §Native tools, §Proxied tools).
    case 'ask':
    case 'clarify':
    case 'propose':
    case 'request_approval':
    case 'report_progress':
    case 'report_problem':
    case 'present':
    case 'escalate':
    case 'read_file':
    case 'write_file':
    case 'run_command':
    default:
      return `<div class="rts-tool-generic">[${escapeHtml(toolName)}] ${escapeHtml(JSON.stringify(args))}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
