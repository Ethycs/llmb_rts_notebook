// Contract tests for the application/vnd.rts.run+json MIME renderer.
//
// I-X: per RFC-006 §1, the run-MIME value is now the bare OTLP/JSON span (or
// `{spanId, event}` partial event) — no envelope. The renderer dispatches on
// `attributes["llmnb.run_type"]` plus `attributes["tool.name"]` for tool runs.
//
// Spec references:
//   RFC-006 §1            — Family A bare OTLP/JSON
//   RFC-001               — notebook tool ABI (notify, report_completion, …)
//   RFC-005 §"agent_emit" — agent_emit run dispatch (covered separately by
//                            agent-emit-renderer.test.ts)
//
// The bundle is `extension/dist/run-renderer.js` produced by `npm run
// package:renderer`. If the bundle is missing the suite skips.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type {
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../../src/messaging/types.js';
import { encodeAttrs } from '../../src/otel/attrs.js';

const RENDERER_BUNDLE: string = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'dist',
  'run-renderer.js'
);

interface RendererModule {
  activate: (ctx: unknown) => { renderOutputItem: (item: OutputItemLike, element: HTMLElement) => void };
}

interface OutputItemLike {
  mime: string;
  json(): unknown;
  text(): string;
  data: Uint8Array;
}

function makeStubItem(payload: unknown): OutputItemLike {
  const text = JSON.stringify(payload);
  return {
    mime: 'application/vnd.rts.run+json',
    json: (): unknown => payload,
    text: (): string => text,
    data: new TextEncoder().encode(text)
  };
}

function makeStubElement(): HTMLElement {
  const stub = {
    innerHTML: '',
    textContent: ''
  };
  return stub as unknown as HTMLElement;
}

const SAMPLE_TRACE_ID = 'a'.repeat(32);
const SAMPLE_SPAN_ID = 'b'.repeat(16);

suite('contract: MIME renderer (application/vnd.rts.run+json)', () => {
  let renderer: ReturnType<RendererModule['activate']> | undefined;

  suiteSetup(async function (): Promise<void> {
    if (!fs.existsSync(RENDERER_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mime-renderer.test] ${RENDERER_BUNDLE} missing — run \`npm run package\` first; skipping`
      );
      this.skip();
      return;
    }
    const mod = (await import(url.pathToFileURL(RENDERER_BUNDLE).href)) as RendererModule;
    renderer = mod.activate({});
  });

  test('activate(ctx) returns an object with renderOutputItem', () => {
    assert.ok(renderer, 'renderer must be loaded');
    assert.equal(typeof renderer!.renderOutputItem, 'function');
  });

  // RFC-001 — tool dispatch on `notify` (attributes-driven).
  test('open span (llmnb.run_type=tool, tool.name=notify) produces [NOTIFY] in HTML', () => {
    const span: RunStartPayload = {
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
      name: 'notify',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1745588938412000000',
      endTimeUnixNano: null,
      attributes: encodeAttrs({
        'llmnb.run_type': 'tool',
        'tool.name': 'notify',
        'input.value': JSON.stringify({ observation: 'hello world', importance: 'info' }),
        'input.mime_type': 'application/json'
      }),
      status: { code: 'STATUS_CODE_UNSET', message: '' }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(span), el);
    assert.ok(el.innerHTML.length > 0, 'innerHTML should be non-empty');
    assert.ok(el.innerHTML.includes('[NOTIFY]'), `expected [NOTIFY] in ${el.innerHTML}`);
  });

  // RFC-006 §1 — partial event payload `{spanId, event}` over update_display_data.
  test('partial event payload produces an event div with the event name', () => {
    const payload: RunEventPayload = {
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
      event: {
        timeUnixNano: '1745588938512000000',
        name: 'gen_ai.choice',
        attributes: encodeAttrs({ 'gen_ai.choice.delta': 'hi' })
      }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(payload), el);
    assert.ok(el.innerHTML.length > 0);
    assert.ok(
      el.innerHTML.includes('gen_ai.choice') || el.innerHTML.includes('rts-run-event'),
      `expected event marker in ${el.innerHTML}`
    );
  });

  // RFC-006 §1 — closed span with STATUS_CODE_OK.
  test('closed span STATUS_CODE_OK produces [done: success] in HTML', () => {
    const span: RunCompletePayload = {
      traceId: SAMPLE_TRACE_ID,
      spanId: SAMPLE_SPAN_ID,
      name: 'echo',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1745588938412000000',
      endTimeUnixNano: '1745588938612000000',
      attributes: encodeAttrs({ 'llmnb.run_type': 'chain' }),
      status: { code: 'STATUS_CODE_OK', message: '' }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(span), el);
    assert.ok(el.innerHTML.includes('[done: success]'), `expected [done: success] in ${el.innerHTML}`);
  });

  // RFC-006 §"Failure modes" W2 — fail-closed on malformed input must NOT throw.
  test('renderer does not throw on a non-payload object', () => {
    const el = makeStubElement();
    const malformed = { not_a_span: true };
    assert.doesNotThrow(() => renderer!.renderOutputItem(makeStubItem(malformed), el));
    assert.ok(
      el.innerHTML.length > 0 || el.textContent.length > 0,
      'renderer should still write *something* to the element'
    );
  });
});
