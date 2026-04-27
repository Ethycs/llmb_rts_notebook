// Contract tests for KernelTerminal (RFC-008 §3 "Pseudoterminal panel").
//
// Doc-driven assertions: the pseudoterminal mirrors PTY bytes into the
// VS Code Terminal panel and forwards keystrokes back to the kernel's PTY
// stdin. V1 the kernel discards stdin; the test verifies the *forwarding*
// path, not the kernel's response.
//
// Spec references:
//   RFC-008 §3              — PTY semantics
//   RFC-008 §"Pseudoterminal panel (debug surface)"
//   https://code.visualstudio.com/api/references/vscode-api#Pseudoterminal

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { KernelTerminal } from '../../src/notebook/kernel-terminal.js';

/** Minimal PtyKernelClient stand-in: hosts the onPtyData event surface and
 *  records writePtyInput calls. */
class FakeKernelClient {
  public listeners: Array<(d: string) => void> = [];
  public stdin: string[] = [];
  public onPtyData(listener: (d: string) => void): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    });
  }
  public writePtyInput(data: string): void {
    this.stdin.push(data);
  }
  public emit(chunk: string): void {
    for (const l of this.listeners) {
      l(chunk);
    }
  }
}

suite('contract: KernelTerminal (RFC-008 §3)', () => {
  test('attach() subscribes to the kernel PTY data stream', () => {
    const fake = new FakeKernelClient();
    const term = new KernelTerminal(fake, 'sess-attach');
    term.attach();
    assert.equal(fake.listeners.length, 1);
    term.dispose();
    assert.equal(fake.listeners.length, 0);
  });

  test('PTY bytes received before open() are buffered and replayed on open()', () => {
    const fake = new FakeKernelClient();
    const term = new KernelTerminal(fake, 'sess-buffer');
    term.attach();
    fake.emit('boot banner\r\n');
    fake.emit('initializing\r\n');
    assert.deepEqual(term._preopenBuffer(), ['boot banner\r\n', 'initializing\r\n']);

    const written: string[] = [];
    const sub = term.onDidWrite((s) => written.push(s));
    term.open(undefined);
    sub.dispose();

    // The header banner is fired first, then the buffered content.
    assert.ok(written.some((w) => w.includes('LLMKernel: sess-buffer')));
    assert.ok(written.includes('boot banner\r\n'));
    assert.ok(written.includes('initializing\r\n'));
    // After replay the buffer is empty.
    assert.deepEqual(term._preopenBuffer(), []);
    term.dispose();
  });

  test('PTY bytes received after open() are forwarded to onDidWrite', () => {
    const fake = new FakeKernelClient();
    const term = new KernelTerminal(fake, 'sess-live');
    term.attach();
    term.open(undefined);

    const written: string[] = [];
    const sub = term.onDidWrite((s) => written.push(s));
    fake.emit('hello world\r\n');
    sub.dispose();

    assert.ok(written.includes('hello world\r\n'));
    term.dispose();
  });

  test('handleInput() forwards operator keystrokes to the kernel PTY stdin (V1: discarded by kernel)', () => {
    const fake = new FakeKernelClient();
    const term = new KernelTerminal(fake, 'sess-keys');
    term.attach();
    term.open(undefined);
    term.handleInput('hello');
    term.handleInput('\r');
    assert.deepEqual(fake.stdin, ['hello', '\r']);
    term.dispose();
  });

  test('close() unsubscribes from the kernel PTY data stream', () => {
    const fake = new FakeKernelClient();
    const term = new KernelTerminal(fake, 'sess-close');
    term.attach();
    term.open(undefined);
    assert.equal(fake.listeners.length, 1);
    term.close();
    assert.equal(fake.listeners.length, 0);
  });
});
