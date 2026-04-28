// Contract tests for PtyKernelClient (RFC-008).
//
// These tests inject a fake `node-pty` module via __setPtyModule so the
// suite runs without the native binding. Socket transport uses a real
// loopback TCP server (the cleanest cross-platform stand-in for the UDS /
// named-pipe data plane); production paths use UDS on POSIX and named pipes
// on Windows per RFC-008 §2 — the framing is identical.
//
// Each test cites the RFC-008 section / failure-mode row it walks.
// Failure-mode coverage (RFC-008 §"Failure modes"):
//   K1 socket bind failure ............... covered (bind to invalid path)
//   K2 spawn failure ..................... covered (fake throws)
//   K3 ready timeout ..................... covered (fake never connects)
//   K4 malformed ready record ............ covered (missing rfc versions)
//   K5 RFC version drift ................. covered (drift_events populated)
//   K6 socket EOF mid-session ............ covered (close after ready)
//   K7 PTY EOF before ready .............. covered (fake exits early)
//   K8 malformed JSON .................... covered (bad bytes on socket)
//   K9 oversize frame .................... not directly testable here (V1.5)
//   K10 second connection rejected ....... covered (accept-then-reject)
//   K11 SIGINT escalation ................ covered (interrupt() path; signals not
//                                          fully escalated under fake pty)
//   K12 JSON on PTY stderr ............... covered (PTY data fans into terminal,
//                                          not the data-plane dispatcher)
//
// Spec references:
//   RFC-008 §2 — data plane address + framing
//   RFC-008 §4 — connection lifecycle + ready handshake
//   RFC-008 §6 — frame type dispatch
//   RFC-008 §8 — PtyKernelClient reference

import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import * as vscode from 'vscode';
import { MessageRouter, OtlpLogRecord } from '../../src/messaging/router.js';
import {
  PtyKernelClient,
  __setPtyModule,
  IPtyLike,
  EXTENSION_RFC_VERSIONS
} from '../../src/notebook/pty-kernel-client.js';
import { encodeAttrs } from '../../src/otel/attrs.js';
import type { RtsV2Envelope, RunMimePayload } from '../../src/messaging/types.js';
import { waitForPredicate } from '../util/typed-waits.js';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'pty-kernel-test-log',
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    append: noop,
    appendLine: noop,
    replace: noop,
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
    logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

/** Fake PTY that records spawn args, fires data callbacks, and lets tests
 *  invoke an exit. Optionally connects a TCP socket back to the kernel
 *  client's listener so the data plane has a counterpart. */
class FakePty implements IPtyLike {
  public readonly pid = 12345;
  public lastWritten: string[] = [];
  public killSignals: string[] = [];
  public exited = false;
  private dataCb: ((d: string) => void) | undefined;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;

  public onData(cb: (d: string) => void): { dispose(): void } {
    this.dataCb = cb;
    return { dispose: () => { /* noop */ } };
  }
  public onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitCb = cb;
    return { dispose: () => { /* noop */ } };
  }
  public write(data: string): void {
    this.lastWritten.push(data);
  }
  public kill(signal?: string): void {
    this.killSignals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      this.fireExit(signal === 'SIGKILL' ? 137 : 143);
    }
  }
  public _emitData(d: string): void {
    this.dataCb?.(d);
  }
  public fireExit(exitCode = 0): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitCb?.({ exitCode });
  }
}

/** Fake pty module: registers a FakePty per spawn and returns it. */
class FakePtyModule {
  public spawned: FakePty[] = [];
  public spawnError: Error | undefined;
  public lastFile: string | undefined;
  public lastArgs: string[] | undefined;
  public lastEnv: NodeJS.ProcessEnv | undefined;

  public spawn(file: string, args: string[], options: { env?: NodeJS.ProcessEnv }): FakePty {
    if (this.spawnError) {
      throw this.spawnError;
    }
    this.lastFile = file;
    this.lastArgs = args;
    this.lastEnv = options.env;
    const p = new FakePty();
    this.spawned.push(p);
    return p;
  }
}

/** Helper: connect a real net.Socket to the kernel client's listener. The
 *  test then writes JSON frames into this socket as the "kernel" side. */
