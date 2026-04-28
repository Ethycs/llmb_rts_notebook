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

/** V1 cell-directive grammar. Currently only `/spawn` is supported; future
 *  V1.5 may add `@agent ref` for cross-cell agent referencing. */
export type CellDirective =
  | { kind: 'spawn'; agent_id: string; task: string }
  ;

/** Parse a cell's text content for V1 directives. Returns null when the
 *  cell does not begin with a recognized directive. */
export function parseCellDirective(text: string): CellDirective | null {
  // Match: /spawn <agent_id> task:"<task>"
  // <agent_id> is a non-whitespace token; task value is double-quoted.
  // Multi-line tasks are not supported in V1; embedded escaped quotes either.
  const trimmed = text.trim();
  const m = trimmed.match(/^\/spawn\s+(\S+)\s+task:"([^"]*)"\s*$/);
  if (m) {
    return { kind: 'spawn', agent_id: m[1], task: m[2] };
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
        for (const [k, v] of this.inflight) {
          if (v === exec) {
            this.inflight.delete(k);
            break;
          }
        }
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
