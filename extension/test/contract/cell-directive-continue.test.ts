// Unit tests for the BSP-005 S3 `@<agent_id>: <text>` continuation
// grammar.
//
// Two layers under test:
//   1. parseCellDirective() — the pure parser added in S3 alongside the
//      existing /spawn parser. Verifies the @-prefix branch returns the
//      right `{kind:"continue", agent_id, text}` shape, including the
//      "colon inside body" edge case.
//   2. PtyKernelClient.executeCell() — when the parsed directive is a
//      continuation, the outbound RFC-006 Family D envelope MUST carry
//      `action_type: "agent_continue"` with `intent_kind:
//      "send_user_turn"` per atoms/protocols/operator-action.md.
//
// Spec references:
//   atoms/operations/continue-turn.md       — the operation
//   atoms/protocols/operator-action.md      — outer envelope shape
//   docs/notebook/BSP-002 §3 / §4.2         — directive grammar / lifecycle
//   docs/notebook/BSP-005 §"S3"             — slice spec

import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import * as vscode from 'vscode';
import {
  CellDirective,
  parseCellDirective
} from '../../src/notebook/controller.js';
import {
  PtyKernelClient,
  __setPtyModule,
  IPtyLike,
  EXTENSION_RFC_VERSIONS
} from '../../src/notebook/pty-kernel-client.js';
import {
  MessageRouter,
  OtlpLogRecord
} from '../../src/messaging/router.js';
import { waitForPredicate } from '../util/typed-waits.js';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'cell-directive-continue-test-log',
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

// --- Pure-parser tests -----------------------------------------------------

suite('parseCellDirective (continue): @<agent>: <text>', () => {
  test('@<agent>: <text> parses to a continue directive', () => {
    const d = parseCellDirective('@alpha: hello');
    assert.deepEqual(d, { kind: 'continue', agent_id: 'alpha', text: 'hello' });
  });

  test('text containing further colons is preserved verbatim', () => {
    // BSP-002 §3 — only the FIRST colon after @<agent_id> is the
    // separator. The body may contain additional colons (e.g. ratios,
    // URLs, JSON-ish snippets).
    const d = parseCellDirective('@alpha: ratio is 1:2');
    assert.deepEqual(d, {
      kind: 'continue',
      agent_id: 'alpha',
      text: 'ratio is 1:2'
    });

    const url = parseCellDirective('@beta: see https://example.com:8080/path');
    assert.deepEqual(url, {
      kind: 'continue',
      agent_id: 'beta',
      text: 'see https://example.com:8080/path'
    });
  });

  test('agent_id accepts the same character class /spawn does', () => {
    // BSP-002 §6 references but does not pin a strict regex; the V1
    // parser tolerates path-like / alphanumeric ids on BOTH /spawn and
    // @-continuation so a re-run of the same id always lands on the
    // same agent. The brief flagged `[a-z][a-z0-9_]*` from BSP-002 §6;
    // that strict shape is NOT in BSP-002 §6 (the section addresses
    // cell-as-agent-identity, not the regex). The V1 parser thus
    // ACCEPTS `123abc` here — flagged in the slice report rather than
    // hard-coded.
    const d = parseCellDirective('@123abc: continue');
    assert.deepEqual(d, {
      kind: 'continue',
      agent_id: '123abc',
      text: 'continue'
    });

    // Path-like (mirrors the existing spawn test):
    const path = parseCellDirective('@zone-1/alpha: do thing');
    assert.deepEqual(path, {
      kind: 'continue',
      agent_id: 'zone-1/alpha',
      text: 'do thing'
    });

    // Whitespace tolerance:
    const padded = parseCellDirective('  @alpha: hello  \n');
    assert.deepEqual(padded, {
      kind: 'continue',
      agent_id: 'alpha',
      text: 'hello'
    });
  });

  test('malformed @-cells return null', () => {
    // No body after the colon.
    assert.equal(parseCellDirective('@alpha:'), null);
    assert.equal(parseCellDirective('@alpha:   '), null);
    // No colon at all (the existing parser already returns null here;
    // re-asserted to keep the regression visible).
    assert.equal(parseCellDirective('@agent foo'), null);
    // Empty agent_id.
    assert.equal(parseCellDirective('@: hello'), null);
    // Not @-prefixed.
    assert.equal(parseCellDirective('alpha: hello'), null);
  });
});

