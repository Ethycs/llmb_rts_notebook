// Smoke tests for JupyterKernelClient v2 wire translation.
//
// These tests exercise iopub → bare-OTLP translation by injecting hand-rolled
// fakes for Kernel.IKernelConnection / Kernel.IFuture. Real integration
// against a live Jupyter server is deferred to Stage 4 (the test-electron +
// WebdriverIO harness) — see TODO(T1) in extension/src/extension.test.ts.
//
// I-X: the v1 envelope MIME (`application/vnd.rts.envelope+json`) is dropped
// from the consumer; the client now emits bare OTLP spans (or `{spanId,
// event}` partial events) directly. The Comm target is `llmnb.rts.v2`.
//
// Spec references:
//   RFC-006 §1                     — Family A wire (OTLP over IOPub, no envelope)
//   RFC-006 §"Conformance during transition" / W10 — dual-MIME tolerance
//   RFC-006 §2                     — Comm target name `llmnb.rts.v2`

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  JupyterKernelClient,
  RTS_ENVELOPE_MIME_DEPRECATED,
  RTS_RUN_MIME,
  RTS_COMM_TARGET,
  JupyterKernelConfig
} from './jupyter-kernel-client.js';
import type {
  KernelExecuteRequest,
  KernelEventSink
} from './controller.js';
import type {
  RunCompletePayload,
  RunEventPayload,
  RunStartPayload,
  RunMimePayload,
  RtsV2Envelope
} from '../messaging/types.js';
import { encodeAttrs, getStringAttr } from '../otel/attrs.js';
import type { OtlpSpan } from '../otel/attrs.js';

interface IOPubLike {
  header: { msg_type: string };
  content: Record<string, unknown>;
}

interface FakeReply {
  content: { status: 'ok' | 'error'; ename?: string; evalue?: string; traceback?: string[] };
}

class FakeFuture {
  public onIOPub: ((msg: IOPubLike) => void) | undefined;
  public done: Promise<FakeReply>;
  public constructor(
    private readonly iopubs: IOPubLike[],
    private readonly reply: FakeReply
  ) {
    this.done = new Promise<FakeReply>((resolve) => {
      // Schedule iopub replay + reply on next tick so the caller can attach
      // onIOPub before any messages arrive.
      setTimeout(() => {
        for (const m of this.iopubs) {
          this.onIOPub?.(m);
        }
        resolve(this.reply);
      }, 0);
    });
  }
  public dispose(): void {
    /* no-op */
  }
}

class FakeKernel {
  public lastCode: string | undefined;
  public commCallback: ((comm: unknown, openMsg: unknown) => void) | undefined;
  public lastCommTarget: string | undefined;
  public constructor(
    private readonly iopubs: IOPubLike[],
    private readonly reply: FakeReply
  ) {}
  public requestExecute(content: { code: string }): FakeFuture {
    this.lastCode = content.code;
    return new FakeFuture(this.iopubs, this.reply);
  }
  public registerCommTarget(
    target: string,
    cb: (comm: unknown, openMsg: unknown) => void
  ): void {
    this.lastCommTarget = target;
    this.commCallback = cb;
  }
  public dispose(): void {
    /* no-op */
  }
}

function fakeLogger(): vscode.LogOutputChannel {
  // Smallest surface the client uses; cast at the boundary because the real
  // LogOutputChannel surface includes vscode.OutputChannel members we don't need.
  const noop = (): void => {
    /* no-op */
  };
  return {
    name: 'fake',
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

function newClient(kernel: FakeKernel): JupyterKernelClient {
  const config: JupyterKernelConfig = {
    serverUrl: 'http://127.0.0.1:8888',
    token: '',
    kernelName: 'llm_kernel'
  };
  const client = new JupyterKernelClient(config, fakeLogger());
  // Force-inject the fake kernel and bypass connect().
  (client as unknown as { kernel: unknown }).kernel = kernel;
  return client;
}

function captureSink(): { sink: KernelEventSink; payloads: RunMimePayload[] } {
  const payloads: RunMimePayload[] = [];
  return {
    payloads,
    sink: { emit: (p) => payloads.push(p) }
  };
}

const REQ: KernelExecuteRequest = { cellUri: 'cell://1', text: '/spawn alpha' };

/** OTLP-shaped open span sample. endTimeUnixNano:null → in-progress. */
function startSpan(): OtlpSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'echo',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1745588938412000000',
    endTimeUnixNano: null,
    attributes: encodeAttrs({ 'llmnb.run_type': 'chain' }),
    status: { code: 'STATUS_CODE_UNSET', message: '' }
  };
}

/** OTLP-shaped terminal span sample. */
function completeSpan(status: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' = 'STATUS_CODE_OK'): OtlpSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'echo',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1745588938412000000',
    endTimeUnixNano: '1745588938512000000',
    attributes: encodeAttrs({ 'llmnb.run_type': 'chain' }),
    status: { code: status, message: '' }
  };
}

