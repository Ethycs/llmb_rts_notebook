// Renderers for the three proxied RFC-001 tools:
//   §read_file, §write_file, §run_command.
//
// V1 posture: non-interactive. The actual approval (when policy demands
// one) flows through a preceding §request_approval card, not here. These
// renderers surface a compact summary of the proxied operation; richer
// streaming output (run.event-driven terminal scroll for run_command,
// vscode.diff for write_file) is wired in S3.

import type { RendererContext } from 'vscode-notebook-renderer';
import { escapeHtml, escapeAttr } from './escape.js';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** RFC-001 §read_file. Path + encoding + max_bytes summary. */
export function renderReadFile(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const id = nextId('read');
  const path = String(args['path'] ?? '');
  const encoding = String(args['encoding'] ?? 'utf-8');
  const outId = `${id}-out`;
  // TODO(C2): wire the disclosure to the run.complete output's `content`
  // field; V1 only renders the call summary.
  return `
<div class="rts-card rts-read-file" id="${escapeAttr(id)}" data-rts-tool="read_file">
  <div class="rts-card-title">[read_file] <span class="rts-mono">${escapeHtml(path)}</span></div>
  <div class="rts-card-body">encoding=${escapeHtml(encoding)}</div>
  <div class="rts-button-row">
    <button type="button" class="rts-button-secondary" data-rts-toggle="${escapeAttr(outId)}">Show output</button>
  </div>
  <pre class="rts-terminal-block" id="${escapeAttr(outId)}" hidden>(output streams in via run.event)</pre>
</div>`;
}

/** RFC-001 §write_file. Path + mode + show-diff affordance. */
export function renderWriteFile(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const id = nextId('write');
  const path = String(args['path'] ?? '');
  const mode = String(args['mode'] ?? 'overwrite');
  // TODO(C2): wire "Show diff" to vscode.diff via an operator.action
  // forwarded to the host (the kernel's prior-snapshot is in the run record).
  return `
<div class="rts-card rts-write-file" id="${escapeAttr(id)}" data-rts-tool="write_file">
  <div class="rts-card-title">[write_file] <span class="rts-mono">${escapeHtml(path)}</span></div>
  <div class="rts-card-body">mode=${escapeHtml(mode)}</div>
  <div class="rts-button-row">
    <button type="button" class="rts-button-secondary" data-rts-action="write_file_diff" data-rts-path="${escapeAttr(path)}">Show diff</button>
  </div>
</div>`;
}

/** RFC-001 §run_command. Command + args + cwd + streamed terminal block. */
export function renderRunCommand(
  args: Record<string, unknown>,
  _ctx: RendererContext<unknown>
): string {
  const id = nextId('cmd');
  const command = String(args['command'] ?? '');
  const argsList = Array.isArray(args['args'])
    ? (args['args'] as unknown[]).map((a) => String(a))
    : [];
  const cwd = String(args['cwd'] ?? '');
  const cmdLine = [command, ...argsList].map((s) => escapeHtml(s)).join(' ');
  const termId = `${id}-term`;
  // TODO(C2): replace placeholder terminal block with run.event-driven
  // streaming output; the run-renderer needs a stable display_id hook.
  return `
<div class="rts-card rts-run-command" id="${escapeAttr(id)}" data-rts-tool="run_command">
  <div class="rts-card-title">[run_command]</div>
  <div class="rts-mono">$ ${cmdLine}${cwd ? `   <span style="opacity:0.7">(cwd: ${escapeHtml(cwd)})</span>` : ''}</div>
  <pre class="rts-terminal-block" id="${escapeAttr(termId)}">(stdout/stderr stream in via run.event)</pre>
</div>`;
}