// --- Wire-envelope tests via PtyKernelClient -------------------------------

class FakePty implements IPtyLike {
  public readonly pid = 24680;
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
    this.fireExit(143);
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

class FakePtyModule {
  public spawned: FakePty[] = [];
  public spawn(_file: string, _args: string[], _options: { env?: NodeJS.ProcessEnv }): FakePty {
    const p = new FakePty();
    this.spawned.push(p);
    return p;
  }
}

function readyRecord(sessionId: string): OtlpLogRecord {
  const attrs: Array<{ key: string; value: { stringValue: string } }> = [
    { key: 'event.name', value: { stringValue: 'kernel.ready' } },
    { key: 'llmnb.kernel.session_id', value: { stringValue: sessionId } }
  ];
  for (const [shortKey, expected] of Object.entries(EXTENSION_RFC_VERSIONS)) {
    attrs.push({
      key: `llmnb.kernel.${shortKey}`,
      value: { stringValue: expected }
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

suite('contract: cell-directive @-continuation -> agent_continue envelope', () => {
  let fakeMod: FakePtyModule;

  setup(() => {
    fakeMod = new FakePtyModule();
    __setPtyModule(fakeMod);
  });

  teardown(() => {
    __setPtyModule(undefined);
  });

  test('continue directive ships agent_continue with intent_kind=send_user_turn', async () => {
    const port = await pickTcpPort();
    const router = new MessageRouter(silentLogger());
    const sessionId = 'sess-continue-envelope';
    const c = new PtyKernelClient(
      { sessionId, pythonPath: 'python', socketAddress: port.toString(), readyTimeoutMs: 5000 },
      router,
      silentLogger()
    );

    // Capture outbound frames written by the client.
    const outbound: string[] = [];
    const startPromise = c.start();
    await waitForPredicate(() => fakeMod.spawned.length === 1, 1000);
    const sock = await connectKernelSocket(port.toString());
    sock.on('data', (chunk: string | Buffer) => {
      outbound.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    sock.write(JSON.stringify(readyRecord(sessionId)) + '\n');
    await startPromise;

    // Now ship a continue directive through executeCell. The kernel
    // never emits a terminal span for this stub, so we need a timeout
    // race: race executeCell against a 200ms wait for the outbound
    // frame to land. The envelope assertion happens regardless of
    // whether the inner promise resolves.
    const directive: CellDirective = {
      kind: 'continue',
      agent_id: 'alpha',
      text: 'now optimize for read performance'
    };
    const cellUri = 'vscode-notebook-cell:test#c1';
    const sink = { emit: (): void => { /* drop */ } };
    const exec = c.executeCell(
      { cellUri, text: '@alpha: now optimize for read performance', directive },
      sink
    );
    // Don't actually await — race against a short window for the wire
    // observation. The 60s timeout inside executeCell would otherwise
    // dominate the suite.
    exec.catch(() => {
      /* intentional: executeCell awaits a terminal span we never send */
    });

    await waitForPredicate(() => outbound.length > 0, 2000);
    // Concatenate frames, parse one-by-one on '\n'.
    const lines = outbound.join('').split('\n').filter((s) => s.length > 0);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((v): v is Record<string, unknown> => v !== undefined);

    const continueEnv = parsed.find(
      (env) =>
        env['type'] === 'operator.action' &&
        typeof env['payload'] === 'object' &&
        env['payload'] !== null &&
        (env['payload'] as Record<string, unknown>)['action_type'] ===
          'agent_continue'
    );
    assert.ok(
      continueEnv,
      `expected an agent_continue envelope; saw types=[${parsed.map((p) => p['type']).join(',')}]`
    );
    const payload = continueEnv['payload'] as Record<string, unknown>;
    assert.equal(payload['action_type'], 'agent_continue');
    assert.equal(payload['intent_kind'], 'send_user_turn');
    assert.equal(payload['originating_cell_id'], cellUri);
    const params = payload['parameters'] as Record<string, unknown>;
    assert.equal(params['agent_id'], 'alpha');
    assert.equal(params['text'], 'now optimize for read performance');
    assert.equal(params['cell_id'], cellUri);

    sock.destroy();
    c.dispose();
  });
});
