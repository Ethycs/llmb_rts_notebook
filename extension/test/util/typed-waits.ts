// FSP-003 Pillar A — failure-mode-typed wait helpers.
//
// Replaces the opaque `waitFor(predicate, timeoutMs)` pattern from the
// pre-FSP-003 test files. Each helper here awaits one specific phase of
// the extension lifecycle and, on timeout, throws a numbered K-class
// error (K70/K71/K72/K73 per FSP-003 §4) with:
//   - the K code,
//   - the observed state (extension active? kernel ready? diagnostics?),
//   - the deadline that elapsed,
//   - the marker-file tail (last 50 events) via marker-tail.ts.
//
// This converts "predicate did not become true within 5000ms" into
// "K71: kernel.ready never observed; last marker = pty_spawn_args at +1.2s".
//
// Generic spinwait `waitForPredicate` is kept as an escape hatch for
// fixture-internal state (fake module spawn count, captured frames in
// memory) where a phase-typed wait is overkill. Never use it for
// extension-lifecycle assertions.

import type * as vscode from 'vscode';
import {
  DEFAULT_MARKER_TAIL_LINES,
  formatMarkerTail,
  readMarkerTail
} from './marker-tail.js';

// Local re-declaration so the helpers can typecheck against ExtensionApi
// without forcing every consumer to import from extension.ts. Keeping
// this loose-typed avoids a circular type dep through src/.
interface ExtensionApiLike {
  getKernelClient(): { isReady?: boolean } | undefined;
  getActivationDiagnostics?(): {
    activated_at: number | undefined;
    kernel_started_at: number | undefined;
    kernel_ready_at: number | undefined;
    hydrate_count: number;
    last_marker: string | undefined;
  };
  getMetadataLoader?(): { getPendingCount?(): number } | undefined;
}

interface VsCodeExtensionLike {
  isActive: boolean;
  exports?: ExtensionApiLike;
  activate(): Thenable<ExtensionApiLike>;
}

/** FSP-003 §4 K-class codes. */
export type FailureCode = 'K70' | 'K71' | 'K72' | 'K73';

/** Default poll interval inside the wait loops (ms). 25ms matches the
 *  pre-FSP `waitFor` cadence so observable test latency doesn't change. */
const DEFAULT_POLL_INTERVAL_MS = 25;

/** Build the K-coded error message. Format:
 *
 *      K71: kernel.ready handshake never observed (timeout=5000ms)
 *        observed_state: {...}
 *        last 50 marker events:
 *          +0ms   extension/activation_started
 *          ...
 */
