// V2 Output-kind lens — pure-unit tests for the span extractor.

import * as assert from 'node:assert/strict';
import {
  buildSnippet,
  extractTaggedSpans,
  groupByKind,
  iterateSpans,
  toTaggedSpan
} from '../../src/sidebar/output-kind-lens/extractor.js';
import {
  OTHER_KIND_KEY,
  OUTPUT_KIND_ORDER,
  isKnownOutputKind
} from '../../src/sidebar/output-kind-lens/types.js';
import { encodeAttrs } from '../../src/otel/attrs.js';

function makeSpan(opts: {
  spanId?: string;
  name?: string;
  startNanos?: string;
  attrs?: Record<string, unknown>;
}): {
  traceId: string;
  spanId: string;
  name: string;
  kind: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: ReturnType<typeof encodeAttrs>;
  status: { code: string; message: string };
} {
  return {
    traceId: '00000000000000000000000000000001',
    spanId: opts.spanId ?? '0000000000000001',
    name: opts.name ?? 'agent_emit:reasoning',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: opts.startNanos ?? '1747657200000000000',
    endTimeUnixNano: '1747657200500000000',
    attributes: encodeAttrs(opts.attrs ?? {}),
    status: { code: 'STATUS_CODE_OK', message: '' }
  };
}

suite('contract: V2 output-kind lens extractor', () => {
  test('toTaggedSpan returns undefined when llmnb.output.kind is missing', () => {
    const span = makeSpan({ attrs: { 'llmnb.agent_id': 'alpha' } });
    assert.equal(toTaggedSpan(0, 'cell:1', span as never), undefined);
  });

  test('toTaggedSpan extracts a normative kind verbatim', () => {
    const span = makeSpan({
      attrs: {
        'llmnb.output.kind': 'decision',
        'llmnb.agent_id': 'alpha',
        'llmnb.emit_content': 'Decided to refactor metrics into a sub-package.'
      }
    });
    const tagged = toTaggedSpan(2, 'cell:3', span as never);
    assert.ok(tagged);
    assert.equal(tagged!.cellIndex, 2);
    assert.equal(tagged!.cellId, 'cell:3');
    assert.equal(tagged!.outputKind, 'decision');
    assert.equal(tagged!.agentId, 'alpha');
    assert.ok(tagged!.snippet.startsWith('Decided to refactor'));
  });

  test('unknown output kinds bucket into the <other> key (forward-compat)', () => {
    const span = makeSpan({
      attrs: {
        'llmnb.output.kind': 'future-value',
        'llmnb.emit_content': 'forward-compat payload'
      }
    });
    const tagged = toTaggedSpan(0, 'cell:1', span as never);
    assert.ok(tagged);
    assert.equal(tagged!.outputKind, OTHER_KIND_KEY);
  });

  test('buildSnippet falls back to span name when emit_content is absent', () => {
    const span = makeSpan({
      name: 'agent_emit:warning',
      attrs: { 'llmnb.output.kind': 'warning' }
    });
    assert.equal(buildSnippet(span as never), 'agent_emit:warning');
  });

  test('buildSnippet truncates long emit content to ~80 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const span = makeSpan({
      attrs: {
        'llmnb.output.kind': 'prose',
        'llmnb.emit_content': long
      }
    });
    const snippet = buildSnippet(span as never);
    assert.ok(snippet.length <= 80);
    assert.ok(snippet.endsWith('…'));
  });

  test('iterateSpans yields a single-span payload (V1 wire)', () => {
    const span = makeSpan({ attrs: { 'llmnb.output.kind': 'decision' } });
    const yielded = Array.from(iterateSpans(span));
    assert.equal(yielded.length, 1);
    assert.equal(yielded[0].spanId, span.spanId);
  });

  test('iterateSpans yields a bundled-batch payload ({spans: [...]})', () => {
    const bundle = {
      spans: [
        makeSpan({ spanId: '0000000000000001', attrs: { 'llmnb.output.kind': 'plan' } }),
        makeSpan({ spanId: '0000000000000002', attrs: { 'llmnb.output.kind': 'decision' } })
      ]
    };
    const yielded = Array.from(iterateSpans(bundle));
    assert.equal(yielded.length, 2);
  });

  test('iterateSpans is permissive on malformed input', () => {
    assert.deepEqual(Array.from(iterateSpans(undefined)), []);
    assert.deepEqual(Array.from(iterateSpans(null)), []);
    assert.deepEqual(Array.from(iterateSpans('not-a-span')), []);
    assert.deepEqual(Array.from(iterateSpans({})), []);
  });

  test('groupByKind preserves insertion order within each bucket', () => {
    const a = { outputKind: 'decision', cellIndex: 0 } as never;
    const b = { outputKind: 'decision', cellIndex: 1 } as never;
    const c = { outputKind: 'plan', cellIndex: 2 } as never;
    const groups = groupByKind([a, b, c]);
    const decisions = groups.get('decision')!;
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].cellIndex, 0);
    assert.equal(decisions[1].cellIndex, 1);
    assert.equal(groups.get('plan')!.length, 1);
  });

  test('isKnownOutputKind discriminates all 12 V1-normative values', () => {
    for (const k of OUTPUT_KIND_ORDER) {
      assert.equal(isKnownOutputKind(k), true);
    }
    assert.equal(isKnownOutputKind('unknown'), false);
    assert.equal(isKnownOutputKind(''), false);
  });

  test('OUTPUT_KIND_ORDER has the 12 normative kinds', () => {
    assert.equal(OUTPUT_KIND_ORDER.length, 12);
    // High-attention kinds (decision/question/warning) come first.
    assert.equal(OUTPUT_KIND_ORDER[0], 'decision');
    assert.equal(OUTPUT_KIND_ORDER[1], 'question');
    assert.equal(OUTPUT_KIND_ORDER[2], 'warning');
  });

  test('extractTaggedSpans returns empty list when notebook is undefined', () => {
    assert.deepEqual(extractTaggedSpans(undefined), []);
  });
});
