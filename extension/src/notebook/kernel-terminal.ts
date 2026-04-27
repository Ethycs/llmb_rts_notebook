// KernelTerminal — RFC-008 §3 "Pseudoterminal panel (debug surface)".
//
// The operator runs `LLMNB: Show kernel terminal`; the extension creates a
// `vscode.Terminal` whose backing `Pseudoterminal` mirrors the bytes the
// kernel writes to its PTY (boot output, fatal tracebacks, etc.) and forwards
// keystrokes back to the kernel's PTY stdin (V1: discarded by the kernel; V2
// will surface a Python REPL).
//
// Spec references:
//   RFC-008 §3 — control plane: PTY semantics
//   RFC-008 §"Pseudoterminal panel (debug surface)"
//   https://code.visualstudio.com/api/references/vscode-api#Pseudoterminal

import * as vscode from 'vscode';
import type { PtyKernelClient } from './pty-kernel-client.js';

/** vscode.Pseudoterminal-conforming bridge between PtyKernelClient.onPtyData
 *  and the operator-facing Terminal panel. */
export class KernelTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  /** vscode.Pseudoterminal interface fields. */
  public readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  public readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  private subscription: vscode.Disposable | undefined;
  /** Bytes already received before the panel opened. Replayed on attach so
   *  the operator sees the boot banner even if they open the panel late. */
  private readonly preopenBuffer: string[] = [];
  private opened = false;

  public constructor(
    private readonly kernel: Pick<PtyKernelClient, 'onPtyData' | 'writePtyInput'>,
    private readonly sessionId: string
  ) {}

  /** Subscribe to the kernel's PTY data stream so anything written before
   *  `open()` is replayed. Call this immediately after constructing the
   *  KernelTerminal — usually right before passing it to
   *  `vscode.window.createTerminal`. */
  public attach(): void {
    if (this.subscription) {
      return;
    }
    this.subscription = this.kernel.onPtyData((chunk) => {
      if (this.opened) {
        this.writeEmitter.fire(chunk);
      } else {
        this.preopenBuffer.push(chunk);
      }
    });
  }

  // --- vscode.Pseudoterminal -----------------------------------------------

  public open(_dimensions: vscode.TerminalDimensions | undefined): void {
    this.opened = true;
    // Header banner so operators know which session this terminal belongs to.
    this.writeEmitter.fire(
      `[36m[LLMKernel: ${this.sessionId}][0m\r\n`
    );
    // Replay any pre-open bytes.
    for (const c of this.preopenBuffer) {
      this.writeEmitter.fire(c);
    }
    this.preopenBuffer.length = 0;
  }

  public close(): void {
    this.opened = false;
    this.subscription?.dispose();
    this.subscription = undefined;
    try {
      this.closeEmitter.fire();
    } catch {
      /* ignore */
    }
  }

  public handleInput(data: string): void {
    // Forward operator keystrokes to the kernel PTY stdin (V1: discarded by
    // the kernel; V2: REPL).
    this.kernel.writePtyInput(data);
  }

  // setDimensions is optional; we don't propagate resize events to node-pty
  // in V1 (TODO V1.5 per RFC-008 open issues).

  /** Test seam: simulates kernel PTY output being routed into the panel. */
  public _testEmit(chunk: string): void {
    if (this.opened) {
      this.writeEmitter.fire(chunk);
    } else {
      this.preopenBuffer.push(chunk);
    }
  }

  /** Test seam: returns whether the panel is in the "opened" state. */
  public _isOpen(): boolean {
    return this.opened;
  }

  /** Test seam: snapshot of the pre-open replay buffer. */
  public _preopenBuffer(): readonly string[] {
    return this.preopenBuffer.slice();
  }

  public dispose(): void {
    this.close();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}
