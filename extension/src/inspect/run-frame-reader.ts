// BSP-008 Inspect mode — typed read of metadata.rts.zone.run_frames and
// metadata.rts.zone.context_manifests.
//
// Per BSP-008 §11, the V1 Inspect surface answers two questions per cell:
//
//   1. "What context did the agent see when this cell ran?"
//      — by following RunFrame.context_manifest_id → ContextManifest.
//   2. "What changed in the turn DAG as a result?"
//      — by diffing RunFrame.turn_head_before / turn_head_after.
//
// All functions in this module are PURE reads over the metadata.rts object
// (the shape produced by the serializer's deserializeNotebook + the metadata
// applier's snapshot path). No vscode imports here so the unit tier (T0)
// can exercise the readers without an Extension Host.
//
// Schema source of truth: BSP-008 §4 (ContextManifest) and §7 (RunFrame).
// Storage path: metadata.rts.zone.run_frames[<run_id>] and
//               metadata.rts.zone.context_manifests[<manifest_id>]
// (see vendor/LLMKernel/llm_kernel/metadata_writer.py
//  ::_handle_record_run_frame / ::_handle_record_context_manifest).
//
// On-disk-shape divergence (FLAGGED — see manifest-detail-view.ts and the
// final report). The kernel today persists ContextManifest with `cell_refs`
// (list of cell_ids) where BSP-008 §4 specifies `turn_ids`. This reader
// tolerates BOTH shapes — it surfaces whichever is present.

import {
  RunFrame,
  ContextManifest,
  RunFrameStatus,
  RUN_FRAME_TERMINAL_STATUSES,
  ContextInclusionRule,
  ContextExclusion
} from './types.js';

// ===========================================================================
// Metadata path helpers
// ===========================================================================

/** Subset of the on-disk metadata.rts shape this module reads. We only care
 *  about `zone.run_frames` and `zone.context_manifests`; everything else is
 *  carried opaque. The metadata-applier and serializer round-trip the full
 *  structure verbatim per RFC-005's "preserve unknown keys" rule. */
export interface NotebookMetadataLike {
  /** Always-present root namespace. The applier writes here; the serializer
   *  preserves it byte-for-byte. */
  rts?: {
    zone?: {
      run_frames?: Record<string, unknown>;
      context_manifests?: Record<string, unknown>;
    };
    // Forward-compat: future RFC-005 minor versions may add keys here. We
    // tolerate but ignore them for the Inspect surface.
    [k: string]: unknown;
  };
  // The full metadata object may carry top-level VS Code keys
  // (custom, indentAmount, etc.); they are not the reader's concern.
  [k: string]: unknown;
}

/** Returns the `zone.run_frames` map, or `{}` when absent. */
export function runFramesOf(metadata: NotebookMetadataLike | undefined | null):
  Record<string, RunFrame> {
  const raw = metadata?.rts?.zone?.run_frames;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, RunFrame> = {};
  for (const [run_id, value] of Object.entries(raw)) {
    const frame = parseRunFrame(run_id, value);
    if (frame) {
      out[run_id] = frame;
    }
  }
  return out;
}

/** Returns the `zone.context_manifests` map, or `{}` when absent. */
export function contextManifestsOf(metadata: NotebookMetadataLike | undefined | null):
  Record<string, ContextManifest> {
  const raw = metadata?.rts?.zone?.context_manifests;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, ContextManifest> = {};
  for (const [manifest_id, value] of Object.entries(raw)) {
    const m = parseContextManifest(manifest_id, value);
    if (m) {
      out[manifest_id] = m;
    }
  }
  return out;
}

// ===========================================================================
// Defensive parsers — tolerate the BSP-008 §4 spec shape AND the on-disk
// shape produced by vendor/LLMKernel today.
// ===========================================================================

/** Pull a string field if present + non-empty. */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Pull a string-or-null field, mapping anything else to undefined. */
function strOrNull(obj: Record<string, unknown>, key: string): string | null | undefined {
  const v = obj[key];
  if (v === null) return null;
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

/** Defensive parse of one RunFrame record. Returns `undefined` when the
 *  required-non-empty fields (run_id, cell_id, status, started_at) are
 *  absent or malformed. We tolerate missing `executor_id`,
 *  `context_manifest_id`, `turn_head_*`, `ended_at` per the spec's "additive
 *  fields" forward-compat discipline — V2 will add more fields and V1
 *  readers MUST not crash on records produced by future kernels. */
export function parseRunFrame(run_id_key: string, raw: unknown): RunFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // run_id may be present in the value itself OR only in the map key.
  // Prefer the value's run_id when present; fall back to the key.
  const run_id = strField(obj, 'run_id') ?? (run_id_key.length > 0 ? run_id_key : undefined);
  if (!run_id) return null;
  const cell_id = strField(obj, 'cell_id');
  if (!cell_id) return null;
  const status_raw = strField(obj, 'status');
  if (!status_raw) return null;
  if (!isRunFrameStatus(status_raw)) {
    return null;
  }
  const started_at = strField(obj, 'started_at');
  if (!started_at) return null;
  // Optional fields — preserve null vs undefined where the spec uses null
  // as a sentinel ("first turn for this agent", "run failed before any turn
  // committed", "still running").
  const turn_head_before = strOrNull(obj, 'turn_head_before') ?? null;
  const turn_head_after = strOrNull(obj, 'turn_head_after') ?? null;
  const executor_id = strField(obj, 'executor_id') ?? '';
  const context_manifest_id = strField(obj, 'context_manifest_id') ?? '';
  const ended_at = strField(obj, 'ended_at');
  return {
    run_id,
    cell_id,
    executor_id,
    context_manifest_id,
    status: status_raw,
    started_at,
    ended_at,
    turn_head_before,
    turn_head_after
  };
}

