// OTLP/JSON span shapes + attribute encoding helpers.
//
// Refactor R1-X switched the run-record wire shape from LangSmith canonical
// to strict OTLP/JSON. The OTLP encoding is a tagged-union AnyValue list, not
// a flat object. Per the OTLP/JSON spec:
//
//   - 64-bit integer values (intValue) and Unix-nanos timestamps are encoded
//     as JSON STRINGS — number precision is otherwise lost in browser JSON
//     parsers.
//   - `attributes` is a list of `{key, value}` pairs where `value` is an
//     AnyValue (one of stringValue, intValue, doubleValue, boolValue,
//     arrayValue, kvlistValue, bytesValue).
//
// References:
//   https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
//   https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto
//   OpenInference semconv: input.value/output.value/input.mime_type/output.mime_type
//   Domain attrs (this project): llmnb.run_type, llmnb.agent_id,
//     llmnb.zone_id, llmnb.cell_id, llmnb.tags, llmnb.tool_name.

/** OTLP/JSON AnyValue tagged union. Exactly one of the keys is set. */
export interface OtlpAnyValue {
  stringValue?: string;
  /** JSON-string-encoded 64-bit signed integer. */
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpAttribute[] };
  /** Base64-encoded bytes; rarely used here, included for completeness. */
  bytesValue?: string;
}

/** OTLP/JSON attribute = single key + AnyValue. */
export interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

/** OTLP/JSON Span Status. */
export type OtlpStatusCode =
  | 'STATUS_CODE_UNSET'
  | 'STATUS_CODE_OK'
  | 'STATUS_CODE_ERROR';

export interface OtlpStatus {
  code: OtlpStatusCode;
  message: string;
}

/** OTLP/JSON SpanKind. R1-X always emits SPAN_KIND_INTERNAL. */
export type OtlpSpanKind =
  | 'SPAN_KIND_UNSPECIFIED'
  | 'SPAN_KIND_INTERNAL'
  | 'SPAN_KIND_SERVER'
  | 'SPAN_KIND_CLIENT'
  | 'SPAN_KIND_PRODUCER'
  | 'SPAN_KIND_CONSUMER';

/** OTLP/JSON Span event = `{timeUnixNano, name, attributes}`. */
export interface OtlpSpanEvent {
  /** Unix-nanos as a JSON string. */
  timeUnixNano: string;
  name: string;
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
}

/** OTLP/JSON Span link = `{traceId, spanId, attributes}`. */
export interface OtlpSpanLink {
  traceId: string;
  spanId: string;
  attributes?: OtlpAttribute[];
  droppedAttributesCount?: number;
}

/** OTLP/JSON Span. R1-X uses this as the run-record payload shape inside
 *  RFC-003 envelopes (run.start / run.event / run.complete).
 *
 *  In-progress spans (run.start, before run.complete) carry
 *  `endTimeUnixNano: null` and `status.code: "STATUS_CODE_UNSET"`. */
export interface OtlpSpan {
  /** 32 lowercase hex chars (16 bytes). */
  traceId: string;
  /** 16 lowercase hex chars (8 bytes). */
  spanId: string;
  /** 16 lowercase hex chars; empty string for root spans. */
  parentSpanId?: string;
  name: string;
  kind: OtlpSpanKind;
  /** Unix-nanos as JSON string. */
  startTimeUnixNano: string;
  /** Unix-nanos as JSON string; null while the run is in progress. */
  endTimeUnixNano: string | null;
  attributes: OtlpAttribute[];
  events?: OtlpSpanEvent[];
  links?: OtlpSpanLink[];
  status: OtlpStatus;
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  droppedLinksCount?: number;
  /** Optional trace state propagation. */
  traceState?: string;
}

// --- Attribute encode/decode ---------------------------------------------

/** Encode a JS value as an OTLP/JSON AnyValue.
 *
 *  Coercion rules:
 *   - string → stringValue
 *   - boolean → boolValue
 *   - integer number (Number.isInteger) → intValue (stringified)
 *   - non-integer number → doubleValue
 *   - bigint → intValue (stringified)
 *   - array → arrayValue (each element recursively encoded)
 *   - plain object → kvlistValue
 *   - null/undefined → stringValue:""
 */
export function encodeAnyValue(v: unknown): OtlpAnyValue {
  if (v === null || v === undefined) {
    return { stringValue: '' };
  }
  if (typeof v === 'string') {
    return { stringValue: v };
  }
  if (typeof v === 'boolean') {
    return { boolValue: v };
  }
  if (typeof v === 'number') {
    if (Number.isFinite(v) && Number.isInteger(v)) {
      return { intValue: String(v) };
    }
    return { doubleValue: v };
  }
  if (typeof v === 'bigint') {
    return { intValue: v.toString() };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((x) => encodeAnyValue(x)) } };
  }
  if (typeof v === 'object') {
    const values: OtlpAttribute[] = [];
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      values.push({ key: k, value: encodeAnyValue(vv) });
    }
    return { kvlistValue: { values } };
  }
  // Function / symbol / unhandled: stringify as a fallback.
  return { stringValue: String(v) };
}

/** Decode an OTLP/JSON AnyValue back into a plain JS value. Inverse of
 *  `encodeAnyValue` for all values it produces. intValue strings stay as
 *  strings unless they fit in Number.MAX_SAFE_INTEGER, in which case they
 *  are parsed (matching common consumer expectations). */
export function decodeAnyValue(v: OtlpAnyValue | undefined): unknown {
  if (!v) {
    return undefined;
  }
  if (v.stringValue !== undefined) {
    return v.stringValue;
  }
  if (v.boolValue !== undefined) {
    return v.boolValue;
  }
  if (v.intValue !== undefined) {
    // Preserve precision for >53-bit values by keeping the string form.
    const n = Number(v.intValue);
    if (
      Number.isSafeInteger(n) &&
      String(n) === v.intValue
    ) {
      return n;
    }
    return v.intValue;
  }
  if (v.doubleValue !== undefined) {
    return v.doubleValue;
  }
  if (v.arrayValue) {
    return v.arrayValue.values.map((x) => decodeAnyValue(x));
  }
  if (v.kvlistValue) {
    return decodeAttrs(v.kvlistValue.values);
  }
  if (v.bytesValue !== undefined) {
    return v.bytesValue;
  }
  return undefined;
}

/** Encode a flat record into the OTLP/JSON `attributes` list shape. */
export function encodeAttrs(record: Record<string, unknown>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [k, v] of Object.entries(record)) {
    out.push({ key: k, value: encodeAnyValue(v) });
  }
  return out;
}

/** Decode an OTLP/JSON `attributes` list into a flat record. Last-wins on
 *  duplicate keys, matching the OTLP/JSON consumer convention. */
export function decodeAttrs(list: OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!list) {
    return out;
  }
  for (const attr of list) {
    out[attr.key] = decodeAnyValue(attr.value);
  }
  return out;
}

/** Convenience: read a single attribute value by key (last-wins). */
export function getAttr(list: OtlpAttribute[] | undefined, key: string): unknown {
  if (!list) {
    return undefined;
  }
  // Iterate in reverse so last-wins is O(1) on the matching item.
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].key === key) {
      return decodeAnyValue(list[i].value);
    }
  }
  return undefined;
}

/** Convenience: read a string attribute value by key, with fallback. */
export function getStringAttr(
  list: OtlpAttribute[] | undefined,
  key: string,
  fallback = ''
): string {
  const v = getAttr(list, key);
  return typeof v === 'string' ? v : fallback;
}
