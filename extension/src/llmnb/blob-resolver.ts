// BlobResolver — resolves `$blob:sha256:...` references against the in-memory
// `metadata.rts.blobs` table.
//
// Per RFC-005 §"metadata.rts.blobs":
//   Any attribute value whose serialized form exceeds `blob_threshold_bytes`
//   (default 64 KiB) is stored as a content-addressed blob. The originating
//   attribute's value is replaced with a `$blob:sha256:<hex>` sentinel; receivers
//   MUST recognize the sentinel and resolve the content from `metadata.rts.blobs`.
//   The hash MUST be the SHA-256 of the original `data` content.
//
// V1 supports text content only (`encoding: "utf-8"`). Binary encodings throw
// (RFC-005 V2 introduces sidecar storage; out of scope here).
//
// The resolver is per-notebook scope: the extension instantiates one resolver
// per opened `.llmnb` and keeps the table in sync with hydrate / snapshot
// metadata updates. Renderers consult the resolver before rendering string
// attributes that may carry blob refs.

// Hash verification uses Node's `crypto` when available (extension host,
// contract tests). The renderer bundle (esbuild, browser target) cannot
// import `node:crypto`; in that environment hash verification is skipped
// and only sentinel-shape + presence checks are performed. Renderer-side
// resolution of corrupt blobs is still safe: the operator-facing content
// surfaces, and the contract suite (Node) catches mismatches.
type HashFn = (input: string) => string;
let _sha256: HashFn | undefined;
function sha256(input: string): string | undefined {
  if (_sha256) {
    return _sha256(input);
  }
  // Node-side: dynamic require keeps the renderer bundle clean.
  if (typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cryptoMod = require('node:crypto') as typeof import('node:crypto');
      _sha256 = (s: string): string =>
        cryptoMod.createHash('sha256').update(s, 'utf-8').digest('hex');
      return _sha256(input);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** RFC-005 §"metadata.rts.blobs" — one entry per content hash. */
export interface BlobEntry {
  content_type: string;
  /** V1: utf-8 only. */
  encoding: string;
  size_bytes: number;
  data: string;
}

/** The `$blob:` sentinel prefix. RFC-005 spec uses `$blob:sha256:<hex>`. */
const BLOB_PREFIX = '$blob:sha256:';

/** Optional minimal logger surface (matches `vscode.LogOutputChannel` subset).
 *  Intentionally permissive so tests can pass a plain object. */
export interface BlobResolverLogger {
  warn(message: string): void;
}

/** Per-notebook blob resolver. Accepts a `metadata.rts.blobs` table on
 *  construction and walks an arbitrary JSON value, replacing any
 *  `$blob:sha256:<hex>` strings with their decoded content from the table.
 *
 *  Recursion semantics:
 *    - String matching `$blob:sha256:<hex>` → resolved content (or placeholder
 *      on miss/mismatch).
 *    - Plain string → returned unchanged.
 *    - Number/boolean/null/undefined → returned unchanged.
 *    - Array → each element recursively resolved; returns a NEW array.
 *    - Plain object → each value recursively resolved; returns a NEW object.
 *
 *  Failure modes (W2/W11 per RFC-006; F-blob class per RFC-005):
 *    - Hash missing from blobs table → log warn, return placeholder string.
 *    - Hash present but `data` SHA-256 mismatches the key → log warn, return
 *      placeholder string.
 *    - `encoding` not in V1's accepted set (`utf-8`) → log warn, return
 *      placeholder string. */
export class BlobResolver {
  public constructor(
    private readonly blobs: Record<string, BlobEntry>,
    private readonly logger?: BlobResolverLogger
  ) {}

  /** Resolve a single value (recursive for objects/arrays). */
  public resolve(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.resolveString(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.resolve(v));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.resolve(v);
      }
      return out;
    }
    return value;
  }

  /** True iff the input is a `$blob:sha256:` sentinel (well-formed prefix). */
  public static isBlobRef(s: unknown): s is string {
    return typeof s === 'string' && s.startsWith(BLOB_PREFIX);
  }

  /** Resolve only a string; non-blob strings are returned unchanged. Public
   *  so renderers can call it on a string attribute without doing the type
   *  guard themselves. */
  public resolveString(value: string): string {
    if (!value.startsWith(BLOB_PREFIX)) {
      return value;
    }
    const fullKey = value.slice('$blob:'.length); // strips just `$blob:`, leaves `sha256:<hex>`
    const entry = this.blobs[fullKey];
    if (!entry) {
      this.logger?.warn(`[blob-resolver] missing blob: ${fullKey}`);
      return `[unresolved blob: ${fullKey}]`;
    }
    if (entry.encoding !== 'utf-8') {
      this.logger?.warn(
        `[blob-resolver] unsupported encoding "${entry.encoding}" for ${fullKey} (V1 supports utf-8 only)`
      );
      return `[unsupported blob encoding: ${entry.encoding}]`;
    }
    const expected = fullKey.slice('sha256:'.length);
    const computed = sha256(entry.data);
    if (computed !== undefined && computed !== expected) {
      this.logger?.warn(
        `[blob-resolver] hash mismatch for ${fullKey}: computed=${computed.slice(0, 16)}...`
      );
      return `[corrupt blob: ${fullKey}]`;
    }
    // computed === undefined: we're in a browser/renderer environment without
    // Node crypto; trust the entry. The extension host already validated when
    // it received the metadata snapshot; renderer-side re-verification is
    // belt-and-braces, not load-bearing.
    return entry.data;
  }
}
