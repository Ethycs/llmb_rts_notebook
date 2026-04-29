// LLMNB notebook controller.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/notebooks/controllers/vscodeNotebookController.ts
// and vendor/vscode-jupyter/src/notebooks/controllers/controllerRegistration.ts
// — both wrap vscode.NotebookController and route execution through a
// per-cell handler. Per DR-0009 we drop the Jupyter kernel process entirely;
// the executeHandler dispatches directly to a kernel client (a TypeScript
// callback inside the extension host).
//
// I-X: per RFC-006 §1, the Family A wire is OTLP/JSON spans (or `{spanId,
// event}` partial events) directly — no envelope. The KernelEventSink now
// carries `RunMimePayload`, the controller writes bare OTLP spans on cell
// outputs, and the renderer reads them as such.

import * as vscode from 'vscode';
import {
  MessageRouter,
  RunLifecycleObserver,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  RunMimePayload
} from '../messaging/router.js';

/** Kernel client surface. RFC-006 §1: clients deliver one OTLP-shaped run
 *  payload per emission via the supplied sink; the controller materializes
 *  cell outputs and execution lifecycle from the stream. */
export interface KernelClient {
  /** Optional eager-connect hook. The PtyKernelClient (RFC-008) uses this
   *  to spawn LLMKernel via node-pty and complete the data-plane socket
   *  ready handshake before the first cell executes. The StubKernelClient
   *  omits it. The controller awaits it before each executeCell call;
   *  implementations MUST be idempotent. */
  connect?(): Promise<void>;
  /** Begin executing one cell. The client MUST emit at least one in-progress
   *  span (`endTimeUnixNano: null`) and exactly one terminal span (with
   *  `endTimeUnixNano` set and a non-UNSET status) via the supplied sink.
   *  Streaming events MAY be emitted via the partial `{spanId, event}` shape. */
  executeCell(input: KernelExecuteRequest, sink: KernelEventSink): Promise<void>;
  /** True once the kernel is ready to accept executeCell traffic.
   *  PtyKernelClient flips this true after the `kernel.ready` handshake
   *  (RFC-008 §4); StubKernelClient flips this true immediately after
   *  `attachRouter()` (no remote side). FSP-003 Pillar A — what
   *  `waitForKernelReady` polls so a K71 timeout has a clean predicate. */
  readonly isReady: boolean;
}

export interface KernelExecuteRequest {
  cellUri: string;
  text: string;
  language?: string;
  /** Pre-parsed cell directive (V1: `/spawn <agent_id> task:"..."`). When
   *  set, the kernel client SHOULD dispatch the structured directive instead
   *  of re-parsing `text`. When null, no recognized directive was found
   *  (kernel client may treat as no-op or echo). */
  directive?: CellDirective | null;
}

/** Cell-directive grammar.
 *
 *  BSP-005 S5.0 ([PLAN-S5.0-cell-magic-vocabulary.md]) lands the
 *  IPython-style two-tier ``@`` / ``@@`` magic vocabulary; V1 legacy
 *  ``/spawn`` and ``@<id>:`` forms remain recognized aliases.
 *
 *  Recognized forms (in priority order):
 *
 *  * ``@@spawn <agent_id> [endpoint:<name>] task:"<task>"`` — spawn (canonical)
 *  * ``@@agent <agent_id>`` (with body) — continuation (canonical)
 *  * ``@@<cell_magic>`` — kind-only declaration (markdown, scratch,
 *    checkpoint, endpoint, …); maps to a ``set_cell_metadata`` envelope
 *    carrying the parsed kind + named args.
 *  * ``@<line_magic>`` (column-0; e.g. ``@pin``, ``@exclude``,
 *    ``@affinity primary,cheap``) — flag mutation; maps to
 *    ``set_cell_metadata`` with the flag toggled.
 *  * ``/spawn <agent_id> task:"<task>"`` — legacy spawn alias.
 *  * ``@<agent_id>: <message>`` — legacy continuation alias.
 *
 *  ``@@break`` is consumed by the file-level splitter; it MUST NOT
 *  reach this parser. If it does, we return null (no-op).
 *
 *  PLAN-S5.0 §3.6: this parser is the front-end; the kernel-side
 *  ``magic_registry`` is the source of truth for K30/K31/K32/K34 — the
 *  extension makes a best-effort recognition pass and lets the kernel
 *  reject invalid forms with a structured error span.
 */
export type CellDirective =
  | { kind: 'spawn'; agent_id: string; task: string; endpoint?: string }
  | { kind: 'continue'; agent_id: string; text: string }
  | { kind: 'cell_magic'; magic: string; args: string; cell_kind: string }
  | { kind: 'line_magic'; magic: string; args: string; flags: { set?: string[]; unset?: string[] } }
  ;

