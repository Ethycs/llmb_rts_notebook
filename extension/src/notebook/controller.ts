// LLMNB notebook controller.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/notebooks/controllers/vscodeNotebookController.ts
// and vendor/vscode-jupyter/src/notebooks/controllers/controllerRegistration.ts
// — both wrap vscode.NotebookController and route execution through a
// per-cell handler. Per DR-0009 (chapter 06) we drop the Jupyter kernel
// process entirely; the executeHandler dispatches directly to a kernel
// client (a TypeScript callback inside the extension host).

import * as vscode from 'vscode';
import {
  MessageRouter,
  RunLifecycleObserver,
  Rfc003Envelope,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../messaging/router.js';

/** RFC-003-shaped payload kernel clients emit. */
export interface KernelClient {
  /** Optional eager-connect hook. Real Jupyter clients (Track C R2) use
   *  this to spin up the @jupyterlab/services KernelManager + comm-target
   *  registration before the first cell executes. The StubKernelClient
   *  omits it. The controller awaits it before each executeCell call;
   *  implementations MUST be idempotent. */
  connect?(): Promise<void>;
  /** Begin executing one cell. The client MUST emit run.start, optional
   *  run.event(s), and a single terminal run.complete via the supplied
   *  callback. The Promise resolves once the kernel has signalled completion. */
  executeCell(input: KernelExecuteRequest, sink: KernelEventSink): Promise<void>;
}

export interface KernelExecuteRequest {
  cellUri: string;
  text: string;
  language?: string;
}

export interface KernelEventSink {
  emit(envelope: Rfc003Envelope<unknown>): void;
}

/** MIME type for run records, per docs/dev-guide/07-subtractive-fork-and-storage.md. */
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
    this.controller.description = 'In-process LLMKernel executor (RFC-003 wire format)';
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

    const sink: KernelEventSink = {
      emit: (env) => this.router.route(env)
    };

    try {
      // TODO(C2): a cell-input parser handles `/spawn` and `@agent` directives
      // before dispatching; for V1 the raw text is forwarded as-is.
      if (this.kernel.connect) {
        await this.kernel.connect();
      }
      await this.kernel.executeCell(
        { cellUri: cellKey, text: cell.document.getText(), language: cell.document.languageId },
        sink
      );
      // run.complete (handled in onRunComplete) is the canonical end-of-cell;
      // if the kernel resolves without one, end the execution unsuccessfully here.
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

  public onRunStart(envelope: Rfc003Envelope<RunStartPayload>): void {
    const exec = this.findExecForCorrelation(envelope.correlation_id);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(envelope, RTS_RUN_MIME);
    void exec.appendOutput(new vscode.NotebookCellOutput([item]));
  }

  public onRunEvent(envelope: Rfc003Envelope<RunEventPayload>): void {
    const exec = this.findExecForCorrelation(envelope.correlation_id);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(envelope, RTS_RUN_MIME);
    void exec.appendOutput(new vscode.NotebookCellOutput([item]));
  }

  public onRunComplete(envelope: Rfc003Envelope<RunCompletePayload>): void {
    const exec = this.findExecForCorrelation(envelope.correlation_id);
    if (!exec) {
      return;
    }
    const item = vscode.NotebookCellOutputItem.json(envelope, RTS_RUN_MIME);
    void exec.appendOutput(new vscode.NotebookCellOutput([item]));
    const ok = envelope.payload.status === 'success';
    exec.end(ok, Date.now());
    // remove the inflight entry whose exec === exec
    for (const [k, v] of this.inflight) {
      if (v === exec) {
        this.inflight.delete(k);
        break;
      }
    }
    this.cellByCorrelation.delete(envelope.correlation_id);
  }

  /** Best-effort: route by correlation_id, falling back to "the only inflight
   *  cell" when the kernel client has not yet bound the cell. */
  private findExecForCorrelation(correlationId: string): vscode.NotebookCellExecution | undefined {
    const cell = this.cellByCorrelation.get(correlationId);
    if (cell) {
      return this.inflight.get(cell.document.uri.toString());
    }
    if (this.inflight.size === 1) {
      const [only] = this.inflight.values();
      return only;
    }
    return undefined;
  }

  /** Allows the kernel client to associate a correlation_id with a cell when
   *  the kernel returns the run_id from its run.start emission. */
  public bindCorrelation(correlationId: string, cell: vscode.NotebookCell): void {
    this.cellByCorrelation.set(correlationId, cell);
  }
}
