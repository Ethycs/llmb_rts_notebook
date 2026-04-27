// Metadata loader — extension-side hydrate path (RFC-006 §8 v2.0.2).
//
// When the operator opens a `.llmnb` file with persisted state, the extension
// extracts `metadata.rts` and ships a `notebook.metadata` envelope with
// `mode: "hydrate"` outbound. The kernel applies the snapshot, runs drift
// detection, respawns agents from `config.recoverable.agents[]`, and replies
// with `mode: "snapshot"` + `trigger: "hydrate_complete"` carrying the post-
// hydrate state. The loader subscribes to that confirmation and clears its
// pending-hydrate watchdog when it arrives.
//
// Validation rules:
//   - RFC-005 §"Top-level structure" — `schema_version` major MUST equal "1".
//     Mismatch: log + skip + surface a banner ("incompatible file format").
//   - Forbidden-secret scan: walk `metadata.rts.config` for any field whose
//     name (case-insensitive) matches the forbidden list. Detection refuses
//     the ship and surfaces a banner.
//   - `metadata.rts` absent (new empty notebook) → no hydrate envelope.
//   - Confirmation timeout (>10s per RFC-006 §8) → surface "kernel failed to
//     hydrate" warning, mark pending complete (no auto-retry in V1).
//
// The loader is wired in extension.ts on the `onDidOpenNotebookDocument`
// VS Code lifecycle hook. The PtyKernelClient must already be `start()`ed
// when the hook fires — the activation glue ensures this by eagerly starting
// the client before notebook documents are opened.

import * as vscode from 'vscode';
import {
  RtsV2Envelope,
  NotebookMetadataPayload,
  RtsMetadataSnapshot,
  RFC005_SCHEMA_MAJOR
} from '../messaging/types.js';
import type { MessageRouter } from '../messaging/router.js';

/** Match RFC-006 §8 v2.0.2 — confirmation must arrive within this window. */
export const HYDRATE_CONFIRMATION_TIMEOUT_MS = 10_000;

/** Forbidden-secret field-name patterns (case-insensitive). Walking
 *  `metadata.rts.config` and matching against any of these refuses the
 *  hydrate ship.
 *
 *  Patterns are simple suffix / exact / containment rules — secret hygiene
 *  is policy-driven, not best-effort regex. The list mirrors the grep target
 *  from the engineering guide §9.3 and the RFC-005 fault table. */
const FORBIDDEN_FIELD_PATTERNS: ReadonlyArray<{
  /** True iff `field_name.toLowerCase()` matches the rule. */
  match(name: string): boolean;
  description: string;
}> = [
  // Suffixes
  { match: (n) => n.endsWith('_key'), description: '*_key' },
  { match: (n) => n.endsWith('_token'), description: '*_token' },
  { match: (n) => n.endsWith('_password'), description: '*_password' },
  { match: (n) => n.endsWith('_secret'), description: '*_secret' },
  // Common API key field name
  { match: (n) => n === 'api_key', description: 'api_key' },
  // Headers / standalone names
  { match: (n) => n === 'authorization', description: 'authorization' },
  { match: (n) => n === 'bearer', description: 'bearer' },
  { match: (n) => n === 'cookie', description: 'cookie' }
];

/** A single matched field path during the secret scan. */
export interface ForbiddenSecretMatch {
  /** Dot-/bracket-joined JSON path into `metadata.rts.config`. */
  path: string;
  /** The forbidden-pattern description that matched. */
  pattern: string;
}

/** Ship-result classification for tests + ops surfaces. */
export type HydrateLoadOutcome =
  | 'shipped'
  | 'skipped_no_metadata'
  | 'rejected_schema_mismatch'
  | 'rejected_forbidden_secret'
  | 'no_router';

export interface HydrateLoadResult {
  outcome: HydrateLoadOutcome;
  /** Populated for `rejected_forbidden_secret`; useful for the banner copy. */
  forbidden_matches?: ForbiddenSecretMatch[];
  /** Populated for `rejected_schema_mismatch`. */
  observed_schema_major?: string;
}

/** Optional logger / banner surfaces. The activation glue passes a
 *  `vscode.LogOutputChannel` and a no-op banner in tests. */