/** PLAN-S5.0 §3.4 — line magics that toggle cell-metadata flags.
 *  The parser maps these to a ``set_cell_metadata`` envelope (set or
 *  unset the corresponding flag); other line magics (``@affinity``,
 *  ``@handoff``, ``@status``, ``@revert``, ``@stop``, ``@branch``)
 *  also dispatch as ``line_magic`` directives but the receiving handler
 *  is slice-pending. */
const FLAG_LINE_MAGICS: Record<string, { set?: string; unset?: string }> = {
  pin: { set: 'pinned' },
  unpin: { unset: 'pinned' },
  exclude: { set: 'excluded' },
  include: { unset: 'excluded' }
};

/** PLAN-S5.0 §3.4 — the union of recognized line-magic names. Only
 *  column-0 ``@<name>`` lines whose name is in this set dispatch as
 *  line magics; everything else (``@user`` mentions, email, etc.) is
 *  body text. */
const LINE_MAGIC_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(FLAG_LINE_MAGICS),
  'mark', 'affinity', 'handoff', 'status',
  'revert', 'stop', 'branch'
]);

/** PLAN-S5.0 §3.3 — the union of recognized cell-magic names (excludes
 *  ``break`` which is consumed by the splitter). */
const CELL_MAGIC_NAMES: ReadonlySet<string> = new Set([
  'agent', 'spawn', 'markdown', 'scratch', 'checkpoint',
  'endpoint', 'compare', 'section',
  'tool', 'artifact', 'native'
]);

/** Parse a cell's text content for V1 directives. Returns null when the
 *  cell does not begin with a recognized directive.
 *
 *  Continuation grammar (BSP-005 S3): the cell's first line begins with
 *  ``@`` followed by an `agent_id`, a literal colon, then the message
 *  body. The message body may contain additional colons and runs to the
 *  end of the cell text — only the FIRST colon after ``@<agent_id>``
 *  is the directive separator. Newlines and arbitrary whitespace inside
 *  the message body are preserved verbatim (the kernel's stream-json
 *  user line accepts the entire body as ``message.content``).
 *
 *  ``agent_id`` accepts the same identifier shape the existing
 *  ``/spawn`` parser does (one or more non-whitespace, non-colon
 *  characters): BSP-002 §6 references the agent_id regex but does not
 *  pin a strict character class in V1; the spawn parser already
 *  tolerates path-like ids (``zone-1/alpha``) and the continuation
 *  parser MUST agree so a re-run of `@<spawned-id>` always lands on
 *  the same agent.
 */