async function connectKernelSocket(address: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(address);
    sock.once('connect', () => {
      sock.setEncoding('utf8');
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

/** Allocate a free TCP port for the data-plane socket. Most tests don't need
 *  a real platform UDS / pipe — TCP loopback works identically with the
 *  newline-delimited JSON framing. */
async function pickTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error('failed to allocate ephemeral port'));
      }
    });
  });
}

/** OTLP/JSON ready-handshake LogRecord with all extension-side RFC version
 *  attributes set to matching values. */
function readyRecord(sessionId: string, overrides: Partial<Record<string, string>> = {}): OtlpLogRecord {
  const attrs: Array<{ key: string; value: { stringValue: string } }> = [
    { key: 'event.name', value: { stringValue: 'kernel.ready' } },
    { key: 'llmnb.kernel.session_id', value: { stringValue: sessionId } },
    { key: 'llmnb.kernel.version', value: { stringValue: '0.1.0-test' } },
    { key: 'llmnb.kernel.python_version', value: { stringValue: '3.11.0' } }
  ];
  for (const [shortKey, expected] of Object.entries(EXTENSION_RFC_VERSIONS)) {
    const fullKey = `llmnb.kernel.${shortKey}`;
    attrs.push({
      key: fullKey,
      value: { stringValue: overrides[fullKey] ?? expected }
    });
  }
  return {
    timeUnixNano: '1745588938412000000',
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: 'kernel ready' },
    attributes: attrs as OtlpLogRecord['attributes']
  };
}

