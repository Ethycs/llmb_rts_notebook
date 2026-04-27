// Contract tests for the application/vnd.rts.run+json MIME renderer.
//
// Doc-driven rule: each assertion walks a documented surface from
//   chapter 07 — subtractive fork & storage (renderer registration)
//   RFC-001    — notebook tool ABI (notify, report_completion, …)
//   RFC-003    — run.start / run.event / run.complete shapes
//
// The bundle is `extension/dist/run-renderer.js` produced by `npm run package`.
// If the bundle is missing the suite skips (renderer is build-output, not source).

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type {
  Rfc003Envelope,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../../src/messaging/types.js';

// CJS test build — __filename and __dirname are Node globals; no redeclaration needed.

/** extension/dist/run-renderer.js, regardless of compiled-out depth. */
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

function makeStubItem(envelope: unknown): OutputItemLike {
  const text = JSON.stringify(envelope);
  return {
    mime: 'application/vnd.rts.run+json',
    json: (): unknown => envelope,
    text: (): string => text,
    data: new TextEncoder().encode(text)
  };
}

function makeStubElement(): HTMLElement {
  // Minimal HTMLElement stub: only innerHTML / textContent are exercised.
  // Casting through unknown because the renderer uses element.innerHTML setter.
  const stub = {
    innerHTML: '',
    textContent: ''
  };
  return stub as unknown as HTMLElement;
}

suite('contract: MIME renderer (application/vnd.rts.run+json)', () => {
  let renderer: ReturnType<RendererModule['activate']> | undefined;

  suiteSetup(async function (): Promise<void> {
    if (!fs.existsSync(RENDERER_BUNDLE)) {
      // The renderer is build-output. Without it loaded the contract assertion
      // is meaningless, so skip rather than fail.
      // eslint-disable-next-line no-console
      console.warn(
        `[mime-renderer.test] ${RENDERER_BUNDLE} missing — run \`npm run package\` first; skipping`
      );
      this.skip();
      return;
    }
    // The renderer bundle is ESM (esbuild --format=esm). Use dynamic import.
    const mod = (await import(url.pathToFileURL(RENDERER_BUNDLE).href)) as RendererModule;
    renderer = mod.activate({});
  });

  // chapter 07 §"renderers": activate() returns { renderOutputItem }.
  test('activate(ctx) returns an object with renderOutputItem', () => {
    assert.ok(renderer, 'renderer must be loaded');
    assert.equal(typeof renderer!.renderOutputItem, 'function');
  });

  // RFC-001 — tool dispatch on `notify`
  test('run.start (run_type=tool, name=notify) produces [NOTIFY] in HTML', () => {
    const env: Rfc003Envelope<RunStartPayload> = {
      message_type: 'run.start',
      direction: 'kernel→extension',
      correlation_id: 'r1',
      timestamp: '2026-04-26T00:00:00.000Z',
      rfc_version: '1.0.0',
      payload: {
        id: 'r1',
        trace_id: 'r1',
        parent_run_id: null,
        name: 'notify',
        run_type: 'tool',
        start_time: '2026-04-26T00:00:00.000Z',
        inputs: { observation: 'hello world', importance: 'medium' }
      }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(env), el);
    assert.ok(el.innerHTML.length > 0, 'innerHTML should be non-empty');
    assert.ok(el.innerHTML.includes('[NOTIFY]'), `expected [NOTIFY] in ${el.innerHTML}`);
  });

  // RFC-003 §Family A — run.event{event_type=token}
  test('run.event token produces an event div with the token data', () => {
    const env: Rfc003Envelope<RunEventPayload> = {
      message_type: 'run.event',
      direction: 'kernel→extension',
      correlation_id: 'r1',
      timestamp: '2026-04-26T00:00:00.000Z',
      rfc_version: '1.0.0',
      payload: {
        run_id: 'r1',
        event_type: 'token',
        data: { delta: 'hi' },
        timestamp: '2026-04-26T00:00:00.000Z'
      }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(env), el);
    assert.ok(el.innerHTML.length > 0);
    assert.ok(
      el.innerHTML.includes('token') || el.innerHTML.includes('rts-run-event'),
      `expected token marker in ${el.innerHTML}`
    );
  });

  // RFC-003 §Family A — run.complete{status=success}
  test('run.complete success produces [done: success] in HTML', () => {
    const env: Rfc003Envelope<RunCompletePayload> = {
      message_type: 'run.complete',
      direction: 'kernel→extension',
      correlation_id: 'r1',
      timestamp: '2026-04-26T00:00:00.000Z',
      rfc_version: '1.0.0',
      payload: {
        run_id: 'r1',
        end_time: '2026-04-26T00:00:00.000Z',
        outputs: {},
        status: 'success'
      }
    };
    const el = makeStubElement();
    renderer!.renderOutputItem(makeStubItem(env), el);
    assert.ok(el.innerHTML.includes('[done: success]'), `expected [done: success] in ${el.innerHTML}`);
  });

  // RFC-003 F1 — fail-closed on malformed input must NOT throw.
  test('renderer does not throw on a non-envelope object', () => {
    const el = makeStubElement();
    const malformed = { not_an_envelope: true };
    assert.doesNotThrow(() => renderer!.renderOutputItem(makeStubItem(malformed), el));
    // Either rendered as a JSON pre-block or as an error message — both
    // satisfy the contract that no exception escapes.
    assert.ok(
      el.innerHTML.length > 0 || el.textContent.length > 0,
      'renderer should still write *something* to the element'
    );
  });
});