function isRunFrameStatus(s: string): s is RunFrameStatus {
  return s === 'running' || s === 'complete' || s === 'failed' || s === 'interrupted';
}

/** Defensive parse of one ContextManifest record. Tolerates the divergence
 *  between BSP-008 §4 and the kernel's current on-disk shape:
 *
 *   spec field          | on-disk today                | reader behavior
 *   --------------------|-------------------------------|------------------
 *   turn_ids[]          | (absent — kernel uses `cell_refs`) | parse if present
 *   total_turn_count    | (absent — derive from turn_ids)    | derive when missing
 *   total_token_estimate| (absent today — V2 fills)          | null when absent
 *   created_at          | `generated_at`                     | accept either
 *   section_id          | (absent today)                     | null when absent
 *
 *  This tolerance is FLAGGED in the V1 final report; V2 should reconcile
 *  the kernel emission with the spec.
 */
export function parseContextManifest(manifest_id_key: string, raw: unknown):
  ContextManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const manifest_id = strField(obj, 'manifest_id') ??
    (manifest_id_key.length > 0 ? manifest_id_key : undefined);
  if (!manifest_id) return null;
  const cell_id = strField(obj, 'cell_id');
  if (!cell_id) return null;

  // turn_ids per spec, or fall back to cell_refs (current kernel emission).
  // We also surface cell_refs separately below for the per-manifest detail
  // view: BSP-008 §4 inclusion_rules_applied is keyed by cell, not turn.
  const turn_ids_raw = obj.turn_ids;
  const turn_ids = Array.isArray(turn_ids_raw)
    ? turn_ids_raw.filter((s): s is string => typeof s === 'string')
    : [];
  const cell_refs_raw = obj.cell_refs;
  const cell_refs = Array.isArray(cell_refs_raw)
    ? cell_refs_raw.filter((s): s is string => typeof s === 'string')
    : [];

  // total_turn_count: spec field; derive from turn_ids when absent.
  let total_turn_count: number;
  const ttc = obj.total_turn_count;
  if (typeof ttc === 'number' && Number.isFinite(ttc)) {
    total_turn_count = ttc;
  } else {
    total_turn_count = turn_ids.length;
  }

  // total_token_estimate: explicitly nullable in V1; absent → null per
  // §11.4 "every field rendered as 'not estimated' so the operator knows
  // the field exists".
  const tte = obj.total_token_estimate;
  const total_token_estimate =
    typeof tte === 'number' && Number.isFinite(tte) ? tte : null;

  // created_at — spec name; the kernel today writes `generated_at`. Accept
  // either; render whichever is present.
  const created_at =
    strField(obj, 'created_at') ?? strField(obj, 'generated_at') ?? '';

  const section_id = strOrNull(obj, 'section_id') ?? null;

  // inclusion_rules_applied / exclusions_applied are arrays of records.
  const inclusion_rules_applied = parseInclusionRules(obj.inclusion_rules_applied);
  const exclusions_applied = parseExclusions(obj.exclusions_applied);

  return {
    manifest_id,
    cell_id,
    section_id: typeof section_id === 'string' ? section_id : null,
    turn_ids,
    cell_refs,
    inclusion_rules_applied,
    exclusions_applied,
    total_turn_count,
    total_token_estimate,
    created_at
  };
}

function parseInclusionRules(raw: unknown): ContextInclusionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextInclusionRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const rule = typeof rec.rule === 'string' ? rec.rule : '';
    if (!rule) continue;
    const cells = Array.isArray(rec.cells)
      ? rec.cells.filter((s): s is string => typeof s === 'string')
      : [];
    const turn_ids = Array.isArray(rec.turn_ids)
      ? rec.turn_ids.filter((s): s is string => typeof s === 'string')
      : undefined;
    out.push({ rule, cells, turn_ids });
  }
  return out;
}

