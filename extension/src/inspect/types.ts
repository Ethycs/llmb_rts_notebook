// BSP-008 Inspect mode — TypeScript schemas mirroring the kernel's
// metadata.rts.zone substructure (run_frames + context_manifests).
//
// The shapes follow BSP-008 §4 (ContextManifest) and §7 (RunFrame V1
// minimal). Tolerated divergences from the on-disk emission produced by
// vendor/LLMKernel today are documented inline; the parsers in
// run-frame-reader.ts reconcile both shapes so the V1 Inspect surface
// works regardless of which kernel revision wrote the file.

/** RunFrame status enum per BSP-008 §7 + the §8 lifecycle "running"
 *  intermediate (start frame is `running`, terminal frame is
 *  `complete | failed | interrupted`). */
export type RunFrameStatus =
  | 'running'
  | 'complete'
  | 'failed'
  | 'interrupted';

/** Terminal statuses — used by the history view to filter out in-flight
 *  start frames and by the per-cell view to decide whether to surface
 *  "running" vs the latest completed run. */
export const RUN_FRAME_TERMINAL_STATUSES: readonly RunFrameStatus[] = [
  'complete',
  'failed',
  'interrupted'
] as const;

/** RunFrame V1 minimal schema — BSP-008 §7. Persisted under
 *  `metadata.rts.zone.run_frames[<run_id>]`. */
export interface RunFrame {
  run_id: string;
  cell_id: string;
  /** agent_id (BSP-002 §2.2). May be empty in defensively-parsed records
   *  to keep the surface tolerant of incomplete frames; the V1 status item
   *  hides "executor: " when empty. */
  executor_id: string;
  /** May be `null` per BSP-008 §7 ("null if first turn for this agent"). */
  turn_head_before: string | null;
  /** May be `null` per BSP-008 §7 ("null if run failed before any turn
   *  committed" or "still running"). */
  turn_head_after: string | null;
  /** Points at `metadata.rts.zone.context_manifests[<manifest_id>]`. May be
   *  empty when the kernel emitted a record without one (defensive); the
   *  per-cell view falls back to "(manifest unavailable)". */
  context_manifest_id: string;
  status: RunFrameStatus;
  /** ISO-8601, UTC. */
  started_at: string;
  /** ISO-8601, UTC; absent while the run is in `running`. */
  ended_at?: string;
}

/** ContextManifest V1 schema — BSP-008 §4. Persisted under
 *  `metadata.rts.zone.context_manifests[<manifest_id>]`. */
export interface ContextManifest {
  manifest_id: string;
  cell_id: string;
  /** May be `null` when the cell does not belong to a section. The kernel
   *  V1 emission does not yet include this field (sections land in BSP-002
   *  Issue 2); the parser defaults to null. */
  section_id: string | null;
  /** Ordered, deduplicated turn ids — the agent's input. BSP-008 §4 uses
   *  this field; the kernel's V1 emission today writes `cell_refs`
   *  instead (see `cell_refs` below). The Inspect surface tolerates
   *  both — `total_turn_count` is derived from this list when the kernel
   *  did not emit the count directly. */
  turn_ids: string[];
  /** Ordered, deduplicated cell ids contributing to the pack. Today's
   *  kernel emits this field instead of `turn_ids`; readers tolerate
   *  both. */
  cell_refs: string[];
  /** For Inspect mode (BSP-008 §11). Not consulted by the agent. */
  inclusion_rules_applied: ContextInclusionRule[];
  /** For Inspect mode (BSP-008 §11). Not consulted by the agent. */
  exclusions_applied: ContextExclusion[];
  /** == `turn_ids.length` per spec; derived when the kernel did not emit
   *  the count. */
  total_turn_count: number;
  /** V1: always `null` (BSP-008 §4 reserves the field for V2's budget
   *  overflow strategy). The detail view renders "(V1: not estimated)". */
  total_token_estimate: number | null;
  /** ISO-8601 timestamp. The kernel today writes `generated_at`; the
   *  parser accepts either spelling. */
  created_at: string;
}

/** One inclusion-rule trace entry per BSP-008 §4. */
export interface ContextInclusionRule {
  /** Rule name; the V1 packer emits `pinned`, `section_predecessor`, and
   *  `current_cell_sub_turns`. Kept as `string` so the Inspect surface
   *  surfaces unknown rules emitted by future kernel versions. */
  rule: string;
  cells: string[];
  /** Optional turn-id list; only the `current_cell_sub_turns` rule emits
   *  this in V1. */
  turn_ids?: string[];
}

/** One exclusion trace entry per BSP-008 §4. */
export interface ContextExclusion {
  /** Reason name; the V1 packer emits `scratch`, `excluded`, `obsolete`. */
  reason: string;
  cells: string[];
}