export interface MetadataLoaderEnv {
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void };
  /** Surfaces a banner / modal to the operator. Tests pass a recorder. */
  showWarning?: (message: string) => void;
}

/** MetadataLoader — observes notebook open + snapshot confirmations. */
export class MetadataLoader implements vscode.Disposable {
  /** Tracks pending hydrate-confirmation watchdogs keyed by notebook URI. */
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly router: MessageRouter | undefined,
    private readonly env: MetadataLoaderEnv,
    private readonly notebookType: string
  ) {
    if (this.router) {
      // Subscribe to inbound `notebook.metadata` envelopes so we can detect
      // the kernel's hydrate-complete confirmation. The applier also subscribes
      // (it applies snapshots to the open notebook); both consumers run.
      this.disposables.push(
        this.router.registerMetadataObserver({
          onNotebookMetadata: (payload) => this.handleConfirmation(payload)
        })
      );
    }
  }

  public dispose(): void {
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    this.pending.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  /** Hook for `vscode.workspace.onDidOpenNotebookDocument`. The activation
   *  glue calls this for every opened notebook; non-`.llmnb` documents are
   *  ignored at the boundary. Returns the load outcome for testability. */
  public async onDidOpenNotebook(
    nb: vscode.NotebookDocument
  ): Promise<HydrateLoadResult> {
    if (nb.notebookType !== this.notebookType) {
      return { outcome: 'skipped_no_metadata' };
    }
    return this.shipHydrate(nb);
  }

  /** Test-only entry point: ship a hydrate envelope built from the supplied
   *  document. Production code goes through `onDidOpenNotebook`. */
  public async shipHydrate(nb: vscode.NotebookDocument): Promise<HydrateLoadResult> {
    const meta = (nb.metadata ?? {}) as Record<string, unknown>;
    const rts = meta['rts'] as RtsMetadataSnapshot | undefined;

    // RFC-006 §8: only ship for files that have persisted state. New / empty
    // notebooks (no `metadata.rts`) skip silently.
    if (!rts || typeof rts !== 'object') {
      this.env.logger.info(
        `[metadata-loader] no metadata.rts on ${nb.uri.toString()}; skipping hydrate`
      );
      return { outcome: 'skipped_no_metadata' };
    }

    // RFC-005 §"Top-level structure" — schema_version major MUST equal "1".
    const observedMajor = String(rts.schema_version ?? '').split('.')[0];
    if (observedMajor !== RFC005_SCHEMA_MAJOR) {
      this.env.logger.error(
        `[metadata-loader] schema_version major mismatch: expected="${RFC005_SCHEMA_MAJOR}" observed="${observedMajor}" full="${rts.schema_version}"`
      );
      this.env.showWarning?.(
        `LLMNB: cannot resume "${nb.uri.toString()}" — incompatible file format ` +
          `(schema_version=${rts.schema_version}; this build expects major ${RFC005_SCHEMA_MAJOR})`
      );
      return { outcome: 'rejected_schema_mismatch', observed_schema_major: observedMajor };
    }

    // Forbidden-secret scan — refuse to ship if any forbidden field name is
    // present anywhere under `metadata.rts.config`. The check is defensive:
    // RFC-005 §"config" already forbids these fields at the schema level, but
    // a hand-edited `.llmnb` could carry them.
    const forbidden = scanForbiddenSecrets(
      (rts.config as Record<string, unknown> | undefined) ?? {},
      'metadata.rts.config'
    );
    if (forbidden.length > 0) {
      this.env.logger.error(
        `[metadata-loader] refusing hydrate: forbidden secret field(s) detected: ${forbidden
          .map((f) => f.path)
          .join(', ')}`
      );
      this.env.showWarning?.(
        `LLMNB: refusing to load "${nb.uri.toString()}" — file contains forbidden ` +
          `secret-shaped fields under metadata.rts.config (${forbidden.length} match${
            forbidden.length === 1 ? '' : 'es'
          }). Remove them and reopen.`
      );
      return { outcome: 'rejected_forbidden_secret', forbidden_matches: forbidden };
    }

    if (!this.router) {
      this.env.logger.warn(
        `[metadata-loader] no router available; skipping hydrate ship for ${nb.uri.toString()}`
      );
      return { outcome: 'no_router' };
    }

    const persistedVersion = readPersistedVersion(rts);
    const envelope: RtsV2Envelope<NotebookMetadataPayload> = {
      type: 'notebook.metadata',
      payload: {
        mode: 'hydrate',
        snapshot_version: persistedVersion,
        snapshot: rts,
        trigger: 'open'
      }
    };

    this.env.logger.info(
      `[metadata-loader] shipping hydrate envelope (uri=${nb.uri.toString()} v=${persistedVersion})`
    );
    this.router.enqueueOutbound(envelope);

    // Arm the hydrate-confirmation watchdog. RFC-006 §8: confirmation must
    // arrive within 10s; on timeout, surface a warning. Stored per-URI so
    // multiple notebook opens don't trample one another.
    const key = nb.uri.toString();
    const prev = this.pending.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.env.logger.warn(
        `[metadata-loader] hydrate confirmation timed out for ${key} (>${HYDRATE_CONFIRMATION_TIMEOUT_MS}ms)`
      );
      this.env.showWarning?.(
        `LLMNB: kernel failed to hydrate "${key}" within ${HYDRATE_CONFIRMATION_TIMEOUT_MS / 1000}s. ` +
          `Agents from config.recoverable.agents[] may not have respawned. Restart kernel to retry.`
      );
    }, HYDRATE_CONFIRMATION_TIMEOUT_MS);
    // Don't keep node alive solely on this timer (CI / smokes).
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pending.set(key, timer);
    return { outcome: 'shipped' };
  }

  /** Test accessor: number of pending hydrate confirmations. */
  public getPendingCount(): number {
    return this.pending.size;
  }

  /** Test accessor: clear any specific URI's pending watchdog (used in
   *  tests where a stub kernel never replies). */
  public clearPendingFor(uri: string): boolean {
    const t = this.pending.get(uri);
    if (t) {
      clearTimeout(t);
      this.pending.delete(uri);
      return true;
    }
    return false;
  }

  /** Inbound `notebook.metadata` consumer — clears the watchdog on the
   *  hydrate-complete confirmation. The applier handles the actual snapshot
   *  application; this consumer's job is only watchdog cancellation. */
  private handleConfirmation(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot') {
      return;
    }
    if (payload.trigger !== 'hydrate_complete') {
      return;
    }
    // Confirmation isn't URI-tagged in v2.0.2; V1 supports a single attached
    // notebook per kernel session, so clearing all pending entries is safe.
    if (this.pending.size > 0) {
      for (const [uri, t] of this.pending) {
        clearTimeout(t);
        this.env.logger.info(
          `[metadata-loader] hydrate confirmed for ${uri} (snapshot_version=${payload.snapshot_version})`
        );
      }
      this.pending.clear();
    }
  }
}

/** Walk a config subtree and return every field name that matches a
 *  forbidden-secret pattern. Field-name matching is case-insensitive. The
 *  scan recurses into nested objects and arrays so deeply-nested secrets
 *  surface. */
export function scanForbiddenSecrets(
  node: unknown,
  path: string
): ForbiddenSecretMatch[] {
  const out: ForbiddenSecretMatch[] = [];
  if (!node || typeof node !== 'object') {
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      out.push(...scanForbiddenSecrets(v, `${path}[${i}]`));
    });
    return out;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const lowered = k.toLowerCase();
    for (const rule of FORBIDDEN_FIELD_PATTERNS) {
      if (rule.match(lowered)) {
        out.push({ path: `${path}.${k}`, pattern: rule.description });
        break;
      }
    }
    if (v && typeof v === 'object') {
      out.push(...scanForbiddenSecrets(v, `${path}.${k}`));
    }
  }
  return out;
}

/** Pull the persisted snapshot_version from the metadata blob. RFC-006 §8:
 *  this is the version that was last persisted before close; the kernel
 *  resumes its counter from `version + 1`. */
function readPersistedVersion(rts: RtsMetadataSnapshot): number {
  const v = (rts as { snapshot_version?: unknown }).snapshot_version;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  return 0;
}
