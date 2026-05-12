// BSP-008 Inspect mode — per-manifest detail view (pure render).
//
// Renders BSP-008 §11's per-manifest format:
//
//   manifest <manifest_id>:
//   - included by rule pinned: cells [c_3, c_8]
//   - included by rule section_predecessor: cells [c_12, c_13, c_14]
//   - included by rule current_cell_sub_turns: cell c_15, turns [t_72.1]
//   - excluded as scratch: cells [c_11]
//   - excluded as excluded: cells [c_5]
//   - total turns: 8; total tokens: (V1: not estimated)
//
// This module is INTENTIONALLY pure (no vscode imports). Unit tests can
// assert the formatted output byte-for-byte. The QuickPick host that
// presents the output to the operator lives in `manifest-detail-command.ts`
// (vscode-bound) and pulls these renderers in.
//
// Engineering Guide §11.4 ("Silent drops"): the detail view surfaces every
// field present in the on-disk manifest, including reserved-as-null fields
// (`total_token_estimate` is rendered as "(V1: not estimated)" so the
// operator sees the field exists). When `manifestById` returns null, the
// caller renders the missing-manifest sentinel from
// `MISSING_MANIFEST_DETAIL_LINES` rather than swallow the lookup failure.

import type { ContextManifest, RunFrame } from './types.js';

/** Sentinel lines rendered when a RunFrame's `context_manifest_id`
 *  references a manifest that is not present in the on-disk metadata.
 *  V1 spec: BSP-008 ambiguity decision — "render '(manifest unavailable;
 *  run may be from a prior session)' and continue". */
export const MISSING_MANIFEST_DETAIL_LINES: readonly string[] = [
  '(manifest unavailable; run may be from a prior session)'
] as const;

/** Pure render: produce the detail-view text per BSP-008 §11 as an array
 *  of lines. Returning lines (rather than one big string) lets the
 *  QuickPick host turn each line into one item with stable ordering, and
 *  makes assertions trivial in unit tests.
 *
 *  Format (canonical):
 *
 *    manifest <id>:
 *    - included by rule <rule>: cells [<cell_id>, ...]
 *    - included by rule current_cell_sub_turns: cell <cell_id>, turns [<turn_id>, ...]
 *    - excluded as <reason>: cells [<cell_id>, ...]
 *    - total turns: <n>; total tokens: <tokens-or-not-estimated>
 *
 *  Empty inclusion_rules_applied / exclusions_applied buckets are skipped
 *  (matches the kernel's emission discipline — empty buckets are not
 *  written, so the operator only sees rules that contributed). */
export function renderManifestDetail(manifest: ContextManifest): string[] {
  const lines: string[] = [];
  lines.push(`manifest ${manifest.manifest_id}:`);

  for (const rule of manifest.inclusion_rules_applied) {
    if (rule.rule === 'current_cell_sub_turns') {
      // Per BSP-008 §11 example, the sub-turns rule renders with both the
      // current cell AND the included sub-turn ids. Single-cell rule by
      // construction (the V1 packer emits one cell here).
      const cell = rule.cells[0] ?? manifest.cell_id;
      const turns = rule.turn_ids ?? [];
      lines.push(
        `- included by rule current_cell_sub_turns: cell ${cell}, ` +
          `turns [${turns.join(', ')}]`
      );
    } else {
      lines.push(
        `- included by rule ${rule.rule}: cells [${rule.cells.join(', ')}]`
      );
    }
  }

  for (const ex of manifest.exclusions_applied) {
    lines.push(
      `- excluded as ${ex.reason}: cells [${ex.cells.join(', ')}]`
    );
  }

  // BSP-008 §11 final summary line. The token estimate uses the spec's
  // exact phrasing "(V1: not estimated)" when the field is null so the
  // operator knows it's a known-unknown rather than missing data.
  const tokens =
    manifest.total_token_estimate === null
      ? '(V1: not estimated)'
      : String(manifest.total_token_estimate);
  lines.push(
    `- total turns: ${manifest.total_turn_count}; total tokens: ${tokens}`
  );

  return lines;
}

/** Pure render of a per-cell run summary line. Used by the per-cell
 *  status bar item AND as the QuickPick header item. Format follows
 *  BSP-008 §11 per-cell view:
 *
 *    "this cell ran N times; latest run = run_X (status: complete) with
 *     manifest = manifest_Y (M cells included, K excluded)"
 *
 *  When `manifest` is null (referenced manifest not present), the
 *  manifest-summary segment is replaced with the missing-manifest
 *  sentinel. */
export function renderCellRunSummary(args: {
  runCount: number;
  latest: RunFrame;
  manifest: ContextManifest | null;
}): string {
  const { runCount, latest, manifest } = args;
  const includedCount = manifest
    ? manifest.inclusion_rules_applied.reduce(
        (acc, r) => acc + r.cells.length,
        0
      )
    : 0;
  const excludedCount = manifest
    ? manifest.exclusions_applied.reduce(
        (acc, r) => acc + r.cells.length,
        0
      )
    : 0;
  const manifestSegment = manifest
    ? `manifest = ${manifest.manifest_id} (${includedCount} cells included, ${excludedCount} excluded)`
    : `manifest unavailable (id=${latest.context_manifest_id || 'n/a'})`;
  const ranTimes = runCount === 1 ? '1 time' : `${runCount} times`;
  return (
    `this cell ran ${ranTimes}; latest run = ${latest.run_id} ` +
    `(status: ${latest.status}) with ${manifestSegment}`
  );
}

// ===========================================================================
// Command id + args contract — declared here (not in the vscode-bound
// command file) so the cell-status provider can reference them without
// pulling vscode into the unit-tier module graph.
// ===========================================================================

/** Command id contributed by package.json. */
export const OPEN_MANIFEST_DETAIL_COMMAND_ID =
  'llmnb.inspect.openManifestDetail';

/** Args carried by the command invocation from the cell-status item. The
 *  shape mirrors the InterruptCommandArgs / ResetContaminationCommandArgs
 *  pattern in sibling modules. */
export interface OpenManifestDetailArgs {
  cell_id: string;
  manifest_id: string;
  /** The run id whose manifest we're inspecting; rendered in the
   *  QuickPick title for operator orientation. */
  run_id: string;
}
