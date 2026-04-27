// Contract tests for the agent_emit renderer component.
//
// Spec references:
//   RFC-005 §"agent_emit runs"  — emit_kind enum + visual policy
//   RFC-006 §1                  — Family A (bare OTLP/JSON over IOPub)
//
// Like mime-renderer.test.ts, this exercises the BUILT renderer bundle so
// that the assertions cover the same code path operators see in production.
// If `extension/dist/run-renderer.js` is missing the suite skips.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { OtlpSpan } from '../../src/otel/attrs.js';
import { encodeAttrs } from '../../src/otel/attrs.js';

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

function makeStubItem(payload: unknown): OutputItemLike {
  const text = JSON.stringify(payload);
  return {
    mime: 'application/vnd.rts.run+json',
    json: (): unknown => payload,
    text: (): string => text,
    data: new TextEncoder().encode(text)
  };
}

function makeStubElement(): { innerHTML: string; textContent: string; addEventListener?: () => void } {
  return { innerHTML: '', textContent: '' };
}

const KINDS: Array<{
  kind: string;
  // The DOM substring we expect for each emit_kind. We assert on the data
  // attribute the stylesheet keys off plus the bracketed header label.
  marker: string;
}> = [
  { kind: 'prose', marker: '[prose]' },
  { kind: 'reasoning', marker: '[reasoning]' },
  { kind: 'system_message', marker: '[system_message]' },
  { kind: 'result', marker: '[result]' },
  { kind: 'error', marker: '[error]' },
  { kind: 'stderr', marker: '[stderr]' },
  { kind: 'invalid_tool_use', marker: '[invalid_tool_use]' },
  { kind: 'malformed_json', marker: '[malformed_json]' }
];

function agentEmitSpan(kind: string, content = 'sample emission'): OtlpSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: `agent_emit:${kind}`,
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1745588938302000000',
    endTimeUnixNano: null,
    attributes: encodeAttrs({
      'llmnb.run_type': 'agent_emit',
      'llmnb.agent_id': 'alpha',
      'llmnb.emit_kind': kind,
      'llmnb.emit_content': content
    }),
    status: { code: 'STATUS_CODE_UNSET', message: '' }
  };
}

suite('contract: agent_emit renderer (RFC-005)', () => {
  let renderer: ReturnType<RendererModule['activate']> | undefined;

  suiteSetup(async function (): Promise<void> {
    if (!fs.existsSync(RENDERER_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-emit-renderer.test] ${RENDERER_BUNDLE} missing — run \`npm run package:renderer\` first; skipping`
      );
      this.skip();
      return;
    }
    const mod = (await import(url.pathToFileURL(RENDERER_BUNDLE).href)) as RendererModule;
    renderer = mod.activate({});
  });

  for (const { kind, marker } of KINDS) {
    test(`emit_kind="${kind}" renders the header marker and the data attribute`, () => {
      assert.ok(renderer);
      const el = makeStubElement() as unknown as HTMLElement;
      renderer!.renderOutputItem(makeStubItem(agentEmitSpan(kind)), el);
      assert.ok(el.innerHTML.length > 0, 'innerHTML must be non-empty');
      assert.ok(
        el.innerHTML.includes(`data-emit-kind="${kind}"`),
        `expected data-emit-kind="${kind}" in ${el.innerHTML}`
      );
      assert.ok(
        el.innerHTML.includes(marker),
        `expected ${marker} header marker in ${el.innerHTML}`
      );
    });
  }

  test('agent_id appears in the header', () => {
    assert.ok(renderer);
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(agentEmitSpan('prose')), el);
    assert.ok(
      el.innerHTML.includes('agent: alpha'),
      `expected "agent: alpha" in ${el.innerHTML}`
    );
  });

  test('long emit_content is truncated in the preview but fully present in the body', () => {
    assert.ok(renderer);
    const long = 'word '.repeat(40); // 200 chars, well past PREVIEW_MAX_CHARS (80)
    const span = agentEmitSpan('prose', long.trim());
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    // Preview ellipsis appears in the header span (truncated to ~80 chars).
    assert.ok(
      el.innerHTML.includes('rts-agent-emit-preview') && el.innerHTML.includes('…'),
      `expected truncated preview in ${el.innerHTML}`
    );
    // The full content lives in the body's <pre>.
    assert.ok(
      el.innerHTML.includes(long.trim()),
      `expected the full content to appear in the body`
    );
  });

  test('body is collapsed by default (hidden attribute on body)', () => {
    assert.ok(renderer);
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(agentEmitSpan('reasoning')), el);
    // Hidden attribute is the collapsed default per RFC-005 visual policy.
    assert.ok(
      /class="rts-agent-emit-body"[^>]*hidden/.test(el.innerHTML),
      `expected hidden body in ${el.innerHTML}`
    );
  });

  test('parser_diagnostic appears under the content when present', () => {
    assert.ok(renderer);
    const span: OtlpSpan = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'agent_emit:malformed_json',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1745588938302000000',
      endTimeUnixNano: null,
      attributes: encodeAttrs({
        'llmnb.run_type': 'agent_emit',
        'llmnb.agent_id': 'alpha',
        'llmnb.emit_kind': 'malformed_json',
        'llmnb.emit_content': '{not json',
        'llmnb.parser_diagnostic': 'unexpected end-of-input at position 142'
      }),
      status: { code: 'STATUS_CODE_UNSET', message: '' }
    };
    const el = makeStubElement() as unknown as HTMLElement;
    renderer!.renderOutputItem(makeStubItem(span), el);
    assert.ok(
      el.innerHTML.includes('rts-agent-emit-diagnostic') &&
        el.innerHTML.includes('unexpected end-of-input at position 142'),
      `expected parser_diagnostic to appear: ${el.innerHTML}`
    );
  });

  test('renderer does not throw on agent_emit spans with missing attributes', () => {
    assert.ok(renderer);
    const span: OtlpSpan = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'agent_emit:prose',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1745588938302000000',
      endTimeUnixNano: null,
      attributes: encodeAttrs({
        'llmnb.run_type': 'agent_emit'
        // emit_kind / agent_id / emit_content all missing.
      }),
      status: { code: 'STATUS_CODE_UNSET', message: '' }
    };
    const el = makeStubElement() as unknown as HTMLElement;
    assert.doesNotThrow(() => renderer!.renderOutputItem(makeStubItem(span), el));
    // Falls back to "unknown" emit_kind.
    assert.ok(el.innerHTML.includes('data-emit-kind="unknown"'));
  });
});