export function parseCellDirective(text: string): CellDirective | null {
  // PLAN-S5.0 §3.6 dispatcher. The cell text is examined LINE-BY-LINE
  // from the top — the first non-blank line determines whether the
  // cell carries a directive. Subsequent lines are *body* (consumed by
  // the cell-magic / continuation handler).
  if (text == null || text.length === 0) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  // Find the first non-blank line.
  let idx = 0;
  while (idx < lines.length && lines[idx].trim().length === 0) {
    idx += 1;
  }
  if (idx >= lines.length) {
    return null;
  }
  const head = lines[idx];
  const restLines = lines.slice(idx + 1);

  // ``@@break`` is consumed by the splitter; defensive null when seen.
  if (head.trim() === '@@break') {
    return null;
  }

  // --- Canonical S5.0 cell-magic forms -----------------------------

  // ``@@<cell_magic> [args...]`` at column 0. The regex captures the
  // magic name + the arg-string remainder. Body text is the remaining
  // lines, joined verbatim.
  const cellMagicMatch = head.match(/^@@([A-Za-z_][\w]*)\s*(.*)$/);
  if (cellMagicMatch && CELL_MAGIC_NAMES.has(cellMagicMatch[1])) {
    const magic = cellMagicMatch[1];
    const argsStr = cellMagicMatch[2].trim();
    // ``@@spawn`` short-circuits to the structured spawn directive
    // (so the kernel sees ``action_type=agent_spawn`` exactly as the
    // legacy /spawn path does).
    if (magic === 'spawn') {
      const positional = argsStr.match(/^(\S+)/);
      const taskMatch = argsStr.match(/task:"([^"]*)"/);
      const endpointMatch = argsStr.match(/endpoint:(\S+)/);
      if (positional && taskMatch) {
        const result: CellDirective = {
          kind: 'spawn',
          agent_id: positional[1],
          task: taskMatch[1]
        };
        if (endpointMatch) {
          result.endpoint = endpointMatch[1];
        }
        return result;
      }
      return null;
    }
    // ``@@agent <id>`` short-circuits to the structured continue
    // directive when there's a body.
    if (magic === 'agent') {
      const idMatch = argsStr.match(/^(\S+)/);
      const body = restLines.join('\n').trim();
      if (idMatch && body.length > 0) {
        return { kind: 'continue', agent_id: idMatch[1], text: body };
      }
      return null;
    }
    // Any other recognized cell magic: ship as a generic cell_magic
    // directive — the kernel-side dispatcher routes by ``magic`` name.
    return {
      kind: 'cell_magic',
      magic,
      args: argsStr,
      cell_kind: magic
    };
  }

  // --- Canonical S5.0 line-magic forms -----------------------------

  // ``@<line_magic> [args...]`` at column 0. Distinguish from the
  // legacy ``@<id>: <message>`` continuation by requiring (a) the
  // magic name to be in the registry AND (b) no colon-separator after
  // the name (the colon would mean it's a legacy continuation against
  // an agent that happens to share a magic-name spelling, which K32
  // forbids — but we still want to parse the form rather than mis-
  // classifying body).
  const lineMagicMatch = head.match(/^@([A-Za-z_][\w]*)(?:\s+([\s\S]*))?$/);
  if (
    lineMagicMatch &&
    LINE_MAGIC_NAMES.has(lineMagicMatch[1]) &&
    !head.includes(':')
  ) {
    const magic = lineMagicMatch[1];
    const args = (lineMagicMatch[2] ?? '').trim();
    const flagSpec = FLAG_LINE_MAGICS[magic];
    const flags: { set?: string[]; unset?: string[] } = {};
    if (flagSpec?.set) {
      flags.set = [flagSpec.set];
    }
    if (flagSpec?.unset) {
      flags.unset = [flagSpec.unset];
    }
    return { kind: 'line_magic', magic, args, flags };
  }

  // --- Legacy V1 forms (PLAN-S5.0 §3.9) ----------------------------

  // ``/spawn <agent_id> task:"<task>"`` — only the head line is
  // considered (the legacy form is single-line).
  const trimmed = head.trim();
  const spawnMatch = trimmed.match(/^\/spawn\s+(\S+)\s+task:"([^"]*)"\s*$/);
  if (spawnMatch) {
    return { kind: 'spawn', agent_id: spawnMatch[1], task: spawnMatch[2] };
  }
  // ``@<agent_id>: <message>`` — first colon is the separator. Note
  // we already excluded the column-0 line-magic case above so a
  // ``@pin`` (no colon) won't reach this match.
  const continueMatch = trimmed.match(/^@([^\s:]+)\s*:\s*([\s\S]+)$/);
  if (continueMatch) {
    const agent_id = continueMatch[1];
    const body = continueMatch[2].trim();
    if (agent_id.length === 0 || body.length === 0) {
      return null;
    }
    return { kind: 'continue', agent_id, text: body };
  }
  return null;
}

/** Sink the kernel client uses to push run-MIME payloads at the controller.
 *  RFC-006 §1: the carrier is bare OTLP/JSON, no envelope. */
export interface KernelEventSink {
  emit(payload: RunMimePayload): void;
}

/** MIME type for run records, per RFC-005 §"File extension and MIME type". */
export const RTS_RUN_MIME = 'application/vnd.rts.run+json';

