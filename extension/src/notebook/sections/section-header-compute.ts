// PLAN-S5.5 Phase 3 — pure compute for the section-header decoration.
//
// INTENTIONALLY vscode-free so the unit tier can import without a vscode
// stub. The vscode-bound provider class
// (section-header-provider.ts) re-uses these compute helpers and
// wraps the render shape into a NotebookCellStatusBarItem.
//
// Mirrors the cell-status-compute / cell-badge-compute discipline:
// pure-compute returns a typed render shape; the provider wraps it.

/** The 4-value section status enum, mirrored from the kernel-side
 *  ``_SECTION_STATUSES`` in vendor/LLMKernel/llm_kernel/overlay_applier.py.
 *  V1 has exactly these four values; anything else is treated as
 *  ``open`` for rendering purposes (defensive). */
export const SECTION_STATUSES = ['open', 'in_progress', 'complete', 'frozen'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/** Render shape consumed by the provider (and asserted by unit tests).
 *  Returned by :func:`computeSectionHeader`. The provider class
 *  converts this into a NotebookCellStatusBarItem on every section-
 *  member cell. */
export interface SectionHeaderRender {
  /** The kernel-side section id (stable). */
  section_id: string;
  /** Operator-supplied title (mutable via rename). */
  title: string;
  /** Current 4-value status. */
  status: SectionStatus;
  /** True iff this cell is the first one in the section's cell_range. */
  is_first: boolean;
  /** Number of cells in the section (for the first-cell header). */
  cell_count: number;
  /** Rendered text for the status-bar item. */
  text: string;
  /** Multi-line tooltip with section details. */
  tooltip: string;
}

/** ASCII glyphs used in the rendered text — no emojis per project
 *  discipline. The section-sign character ``§`` is a clean visual
 *  anchor; ``▸`` marks continuation cells. */
export const SECTION_HEADER_PREFIX = '§';
export const SECTION_CONTINUATION_PREFIX = '▸';

/** The kernel-side metadata shape we read. Loose typing because this
 *  blob is operator-mutable and we should never crash on a malformed
 *  snapshot — return undefined / open / "" rather than throw. */
export interface NotebookMetadataForSections {
  rts?: {
    zone?: {
      sections?: Record<string, unknown>;
    };
    cells?: Record<string, unknown>;
  };
}

/** Pure compute: given a cell id and a metadata blob, return the
 *  section-header render shape for that cell, or undefined when the
 *  cell does not belong to any section. */
export function computeSectionHeader(args: {
  cellId: string;
  metadata: NotebookMetadataForSections | undefined;
}): SectionHeaderRender | undefined {
  const { cellId, metadata } = args;
  if (!cellId || !metadata) return undefined;
  const sections = metadata.rts?.zone?.sections;
  const cells = metadata.rts?.cells;
  if (!sections || !cells) return undefined;
  const cellRec = cells[cellId];
  if (!cellRec || typeof cellRec !== 'object') return undefined;
  const sectionId = (cellRec as Record<string, unknown>)['section_id'];
  if (typeof sectionId !== 'string' || sectionId.length === 0) {
    return undefined;
  }
  const sec = sections[sectionId];
  if (!sec || typeof sec !== 'object') return undefined;
  const section = sec as Record<string, unknown>;
  const title = typeof section['title'] === 'string'
    ? (section['title'] as string)
    : sectionId;
  const rawStatus = section['status'];
  const status: SectionStatus =
    typeof rawStatus === 'string' &&
    (SECTION_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as SectionStatus)
      : 'open';
  const cellRange = Array.isArray(section['cell_range'])
    ? (section['cell_range'] as unknown[]).filter(
        (x): x is string => typeof x === 'string'
      )
    : [];
  const is_first = cellRange.length > 0 && cellRange[0] === cellId;
  const cell_count = cellRange.length;
  return {
    section_id: sectionId,
    title,
    status,
    is_first,
    cell_count,
    text: renderHeaderText(title, status, is_first, cell_count),
    tooltip: renderHeaderTooltip(sectionId, title, status, is_first, cell_count)
  };
}

/** Render the status-bar item text. First-cell form carries title +
 *  status + cell count; continuation-cell form carries title only. */
function renderHeaderText(
  title: string,
  status: SectionStatus,
  is_first: boolean,
  cell_count: number
): string {
  if (is_first) {
    return `${SECTION_HEADER_PREFIX} ${title} (${status}) · ${cell_count} ${
      cell_count === 1 ? 'cell' : 'cells'
    }`;
  }
  return `${SECTION_CONTINUATION_PREFIX} ${title}`;
}

/** Render the multi-line tooltip with section details. */
function renderHeaderTooltip(
  section_id: string,
  title: string,
  status: SectionStatus,
  is_first: boolean,
  cell_count: number
): string {
  const lines: string[] = [
    `Section: ${title}`,
    `Status:  ${status}`,
    `ID:      ${section_id}`,
    `Cells:   ${cell_count}`,
  ];
  if (status === 'frozen') {
    lines.push('');
    lines.push(
      '(frozen sections block structural ops on member cells; ' +
        'unfreeze via Set status → open.)'
    );
  } else if (status === 'in_progress') {
    lines.push('');
    lines.push(
      '(in_progress is the auto-flip status while an agent is running; ' +
        'it flips back to open when the last run terminates.)'
    );
  }
  if (!is_first) {
    lines.push('');
    lines.push('(continuation cell — see the first cell for the section header.)');
  }
  return lines.join('\n');
}