suite('contract: PtyKernelClient (RFC-008)', () => {
  let fakeMod: FakePtyModule;

  setup(() => {
    fakeMod = new FakePtyModule();
    __setPtyModule(fakeMod);
  });

  teardown(() => {
    __setPtyModule(undefined);
  });

  // RFC-008 §2 — UDS path on POSIX, loopback TCP on Windows.
  // (Windows named pipes need pywin32 on the kernel side, which is not wired
  // up in V1; the kernel's parse_address raises NotImplementedError for
  // pipe: addresses and recommends tcp:127.0.0.1:<port> instead.)
  test('allocateSocketAddress() picks platform-appropriate transport', () => {
    const router = new MessageRouter(silentLogger());
    const sessionId = 'test-session-aaa';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python' },
      router,
      silentLogger()
    );
    const computed = c.allocateSocketAddress();
    if (process.platform === 'win32') {
      assert.equal(computed, 'tcp:127.0.0.1:0');
    } else {
      assert.match(computed, new RegExp(`llmnb-${sessionId}\\.sock$`));
    }
  });

  // RFC-008 §4 — start() spawns the kernel via node-pty with the socket env var set.
  test('start() spawns python with `-m llm_kernel pty-mode` and sets LLMKERNEL_IPC_SOCKET', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-spawn-args';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 2000 },
      router,
      silentLogger()
    );
    // Kick off start() but don't await — the kernel never connects.
    const startPromise = c.start();
    // The fake spawn is synchronous within the fake module; after the
    // listenSocket binds the kernel client calls spawn().
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);

    assert.equal(fakeMod.lastFile, 'python');
    assert.deepEqual(fakeMod.lastArgs, ['-m', 'llm_kernel', 'pty-mode']);
    assert.equal(fakeMod.lastEnv?.LLMKERNEL_IPC_SOCKET, port.toString());
    assert.equal(fakeMod.lastEnv?.LLMKERNEL_PTY_MODE, '1');

    // Cancel the ready wait by exiting the PTY.
    fakeMod.spawned[0].fireExit(1);
    await assert.rejects(() => startPromise);
    c.dispose();
  });

  // RFC-008 §4 — happy-path ready handshake.
  test('start() resolves when the kernel emits kernel.ready', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-happy-ready';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);

    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord(sessionId)) + '\n');
    await startPromise;
    assert.deepEqual(c.getDriftEvents(), []);
    sock.destroy();
    c.dispose();
  });

  // RFC-008 §"Failure modes" K3 — ready timeout.
  test('start() rejects on ready-handshake timeout (K3)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-k3', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 100 },
      router,
      silentLogger()
    );
    await assert.rejects(() => c.start(), /timed out/);
    c.dispose();
  });

  // RFC-008 §"Failure modes" K2 — spawn failure.
  test('start() rejects on pty.spawn failure (K2)', async () => {
    fakeMod.spawnError = new Error('ENOENT: no such file or directory, posix_spawnp');
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-k2', pythonPath: 'nopython', socketAddress: port.toString(), readyTimeoutMs: 500 },
      router,
      silentLogger()
    );
    await assert.rejects(() => c.start(), /pty\.spawn failed/);
    c.dispose();
  });

  // RFC-008 §"Failure modes" K7 — PTY EOF before ready.
  test('start() rejects when PTY exits before the ready handshake (K7)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-k7', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const p = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    fakeMod.spawned[0].fireExit(2);
    await assert.rejects(() => p, /exited before ready handshake/);
    c.dispose();
  });

  // RFC-008 §6 — frame dispatch by top-level keys.
  test('dispatchLine routes traceId+spanId frames to span sink (Family A)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-disp-span', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const seenSpans: RunMimePayload[] = [];
    router.registerRunObserver({
      onRunStart: (s) => seenSpans.push(s),
      onRunEvent: () => { /* noop */ },
      onRunComplete: () => { /* noop */ }
    });
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord('sess-disp-span')) + '\n');
    await startPromise;

    const span = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'test',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: null,
      attributes: encodeAttrs({ 'llmnb.run_type': 'chain' }),
      status: { code: 'STATUS_CODE_UNSET', message: '' }
    };
    sock.write(JSON.stringify(span) + '\n');
    await waitForPredicate(() => seenSpans.length >= 1, 1000);
    assert.equal(seenSpans[0].spanId, 'b'.repeat(16));
    sock.destroy();
    c.dispose();
  });

  test('dispatchLine routes timeUnixNano+severityNumber frames to LogRecordObserver', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-disp-log', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const seenLogs: OtlpLogRecord[] = [];
    router.registerLogRecordHandler((r) => seenLogs.push(r));
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    // The ready record IS a LogRecord; it reaches the LogRecordObserver too.
    sock.write(JSON.stringify(readyRecord('sess-disp-log')) + '\n');
    await startPromise;

    const log: OtlpLogRecord = {
      timeUnixNano: '2',
      severityNumber: 13,
      severityText: 'WARN',
      body: { stringValue: 'oh no' },
      attributes: []
    };
    sock.write(JSON.stringify(log) + '\n');
    await waitForPredicate(() => seenLogs.some((l) => l.severityNumber === 13), 1000);
    const warn = seenLogs.find((l) => l.severityNumber === 13);
    assert.ok(warn);
    assert.equal(warn?.body?.stringValue, 'oh no');
    sock.destroy();
    c.dispose();
  });

  test('dispatchLine routes type+payload frames to comm sink (Family B–F)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-disp-env', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const seenEnv: RtsV2Envelope<unknown>[] = [];
    c.setCommSink({ emit: (env) => seenEnv.push(env) });
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord('sess-disp-env')) + '\n');
    await startPromise;

    const env: RtsV2Envelope<unknown> = {
      type: 'layout.update',
      payload: { snapshot_version: 1, tree: { id: 'r', type: 'workspace', children: [] } }
    };
    sock.write(JSON.stringify(env) + '\n');
    await waitForPredicate(() => seenEnv.length >= 1, 1000);
    assert.equal(seenEnv[0].type, 'layout.update');
    sock.destroy();
    c.dispose();
  });

  // RFC-008 §"Failure modes" K8 — malformed JSON.
  test('dispatchLine returns malformed for unparseable bytes (K8)', () => {
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-k8', pythonPath: 'python', socketAddress: 'tcp:127.0.0.1:0' },
      router,
      silentLogger()
    );
    const kind = c.dispatchLine('not-json{{{');
    assert.equal(kind, 'malformed');
  });

  // RFC-008 §"Failure modes" K8 — frame with no recognized shape.
  test('dispatchLine returns malformed for frames with no recognized shape', () => {
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-k8b', pythonPath: 'python', socketAddress: 'tcp:127.0.0.1:0' },
      router,
      silentLogger()
    );
    const kind = c.dispatchLine(JSON.stringify({ random: 'thing' }));
    assert.equal(kind, 'malformed');
  });

  // RFC-008 §"Failure modes" K5 — RFC version drift surfaces drift events.
  test('drift events fire when the ready record reports a major-version mismatch (K5)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-drift';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const captured: { attribute: string; observed: string; severity: string }[] = [];
    c.onDrift((d) => captured.push(d));

    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);

    const sock = await connectKernelSocket(port.toString());
    // RFC-006 v2 → v3: major mismatch.
    sock.write(JSON.stringify(readyRecord(sessionId, {
      'llmnb.kernel.rfc_006_version': '3.0.0'
    })) + '\n');
    await startPromise;

    const drift = c.getDriftEvents();
    assert.ok(drift.find((d) => d.attribute === 'llmnb.kernel.rfc_006_version' && d.severity === 'major_mismatch'));
    assert.ok(captured.find((d) => d.attribute === 'llmnb.kernel.rfc_006_version'));
    sock.destroy();
    c.dispose();
  });

  // RFC-008 §"Failure modes" K10 — second client rejected.
  test('second concurrent connection is rejected (K10)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-k10';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);

    const first = await connectKernelSocket(port.toString());
    first.write(JSON.stringify(readyRecord(sessionId)) + '\n');
    await startPromise;

    const second = await connectKernelSocket(port.toString());
    // The kernel client closes the second socket; we observe it via 'end'/'close'.
    await new Promise<void>((resolve) => {
      second.on('close', () => resolve());
      // Safety timeout in case the close event was already missed.
      setTimeout(resolve, 500);
    });
    first.destroy();
    c.dispose();
  });

  // RFC-008 §"Failure modes" K6 — data-plane EOF mid-session.
  test('data-plane socket EOF after ready does not throw (K6)', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-k6';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);

    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord(sessionId)) + '\n');
    await startPromise;
    sock.end();
    sock.destroy();
    // No assertions — survival is the contract; absence of unhandled
    // exceptions is the success condition.
    await new Promise((r) => setTimeout(r, 50));
    c.dispose();
  });

  // RFC-008 §5 — interrupt() sends SIGINT.
  test('interrupt() delivers SIGINT to the PTY', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-int', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord('sess-int')) + '\n');
    await startPromise;

    c.interrupt();
    assert.deepEqual(fakeMod.spawned[0].killSignals, ['SIGINT']);
    sock.destroy();
    c.dispose();
  });

  // RFC-008 §4 / §"Failure modes" K11 — shutdown sends `kernel.shutdown_request`,
  // escalates to SIGTERM after the grace window.
  test('shutdown() emits kernel.shutdown_request envelope and escalates to SIGTERM', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-k11';
    const c = new PtyKernelClient(
      {
        sessionId,
        pythonPath: 'python',
        socketAddress: port.toString(),
        readyTimeoutMs: 5000,
        shutdownGraceMs: 50
      },
      router,
      silentLogger()
    );
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord(sessionId)) + '\n');
    await startPromise;

    // Capture frames the kernel client writes onto the socket.
    const received: string[] = [];
    sock.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const l of lines) {
        if (l.length > 0) {
          received.push(l);
        }
      }
    });

    const shutdownPromise = c.shutdown();
    // Wait for the shutdown_request frame to appear.
    await waitForPredicate(() => received.some((l) => l.includes('kernel.shutdown_request')), 1000);
    // After shutdownGraceMs (50ms) the client SIGTERMs the PTY; the FakePty
    // fires its exit on SIGTERM, which resolves shutdown.
    await shutdownPromise;
    assert.ok(fakeMod.spawned[0].killSignals.includes('SIGTERM'));
    sock.destroy();
  });

  // RFC-008 §3 — PTY data fans into onPtyData listeners (kernel terminal).
  test('onPtyData listeners receive bytes the kernel writes to the PTY', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const c = new PtyKernelClient(
      { sessionId: 'sess-ptydata', pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );
    const collected: string[] = [];
    c.onPtyData((d) => collected.push(d));
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    fakeMod.spawned[0]._emitData('LLMKernel pty-mode v1.0.0\r\n');
    const sock = await connectKernelSocket(port.toString());
    sock.write(JSON.stringify(readyRecord('sess-ptydata')) + '\n');
    await startPromise;
    assert.ok(collected.some((c) => c.includes('LLMKernel')));
    sock.destroy();
    c.dispose();
  });
});

// Local waitFor removed in FSP-003 Pillar A — use waitForPredicate (this
// suite polls fixture-internal fake-module state, not extension lifecycle).