export class LlmnbNotebookController implements vscode.Disposable, RunLifecycleObserver {
  public readonly controller: vscode.NotebookController;
  private readonly inflight = new Map<string, vscode.NotebookCellExecution>();
  private readonly cellByCorrelation = new Map<string, vscode.NotebookCell>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly notebookType: string,
    private readonly kernel: KernelClient,
    private readonly router: MessageRouter,
    private readonly logger: vscode.LogOutputChannel
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      'llmnb.kernel',
      this.notebookType,
      'LLMKernel'
    );
    this.controller.supportedLanguages = ['markdown', 'plaintext', 'llmnb-cell'];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = 'In-process LLMKernel executor (RFC-006 wire format)';
    this.controller.executeHandler = this.execute.bind(this);

    this.disposables.push(this.router.registerRunObserver(this));
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.controller.dispose();
  }

  private async execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    for (const cell of cells) {
      // BSP-005 M1 — Markup / markdown cells (atoms/concepts/cell-kinds.md
      // `markdown` row) are operator prose; they carry no agent and no
      // execution. VS Code's notebook UI normally never dispatches Markup
      // cells through executeHandler, but the controller registers
      // `markdown` as a supportedLanguage (line 149) so a defensive guard
      // here is the right place to short-circuit. We log at info level so
      // an operator inspecting the channel sees that the skip happened by
      // design — no executeCell call is issued, no envelope is posted, and
      // no NotebookCellExecution is even created (an empty execution would
      // strip the cell's text-rendered markdown body for the duration).
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        this.logger.info(
          `[controller] skipping Markup cell ${cell.document.uri.toString()} (BSP-005 M1: markdown cells have no agent)`
        );
        continue;
      }
      await this.runOne(cell);
    }
  }

  private async runOne(cell: vscode.NotebookCell): Promise<void> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.executionOrder = (cell.executionSummary?.executionOrder ?? 0) + 1;
    exec.start(Date.now());
    await exec.clearOutput();
    const cellKey = cell.document.uri.toString();
    this.inflight.set(cellKey, exec);

    // The sink forwards each run-MIME payload through the router's
    // routeRunMime classifier, which calls back to this controller via the
    // RunLifecycleObserver hooks below. The classifier indirection keeps the
    // open/closed/event distinction in one place.
    const sink: KernelEventSink = {
      emit: (payload) => this.router.routeRunMime(payload)
    };

    try {
      if (this.kernel.connect) {
        await this.kernel.connect();
      }
      const text = cell.document.getText();
      const directive = parseCellDirective(text);
      await this.kernel.executeCell(
        { cellUri: cellKey, text, language: cell.document.languageId, directive },
        sink
      );
      // The terminal span (handled in onRunComplete) is the canonical
      // end-of-cell; if the kernel resolves without one, end the execution
      // unsuccessfully here.
      if (this.inflight.has(cellKey)) {
        exec.end(false, Date.now());
        this.inflight.delete(cellKey);
      }
    } catch (err) {
      this.logger.error(`[controller] kernel error for ${cellKey}: ${String(err)}`);
      if (this.inflight.has(cellKey)) {
        exec.end(false, Date.now());
        this.inflight.delete(cellKey);
      }
    }
  }

  // --- RunLifecycleObserver -----------------------------------------------

  public onRunStart(span: RunStartPayload): void {
    const exec = this.findExecForCorrelation(span.spanId);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(span, RTS_RUN_MIME);
    void exec.appendOutput(new vscode.NotebookCellOutput([item]));
  }

  public onRunEvent(payload: RunEventPayload): void {
    const exec = this.findExecForCorrelation(payload.spanId);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(payload, RTS_RUN_MIME);
    void exec.appendOutput(new vscode.NotebookCellOutput([item]));
  }

  public onRunComplete(span: RunCompletePayload): void {
    const exec = this.findExecForCorrelation(span.spanId);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(span, RTS_RUN_MIME);
    const ok = span.status?.code === 'STATUS_CODE_OK';
    // Synchronously claim the inflight slot. runOne()'s sync fallback after
    // executeCell() returns checks inflight.has(cellKey) as the predicate
    // for "no terminal span observed; end unsuccessfully." If we leave the
    // entry in place while we await appendOutput, the fallback fires
    // exec.end(false) before our async commit, discarding pending Thenables
    // and finalizing the cell empty. This race surfaces with the stub
    // kernel (synchronous emit-and-return); the live PtyKernelClient avoids
    // it by awaiting the terminal span before executeCell() resolves.
    for (const [k, v] of this.inflight) {
      if (v === exec) {
        this.inflight.delete(k);
        break;
      }
    }
    // Await the append before calling end(): NotebookCellExecution.end()
    // finalizes the cell, and pending Thenables from appendOutput can be
    // discarded if they haven't committed yet, leaving the close payload
    // missing from doc.cellAt(N).outputs even though it was emitted on
    // the wire. The await keeps the close-shape JSON visible to readers.
    void (async (): Promise<void> => {
      try {
        await exec.appendOutput(new vscode.NotebookCellOutput([item]));
      } finally {
        exec.end(ok, Date.now());
        this.cellByCorrelation.delete(span.spanId);
      }
    })();
  }

  /** Best-effort: route by spanId, falling back to "the only inflight cell"
   *  when the kernel client has not yet bound the cell. */
  private findExecForCorrelation(spanId: string): vscode.NotebookCellExecution | undefined {
    const cell = this.cellByCorrelation.get(spanId);
    if (cell) {
      return this.inflight.get(cell.document.uri.toString());
    }
    if (this.inflight.size === 1) {
      const [only] = this.inflight.values();
      return only;
    }
    return undefined;
  }

  /** Allows the kernel client to associate a spanId with a cell when the
   *  kernel returns the OTLP spanId from its open-span emission. */
  public bindCorrelation(spanId: string, cell: vscode.NotebookCell): void {
    this.cellByCorrelation.set(spanId, cell);
  }
}