function formatFailure(
  code: FailureCode,
  message: string,
  timeoutMs: number,
  observedState: Record<string, unknown>,
  tailLines: number
): string {
  const tail = formatMarkerTail(readMarkerTail(tailLines));
  return [
    `${code}: ${message} (timeout=${timeoutMs}ms)`,
    `  observed_state: ${JSON.stringify(observedState)}`,
    `  last ${tailLines} marker events:`,
    tail
  ].join('\n');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Generic spinwait (fixture-internal state only). FSP-003 forbids this
 *  for extension-lifecycle assertions — use the phase-typed helpers
 *  below so failures carry a K code. Kept here so contract tests that
 *  poll fake-module state (`fakeMod.spawned.length === 1`) don't have
 *  to fall back to inline `setTimeout` loops. */
export async function waitForPredicate(
  predicate: () => boolean,
  timeoutMs: number,
  description: string = 'predicate'
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(`${description} did not become true within ${timeoutMs}ms`);
}

// --- K70: activation -------------------------------------------------------

/** Wait for the extension to activate and return its API surface. K70
 *  fires when `vscode.extensions.getExtension(extId)?.isActive` does
 *  not flip true within `timeoutMs`. Includes the marker tail so the
 *  operator can see whether activation even started. */
export async function waitForActivation(
  vscodeMod: typeof vscode,
  extId: string,
  timeoutMs: number = 30_000
): Promise<ExtensionApiLike> {
  const start = Date.now();
  // Trigger activation eagerly. `getExtension(...).activate()` resolves
  // when activate() returns; if the extension is already active, this
  // returns the cached exports.
  const ext = vscodeMod.extensions.getExtension(extId) as VsCodeExtensionLike | undefined;
  if (!ext) {
    throw new Error(
      formatFailure(
        'K70',
        `extension ${extId} not found in vscode.extensions registry`,
        timeoutMs,
        { extId, registry_size: vscodeMod.extensions.all.length },
        DEFAULT_MARKER_TAIL_LINES
      )
    );
  }
  // Kick off activate() but bound it by our deadline.
  const activatePromise = ext.activate();
  while (Date.now() - start < timeoutMs) {
    if (ext.isActive && ext.exports) {
      return ext.exports;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  // Best-effort capture of whatever the registry says, then format K70.
  const observed = {
    isActive: ext.isActive,
    has_exports: !!ext.exports,
    awaited_activate: activatePromise !== undefined
  };
  throw new Error(
    formatFailure(
      'K70',
      'activation never reached (extension.isActive remained false)',
      timeoutMs,
      observed,
      DEFAULT_MARKER_TAIL_LINES
    )
  );
}

// --- K71: kernel.ready ------------------------------------------------------

/** Wait for `api.getKernelClient().isReady === true`. The PtyKernelClient
 *  flips this after the `kernel.ready` LogRecord lands; the StubKernelClient
 *  flips it synchronously on `attachRouter()`. K71 fires when the predicate
 *  doesn't become true within the timeout — the dump includes the
 *  activation-diagnostics snapshot so the operator can tell whether the
 *  kernel even started. */
export async function waitForKernelReady(
  api: ExtensionApiLike,
  timeoutMs: number = 30_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const client = api.getKernelClient();
    if (client?.isReady === true) {
      return;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  const client = api.getKernelClient();
  const diag = api.getActivationDiagnostics?.();
  throw new Error(
    formatFailure(
      'K71',
      'kernel.ready handshake never observed (KernelClient.isReady stayed false)',
      timeoutMs,
      {
        client_present: !!client,
        is_ready: client?.isReady ?? null,
        activation_diagnostics: diag ?? null
      },
      DEFAULT_MARKER_TAIL_LINES
    )
  );
}

// --- K72: terminal cell span -----------------------------------------------

interface NotebookDocLike {
  cellCount: number;
  cellAt(index: number): {
    outputs: ReadonlyArray<{
      items: ReadonlyArray<{ mime: string; data: Uint8Array | string }>;
    }>;
  };
}

const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** True iff the given cell carries at least one closed RTS_RUN_MIME
 *  span (`endTimeUnixNano` set, status non-UNSET). */
function cellHasTerminalSpan(cell: { outputs: ReadonlyArray<{ items: ReadonlyArray<{ mime: string; data: Uint8Array | string }> }> }): boolean {
  const items = cell.outputs.flatMap((o) => o.items);
  const runItems = items.filter((i) => i.mime === RTS_RUN_MIME);
  for (const item of runItems) {
    let parsed: { endTimeUnixNano?: string | null; status?: { code?: string } };
    try {
      const text =
        typeof item.data === 'string'
          ? item.data
          : new TextDecoder('utf-8').decode(item.data);
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      continue;
    }
    const closed =
      typeof parsed.endTimeUnixNano === 'string' && parsed.endTimeUnixNano.length > 0;
    const statusOk = parsed.status?.code !== undefined && parsed.status.code !== 'STATUS_CODE_UNSET';
    if (closed && statusOk) {
      return true;
    }
  }
  return false;
}

/** Wait for the kernel to emit a terminal RTS_RUN_MIME span on a cell.
 *  K72 fires if no closed span is observed within the timeout. */
export async function waitForCellComplete(
  doc: NotebookDocLike,
  cellIndex: number,
  timeoutMs: number = 30_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cellIndex < doc.cellCount && cellHasTerminalSpan(doc.cellAt(cellIndex))) {
      return;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  let observedOutputCount = 0;
  let observedRunMimeCount = 0;
  if (cellIndex < doc.cellCount) {
    const cell = doc.cellAt(cellIndex);
    observedOutputCount = cell.outputs.length;
    observedRunMimeCount = cell.outputs.flatMap((o) => o.items).filter(
      (i) => i.mime === RTS_RUN_MIME
    ).length;
  }
  throw new Error(
    formatFailure(
      'K72',
      `terminal span never observed on cell ${cellIndex}`,
      timeoutMs,
      {
        cellIndex,
        cell_count: doc.cellCount,
        observed_output_count: observedOutputCount,
        observed_run_mime_count: observedRunMimeCount
      },
      DEFAULT_MARKER_TAIL_LINES
    )
  );
}

// --- K73: hydrate confirmation ---------------------------------------------

interface MetadataLoaderLike {
  getPendingCount(): number;
}

/** Wait for the metadata-loader's `pending` map to no longer contain the
 *  given URI (i.e. hydrate-complete confirmation observed). K73 fires
 *  if the pending count never drops within the timeout. The kernel's
 *  hydrate handler emits a `mode:"snapshot"` `trigger:"hydrate_complete"`
 *  envelope; the loader's `handleConfirmation` clears the watchdog. */
export async function waitForHydrate(
  loader: MetadataLoaderLike,
  uri: string,
  timeoutMs: number = 15_000
): Promise<void> {
  const start = Date.now();
  // The loader's pending map is keyed by the same `uri` value the
  // caller supplies. We treat "pending count strictly decreased OR is
  // 0" as the success signal; v2.0.2 confirmations aren't URI-tagged so
  // the cleanest predicate is "no entry is pending."
  const initial = loader.getPendingCount();
  while (Date.now() - start < timeoutMs) {
    const now = loader.getPendingCount();
    if (now === 0 || now < initial) {
      return;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(
    formatFailure(
      'K73',
      `hydrate confirmation never observed for ${uri}`,
      timeoutMs,
      {
        uri,
        pending_count_initial: initial,
        pending_count_observed: loader.getPendingCount()
      },
      DEFAULT_MARKER_TAIL_LINES
    )
  );
}
