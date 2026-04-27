/// <reference lib="dom" />
// Notebook renderer for application/vnd.rts.run+json.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/webviews/extension-side/ — vscode-jupyter's
// renderer entrypoints export an `activate(context)` function returning
// `{ renderOutputItem }` from a renderer-context module. This file is the
// renderer-target bundle that the VS Code notebook UI loads.
//
// V1 dispatches on RFC-001's 13 tool names plus RFC-003's run_type via a
// per-tool registry of HTML-string-producing functions. Interactive tools
// (request_approval, propose, ask, clarify, present, escalate) emit
// `data-rts-action` attributes that this module's delegated click
// listener inspects, posting RFC-003 §operator.action envelopes back to
// the extension host via ctx.postMessage.

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
import {
  renderNotify, renderRequestApproval, renderPropose,
  renderReportProgress, renderReportCompletion, renderReportProblem,
  renderAsk, renderClarify, renderPresent, renderEscalate,
  renderReadFile, renderWriteFile, renderRunCommand,
  escapeHtml
} from './components/index.js';

type AnyRunPayload = RunStartPayload | RunEventPayload | RunCompletePayload;

/** Per-tool renderer signature. `runId` is the RFC-003 run.start.id. */
type ToolRenderer = (
  args: Record<string, unknown>,
  ctx: RendererContext<unknown>,
  runId: string
) => string;

/** RFC-001 §Native + §Proxied tool dispatch table. */
const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  notify: renderNotify,
  request_approval: renderRequestApproval,
  propose: renderPropose,
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
        const env = item.json() as Rfc003Envelope<AnyRunPayload>;
        element.innerHTML = renderEnvelope(env, ctx);
        installDelegatedHandlers(element, ctx);
      } catch (err) {
        element.textContent = `[run-renderer] failed to render: ${String(err)}`;
      }
    }
  };
};

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

function renderEnvelope(
  env: Rfc003Envelope<AnyRunPayload>,
  ctx: RendererContext<unknown>
): string {
  switch (env.message_type) {
    case 'run.start':
      return renderRunStart(env as Rfc003Envelope<RunStartPayload>, ctx);
    case 'run.event': {
      const { event_type, data } = (env as Rfc003Envelope<RunEventPayload>).payload;
      return `<div class="rts-run-event"><em>${escapeHtml(event_type)}</em> ${escapeHtml(JSON.stringify(data))}</div>`;
    }
    case 'run.complete': {
      const { status } = (env as Rfc003Envelope<RunCompletePayload>).payload;
      return `<div class="rts-run-complete">[done: ${escapeHtml(status)}]</div>`;
    }
    default:
      return `<pre>${escapeHtml(JSON.stringify(env, null, 2))}</pre>`;
  }
}

function renderRunStart(
  env: Rfc003Envelope<RunStartPayload>,
  ctx: RendererContext<unknown>
): string {
  const { run_type, name, inputs, id } = env.payload;
  if (run_type === 'tool') {
    const fn = TOOL_RENDERERS[name];
    if (fn) return fn(inputs, ctx, id);
    return `<div class="rts-tool-generic">[${escapeHtml(name)}] ${escapeHtml(JSON.stringify(inputs))}</div>`;
  }
  return `<div class="rts-run-start"><strong>[${escapeHtml(run_type)}] ${escapeHtml(name)}</strong></div>`;
}

/** Wire delegated click handlers for interactive widgets (RFC-003 §operator.action). */
function installDelegatedHandlers(
  element: HTMLElement,
  ctx: RendererContext<unknown>
): void {
  if (typeof element.addEventListener !== 'function') return;
  element.addEventListener('click', (ev: MouseEvent) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const toggleId = t.getAttribute('data-rts-toggle');
    if (toggleId) {
      const node = element.querySelector(`#${cssEscape(toggleId)}`);
      if (node instanceof HTMLElement) node.hidden = !node.hidden;
      return;
    }
    const action = t.getAttribute('data-rts-action');
    if (!action) return;
    const params = collectParams(element, t);
    if (typeof ctx.postMessage === 'function') {
      ctx.postMessage({
        message_type: 'operator.action',
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
      params['answer'] = input.value;
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
  return params;
}

/** Minimal CSS.escape polyfill for renderer environments without it. */
function cssEscape(s: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
