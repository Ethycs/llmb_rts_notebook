// V2 Output-kind lens — pure span extractor.
//
// Walks a notebook's cell outputs, decodes each
// `application/vnd.rts.run+json` item as an OTLP span (or list of
// spans), and returns the subset that carry an `llmnb.output.kind`
// attribute. Output ordering preserves notebook + span order so the
// lens renders the operator's chronological narrative as-is.

import * as vscode from 'vscode';
import { decodeAttrs, getStringAttr } from '../../otel/attrs.js';
import type { OtlpSpan } from '../../otel/attrs.js';
import { candidateCellIds } from '../../notebook/contamination-badge.js';
import {
  OTHER_KIND_KEY,
  SNIPPET_MAX_CHARS,
  isKnownOutputKind,
  type OutputKind,
  type TaggedSpan
} from './types.js';

/** MIME for run-output items carrying OTLP spans (mirrors the existing
 *  RTS_RUN_MIME constant in controller.ts / cell-badge.ts). */
const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** Top-level: walk all cells in `notebook` and return every tagged span. */
export function extractTaggedSpans(
  notebook: vscode.NotebookDocument | undefined
): TaggedSpan[] {
  if (!notebook) return [];
  const out: TaggedSpan[] = [];
  const cells = notebook.getCells();
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.kind === vscode.NotebookCellKind.Markup) continue;
    const cellId = primaryCellId(cell);
    for (const item of iterateRunItems(cell)) {
      for (const span of iterateSpans(item)) {
        const tagged = toTaggedSpan(i, cellId, span);
        if (tagged) out.push(tagged);
      }
    }
  }
  return out;
}

/** Pure helper — given the decoded JSON payload from one
 *  `application/vnd.rts.run+json` item, yield the OTLP spans inside.
 *  Tolerates the single-span shape (the V1 wire — one OTLP span per
 *  output item) AND the future bundled-batch shape (`{spans: [...]}`
 *  or array). */
export function* iterateSpans(payload: unknown): IterableIterator<OtlpSpan> {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const v of payload) yield* iterateSpans(v);
    return;
  }
  const obj = payload as Record<string, unknown>;
  // The V1 single-span shape carries `traceId` + `spanId` at the
  // top level. Treat that as a span.
  if (typeof obj.traceId === 'string' && typeof obj.spanId === 'string') {
    yield obj as unknown as OtlpSpan;
    return;
  }
  // Bundled shape: `{spans: [...]}` or `{scopeSpans: [...]}`.
  if (Array.isArray(obj.spans)) {
    for (const v of obj.spans) yield* iterateSpans(v);
    return;
  }
  if (Array.isArray(obj.scopeSpans)) {
    for (const ss of obj.scopeSpans) yield* iterateSpans(ss);
    return;
  }
}

/** Pure: take one OTLP span + the cell coordinates and return a
 *  `TaggedSpan` if the span carries `llmnb.output.kind`, else
 *  undefined. Forward-compat: unknown kind values bucket to
 *  `OTHER_KIND_KEY` so the lens still surfaces them. */
export function toTaggedSpan(
  cellIndex: number,
  cellId: string,
  span: OtlpSpan
): TaggedSpan | undefined {
  if (!span.attributes || !Array.isArray(span.attributes)) return undefined;
  const kindRaw = getStringAttr(span.attributes, 'llmnb.output.kind');
  if (typeof kindRaw !== 'string' || kindRaw.length === 0) return undefined;
  const outputKind: OutputKind | typeof OTHER_KIND_KEY = isKnownOutputKind(kindRaw)
    ? kindRaw
    : OTHER_KIND_KEY;
  const agentId = getStringAttr(span.attributes, 'llmnb.agent_id') ?? undefined;
  const snippet = buildSnippet(span);
  const timestampMs = parseNanos(span.startTimeUnixNano);
  return {
    cellIndex,
    cellId,
    spanId: span.spanId,
    outputKind,
    agentId,
    snippet,
    timestampMs
  };
}

/** Snippet source priority: `llmnb.emit_content` (the agent's prose /
 *  reasoning body) → span `name` → `<span:<spanId-short>>`. Compresses
 *  whitespace and truncates to SNIPPET_MAX_CHARS. */
export function buildSnippet(span: OtlpSpan): string {
  const emit = getStringAttr(span.attributes, 'llmnb.emit_content');
  const raw =
    typeof emit === 'string' && emit.length > 0
      ? emit
      : typeof span.name === 'string' && span.name.length > 0
      ? span.name
      : `<span:${span.spanId.slice(0, 8)}>`;
  const compressed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return compressed.length > SNIPPET_MAX_CHARS
    ? compressed.slice(0, SNIPPET_MAX_CHARS - 1) + '…'
    : compressed;
}

/** Group a flat span list by `outputKind`, preserving each bucket's
 *  notebook-order. Used by the tree provider to render top-level
 *  `kind-group` rows + their child `tagged-span` rows. */
export function groupByKind(
  spans: ReadonlyArray<TaggedSpan>
): Map<OutputKind | typeof OTHER_KIND_KEY, TaggedSpan[]> {
  const out = new Map<OutputKind | typeof OTHER_KIND_KEY, TaggedSpan[]>();
  for (const s of spans) {
    const bucket = out.get(s.outputKind);
    if (bucket) {
      bucket.push(s);
    } else {
      out.set(s.outputKind, [s]);
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------

/** Yield each `application/vnd.rts.run+json` item from a cell's
 *  outputs as a decoded JSON payload (or undefined if the item can't
 *  be parsed). */
function* iterateRunItems(
  cell: vscode.NotebookCell
): IterableIterator<unknown> {
  for (const out of cell.outputs) {
    for (const item of out.items) {
      if (item.mime !== RTS_RUN_MIME) continue;
      const raw = decodeUtf8(item.data);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      yield parsed;
    }
  }
}

function decodeUtf8(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch {
    return '';
  }
}

/** Convert a span's `startTimeUnixNano` (string, OTLP/JSON format) to
 *  ms-since-epoch. Returns 0 on missing / unparseable input. */
function parseNanos(nanos: string | null | undefined): number {
  if (typeof nanos !== 'string' || nanos.length === 0) return 0;
  // Nanos overflow Number precision; slice off the last 6 digits to
  // get ms. Defensive on non-numeric strings.
  if (!/^\d+$/.test(nanos)) {
    const fallback = Date.parse(nanos);
    return Number.isFinite(fallback) ? fallback : 0;
  }
  if (nanos.length <= 6) return 0;
  const msPart = nanos.slice(0, nanos.length - 6);
  const ms = Number(msPart);
  return Number.isFinite(ms) ? ms : 0;
}

function primaryCellId(cell: vscode.NotebookCell): string {
  return candidateCellIds(cell)[0];
}

// `decodeAttrs` is re-exported for tests that want to inspect the
// decoded attribute map without re-implementing the OTLP walker.
export { decodeAttrs };
