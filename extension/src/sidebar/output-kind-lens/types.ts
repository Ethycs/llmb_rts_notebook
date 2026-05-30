// V2 Output-kind lens UI — shared types.
//
// The 12 V1-normative output kinds are pinned in
// `docs/atoms/concepts/output-kind.md` §"The 12 values". V2 ships the
// lens UI consuming the tag stream that V1 already emits on
// `agent_emit` spans (OTLP attribute `llmnb.output.kind`).

/** The 12 V1-normative output kinds. Forward-compat: receivers seeing
 *  an unknown string MUST tolerate it as untyped (per the atom). The
 *  lens groups unknown values under a synthetic `<other>` bucket. */
export type OutputKind =
  | 'prose'
  | 'code'
  | 'diff'
  | 'patch'
  | 'decision'
  | 'plan'
  | 'artifact_ref'
  | 'test_result'
  | 'diagnostic'
  | 'checkpoint'
  | 'question'
  | 'warning';

/** Canonical iteration order (decision / question / warning first so
 *  high-attention kinds appear at the top of the lens; reference /
 *  artifact kinds last). */
export const OUTPUT_KIND_ORDER: ReadonlyArray<OutputKind> = [
  'decision',
  'question',
  'warning',
  'diagnostic',
  'plan',
  'patch',
  'diff',
  'test_result',
  'checkpoint',
  'code',
  'prose',
  'artifact_ref'
];

/** Synthetic kind for spans whose `llmnb.output.kind` value isn't one
 *  of the 12 V1-normative values (forward-compat per atom invariant). */
export const OTHER_KIND_KEY = '<other>';

/** One tagged span extracted from a cell's outputs. The `snippet` is a
 *  short preview derived from `llmnb.emit_content` (if present) or the
 *  span `name`; the lens uses it to disambiguate matches in the list. */
export interface TaggedSpan {
  cellIndex: number;
  /** Canonical cell id for the click-to-reveal command. */
  cellId: string;
  spanId: string;
  /** One of the 12 normative values, or `<other>` for forward-compat. */
  outputKind: OutputKind | typeof OTHER_KIND_KEY;
  /** Optional — the emitting agent id from `llmnb.agent_id` if present. */
  agentId?: string;
  /** Short preview of the span's content. Truncated to ~80 chars. */
  snippet: string;
  /** ms-since-epoch from `startTimeUnixNano`; 0 if unparseable. */
  timestampMs: number;
}

// ----------------------------------------------------------------------
// Lens TreeDataProvider node union
// ----------------------------------------------------------------------

export type LensNode =
  | { kind: 'empty'; message: string }
  | {
      kind: 'kind-group';
      outputKind: OutputKind | typeof OTHER_KIND_KEY;
      count: number;
    }
  | {
      kind: 'tagged-span';
      span: TaggedSpan;
    };

/** Minimum snippet length emitted by the extractor. Shorter strings
 *  are kept verbatim. */
export const SNIPPET_MAX_CHARS = 80;

/** Convenience guard — `true` iff `value` is one of the 12 V1-normative
 *  output kinds. Used by the extractor to bucket unknown values into
 *  the `<other>` group. */
export function isKnownOutputKind(value: string): value is OutputKind {
  switch (value) {
    case 'prose':
    case 'code':
    case 'diff':
    case 'patch':
    case 'decision':
    case 'plan':
    case 'artifact_ref':
    case 'test_result':
    case 'diagnostic':
    case 'checkpoint':
    case 'question':
    case 'warning':
      return true;
    default:
      return false;
  }
}

/** Convenience count for the 12 V1-normative kinds. */
export const KNOWN_OUTPUT_KIND_COUNT = 12;