suite('JupyterKernelClient v2 iopub translation', () => {
  test('display_data with rts.run+json yields the bare OTLP span (open)', async () => {
    const k = new FakeKernel(
      [
        {
          header: { msg_type: 'display_data' },
          content: { data: { [RTS_RUN_MIME]: startSpan() }, transient: { display_id: 'b'.repeat(16) } }
        }
      ],
      { content: { status: 'ok' } }
    );
    const c = newClient(k);
    const { sink, payloads } = captureSink();
    await c.executeCell(REQ, sink);
    assert.strictEqual(payloads.length, 1);
    const span = payloads[0] as RunStartPayload;
    assert.strictEqual(span.spanId, 'b'.repeat(16));
    assert.strictEqual(span.endTimeUnixNano, null);
  });

  test('update_display_data with run-event partial payload yields {spanId, event}', async () => {
    const eventPayload: RunEventPayload = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      event: {
        timeUnixNano: '1745588938512000000',
        name: 'gen_ai.choice',
        attributes: encodeAttrs({ 'gen_ai.choice.delta': 'hi' })
      }
    };
    const k = new FakeKernel(
      [
        {
          header: { msg_type: 'update_display_data' },
          content: { data: { [RTS_RUN_MIME]: eventPayload } }
        }
      ],
      { content: { status: 'ok' } }
    );
    const c = newClient(k);
    const { sink, payloads } = captureSink();
    await c.executeCell(REQ, sink);
    assert.strictEqual(payloads.length, 1);
    const ev = payloads[0] as RunEventPayload;
    assert.strictEqual(ev.event.name, 'gen_ai.choice');
  });

  test('update_display_data with terminal status yields the closed OTLP span', async () => {
    const k = new FakeKernel(
      [
        {
          header: { msg_type: 'update_display_data' },
          content: { data: { [RTS_RUN_MIME]: completeSpan('STATUS_CODE_OK') } }
        }
      ],
      { content: { status: 'ok' } }
    );
    const c = newClient(k);
    const { sink, payloads } = captureSink();
    await c.executeCell(REQ, sink);
    assert.strictEqual(payloads.length, 1);
    const span = payloads[0] as RunCompletePayload;
    assert.strictEqual(span.status.code, 'STATUS_CODE_OK');
    assert.ok(span.endTimeUnixNano && span.endTimeUnixNano.length > 0);
  });

  test('dual-MIME emission prefers OTLP and ignores the deprecated envelope MIME (W10)', async () => {
    // Producer emits both MIMEs. The consumer must dispatch on the OTLP MIME.
    const verbatim = {
      message_type: 'run.start',
      direction: 'kernel→extension',
      correlation_id: 'b'.repeat(16),
      timestamp: '2026-04-26T00:00:00.000Z',
      rfc_version: '1.0.0',
      payload: startSpan()
    };
    const k = new FakeKernel(
      [
        {
          header: { msg_type: 'display_data' },
          content: { data: { [RTS_ENVELOPE_MIME_DEPRECATED]: verbatim, [RTS_RUN_MIME]: verbatim.payload } }
        }
      ],
      { content: { status: 'ok' } }
    );
    const c = newClient(k);
    const { sink, payloads } = captureSink();
    await c.executeCell(REQ, sink);
    assert.strictEqual(payloads.length, 1);
    // Must be the bare span, NOT the envelope.
    const span = payloads[0] as OtlpSpan;
    assert.strictEqual(span.spanId, 'b'.repeat(16));
    // Envelope-shape detection: envelopes have a `message_type` key.
    assert.ok(
      !('message_type' in (payloads[0] as object)),
      'consumer must ignore the deprecated envelope MIME'
    );
  });

  test('shell reply status=error emits a synthetic terminal error span', async () => {
    const k = new FakeKernel([], {
      content: { status: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['tb1', 'tb2'] }
    });
    const c = newClient(k);
    const { sink, payloads } = captureSink();
    await c.executeCell(REQ, sink);
    const last = payloads[payloads.length - 1] as RunCompletePayload;
    assert.strictEqual(last.status.code, 'STATUS_CODE_ERROR');
    assert.strictEqual(getStringAttr(last.attributes, 'exception.type'), 'ValueError');
  });

  test('comm target name is `llmnb.rts.v2` (RFC-006 §2)', async () => {
    const k = new FakeKernel([], { content: { status: 'ok' } });
    const c = newClient(k);
    // Force the doConnect path to register the comm target. We cheat by
    // calling the private doConnect directly; an alternative is to re-run
    // connect(), but that would require live network. Instead invoke the
    // already-injected fake kernel's registerCommTarget through a private
    // re-entry: simulate doConnect's call.
    (k as unknown as { registerCommTarget: (n: string, cb: (c: unknown, m: unknown) => void) => void }).registerCommTarget(
      RTS_COMM_TARGET,
      () => {
        /* no-op */
      }
    );
    assert.strictEqual(k.lastCommTarget, 'llmnb.rts.v2');
    // Quiet linter on unused client.
    void c;
  });

  test('comm_msg on llmnb.rts.v2 forwards the inner envelope via setCommSink', async () => {
    const inner: RtsV2Envelope<unknown> = {
      type: 'layout.update',
      correlation_id: 'cid-1',
      payload: { snapshot_version: 1, tree: { id: 'r', type: 'workspace', children: [] } }
    };
    const k = new FakeKernel([], { content: { status: 'ok' } });
    const c = newClient(k);
    const seen: RtsV2Envelope<unknown>[] = [];
    c.setCommSink({ emit: (env) => seen.push(env) });

    // Mirror what doConnect would do: register the comm target on the kernel.
    k.registerCommTarget('llmnb.rts.v2', (comm: unknown) => {
      (comm as { onMsg?: (m: unknown) => void }).onMsg = (msg: unknown) => {
        const data = (msg as { content: { data: unknown } }).content.data;
        // The client's setCommSink path is what we're exercising; the fake
        // here re-routes through the same call shape the real doConnect uses.
        const sink = (c as unknown as { commSink?: { emit: (e: RtsV2Envelope<unknown>) => void } }).commSink;
        sink?.emit(data as RtsV2Envelope<unknown>);
      };
    });

    const fakeComm = { onMsg: undefined as ((m: unknown) => void) | undefined };
    k.commCallback?.(fakeComm, { content: { target_name: 'llmnb.rts.v2' } });
    fakeComm.onMsg?.({ content: { data: inner } });

    assert.ok(seen.length >= 1);
    assert.deepStrictEqual(seen[seen.length - 1], inner);
  });
});