function parseExclusions(raw: unknown): ContextExclusion[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextExclusion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    if (!reason) continue;
    const cells = Array.isArray(rec.cells)
      ? rec.cells.filter((s): s is string => typeof s === 'string')
      : [];
    out.push({ reason, cells });
  }
  return out;
}

// ===========================================================================
// Inspect-mode lookups
// ===========================================================================

/** Most-recent run frame for the given cell, or `null` when the cell has no
 *  recorded runs. Sort key is `started_at` descending per the brief's V1
 *  decision (the BSP-008 spec leaves the sort key unstated; `started_at`
 *  matches the operator-narrative "the most recently dispatched run").
 *
 *  Behavior:
 *   - When a terminal frame exists for a `run_id`, prefer it over the
 *     `running` start frame (the writer's "idempotent on run_id" allows
 *     update-in-place; in practice the same `run_id` may appear under
 *     `running` and then a terminal status if the kernel chose to write
 *     two records — we filter accordingly).
 *   - When only a `running` frame exists, return it (so the operator sees
 *     the in-flight execution and its staleness).
 */
export function latestRunFrameForCell(
  metadata: NotebookMetadataLike | undefined | null,
  cellId: string
): RunFrame | null {
  if (!cellId) return null;
  const frames = runFramesOf(metadata);
  // Group by run_id and prefer the terminal record when both exist.
  const bestByRunId = new Map<string, RunFrame>();
  for (const f of Object.values(frames)) {
    if (f.cell_id !== cellId) continue;
    const prev = bestByRunId.get(f.run_id);
    if (!prev) {
      bestByRunId.set(f.run_id, f);
      continue;
    }
    // If the new record is terminal and the prior is running, replace.
    if (isTerminal(f.status) && !isTerminal(prev.status)) {
      bestByRunId.set(f.run_id, f);
    }
  }
  const candidates = [...bestByRunId.values()];
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareStartedAtDesc(a, b));
  return candidates[0];
}

/** All terminal-status run frames for the given cell, oldest first. Used by
 *  the run-history quick-pick (Click→expand). `running` frames are excluded
 *  here: the history view shows completed runs only. The latest `running`
 *  frame surfaces in `latestRunFrameForCell` when applicable. */
export function runFrameHistoryForCell(
  metadata: NotebookMetadataLike | undefined | null,
  cellId: string
): RunFrame[] {
  if (!cellId) return [];
  const frames = runFramesOf(metadata);
  // For each run_id, surface only the terminal record when present.
  const byRunId = new Map<string, RunFrame>();
  for (const f of Object.values(frames)) {
    if (f.cell_id !== cellId) continue;
    const prev = byRunId.get(f.run_id);
    if (!prev) {
      byRunId.set(f.run_id, f);
    } else if (isTerminal(f.status) && !isTerminal(prev.status)) {
      byRunId.set(f.run_id, f);
    }
  }
  const out = [...byRunId.values()].filter((f) => isTerminal(f.status));
  out.sort((a, b) => compareStartedAtAsc(a, b));
  return out;
}

/** Resolve a manifest by id. Returns `null` when not present so callers can
 *  render the "(manifest unavailable; run may be from a prior session)"
 *  fallback per the V1 ambiguity decision. */
export function manifestById(
  metadata: NotebookMetadataLike | undefined | null,
  manifestId: string
): ContextManifest | null {
  if (!manifestId) return null;
  const all = contextManifestsOf(metadata);
  return all[manifestId] ?? null;
}

/** Count the distinct runs (by run_id) recorded for a cell. Used by the
 *  per-cell status item ("this cell ran N times"). */
export function runCountForCell(
  metadata: NotebookMetadataLike | undefined | null,
  cellId: string
): number {
  if (!cellId) return 0;
  const frames = runFramesOf(metadata);
  const ids = new Set<string>();
  for (const f of Object.values(frames)) {
    if (f.cell_id === cellId) ids.add(f.run_id);
  }
  return ids.size;
}

// ===========================================================================
// Sort helpers
// ===========================================================================

function isTerminal(status: RunFrameStatus): boolean {
  return (RUN_FRAME_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Compare two RunFrames by `started_at` descending (most-recent first).
 *  ISO-8601 strings sort lexicographically with the same ordering as
 *  chronologically — stable across timezones since the kernel emits UTC
 *  with the trailing "Z". When the timestamps tie, fall back to run_id
 *  to keep the sort deterministic. */
function compareStartedAtDesc(a: RunFrame, b: RunFrame): number {
  if (a.started_at === b.started_at) {
    return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0;
  }
  return a.started_at < b.started_at ? 1 : -1;
}

function compareStartedAtAsc(a: RunFrame, b: RunFrame): number {
  return -compareStartedAtDesc(a, b);
}
