// PLAN-S5.0.2 §3.2 — provenance chip component.
//
// A small DOM chip rendered above a cell's regular run output when the cell
// carries `metadata.rts.cells[<id>].generated_by != null` (the cell was
// produced by a magic code generator handler — `@@bind`, `@@spawn`,
// `@@dispatch` — landing kernel-side in S5.0.2). The chip surfaces the
// provenance link so the operator can jump back to the generator cell.
//
// Visual: subtle gray chip with text
//   `from <generator_magic_text> in c_<short_id>`
// where `<short_id>` is the first 6 chars of `generated_by`. The
// `<generator_magic_text>` is the first non-blank line of the parent
// (generator) cell's source, truncated to 40 chars. When the parent text
// is not resolvable from the renderer surface (renderers traditionally
// see only their own cell), we fall back to a shortened cellId so the
// chip still points the operator to a discoverable handle.
//
// Click → invoke `llmnb.revealCell` via the host post-message bridge so
// the editor scrolls to + flashes the source cell. Tooltip on hover
// surfaces the `generated_at` ISO timestamp.
//
// This file is bundled into the renderer webview (run-renderer.ts), so it
// exports a pure-string HTML render plus a thin click-binding helper. No
// VS Code imports allowed here.

import { escapeHtml, escapeAttr } from './escape.js';

/** Information needed to render the chip for one cell. The renderer host
 *  (run-renderer.ts) extracts this from the cell's `metadata.rts.cells`
 *  slot and hands it to `renderProvenanceChip`. */
export interface ProvenanceChipProps {
  /** Stable cell identifier of the cell carrying `generated_by`. Surfaced
   *  in the data-rts-cell-id attribute so click bindings can correlate. */
  cellId: string;
  /** Cell id of the generator cell (`metadata.rts.cells[<id>].generated_by`).
   *  When `null` / empty the renderer SHOULD NOT include the chip — the
   *  function returns the empty string. */
  generatedBy: string | null | undefined;
  /** ISO8601 timestamp the generator emitted this cell at. Surfaced in
   *  the chip tooltip; `null` is rendered as "(unknown time)". */
  generatedAt: string | null | undefined;
  /** Optional resolved magic-text from the parent generator cell's source
   *  (first non-blank line, raw — the renderer truncates). When omitted we
   *  fall back to the shortened generator cellId. The kernel does NOT
   *  currently resolve this field; resolution sits with the renderer host
   *  (run-renderer.ts). */
  generatorMagicText?: string | null;
}

/** CSS classes the chip emits. Exported so tests can assert structure
 *  without coupling to inline string literals. */
export const PROVENANCE_CHIP_CLASS = 'rts-provenance-chip';
export const PROVENANCE_CHIP_BUTTON_CLASS = 'rts-provenance-chip-button';

/** Data-* action key the click handler dispatches on. Distinct from
 *  contamination-badge's `data-rts-reset-contamination` so the same root
 *  click handler can route either intent without ambiguity. */
export const REVEAL_DATA_ATTR = 'data-rts-reveal-cell';

/** Visible chip prefix. The leading `↪` (right-arrow-with-hook) signals
 *  "from elsewhere" / provenance link. */
export const PROVENANCE_CHIP_PREFIX = '↪';

/** Maximum characters of the generator magic text to surface in the chip
 *  before truncation with ellipsis. Per PLAN-S5.0.2 §3.2 (40 chars). */
export const GENERATOR_TEXT_MAX_CHARS = 40;

/** Length of the short-id prefix taken from `generated_by` per PLAN-S5.0.2
 *  §3.2 (6 chars: enough to disambiguate in a notebook with <~16M cells). */
export const SHORT_ID_LEN = 6;

/** Trim a string to `max` characters with an ellipsis. Pure helper. */
function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Extract the first non-blank line of a cell source. Returns `''` when
 *  the input is empty/all-blank. Pure helper exported for tests. */
export function firstNonBlankLine(source: string | null | undefined): string {
  if (typeof source !== 'string' || source.length === 0) return '';
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Format the chip body text per PLAN-S5.0.2 §3.2. Pure helper exported
 *  for tests so they can assert on the text without parsing HTML. */
export function formatProvenanceChipText(
  generatorMagicText: string | null | undefined,
  generatedBy: string
): string {
  const shortId = generatedBy.slice(0, SHORT_ID_LEN);
  const trimmed = (generatorMagicText ?? '').trim();
  if (trimmed.length === 0) {
    // Fallback — no parent text resolved (renderer surface limitation,
    // see file header). Surface only the short id so the operator still
    // has a click target.
    return `${PROVENANCE_CHIP_PREFIX} from c_${shortId}`;
  }
  const text = truncate(trimmed, GENERATOR_TEXT_MAX_CHARS);
  return `${PROVENANCE_CHIP_PREFIX} from \`${text}\` in c_${shortId}`;
}

/** Format the chip tooltip per PLAN-S5.0.2 §3.2. Pure helper. */
export function formatProvenanceChipTooltip(
  generatedAt: string | null | undefined
): string {
  const ts = typeof generatedAt === 'string' && generatedAt.length > 0
    ? generatedAt
    : '(unknown time)';
  return `Generated at ${ts}. Click to jump to source.`;
}

/** Pure HTML render. Returns `''` when the cell has no provenance so the
 *  caller can unconditionally interpolate without an if-guard. */
export function renderProvenanceChip(props: ProvenanceChipProps): string {
  const generatedBy = typeof props.generatedBy === 'string'
    ? props.generatedBy
    : '';
  if (generatedBy.length === 0) {
    return '';
  }
  const text = formatProvenanceChipText(props.generatorMagicText, generatedBy);
  const tooltip = formatProvenanceChipTooltip(props.generatedAt);
  // Inline styles use VS Code CSS variables for theme-correctness; the
  // chip is intentionally subtle (description foreground over editor
  // background) so it never competes visually with the contamination
  // badge that may render directly below it.
  return `
<div class="${PROVENANCE_CHIP_CLASS}" data-rts-cell-id="${escapeAttr(props.cellId)}">
  <button type="button"
          class="${PROVENANCE_CHIP_BUTTON_CLASS}"
          ${REVEAL_DATA_ATTR}="${escapeAttr(generatedBy)}"
          title="${escapeAttr(tooltip)}"
          aria-label="${escapeAttr(tooltip)}"
          style="background:var(--vscode-editorWidget-background,#252526);
                 color:var(--vscode-descriptionForeground,#9d9d9d);
                 border:1px solid var(--vscode-panel-border,#444);
                 padding:2px 8px;border-radius:3px;cursor:pointer;
                 font-family:var(--vscode-font-family,sans-serif);
                 font-size:var(--vscode-font-size,12px);">
    ${escapeHtml(text)}
  </button>
</div>`;
}

/** Wire the click handler for the chip onto a root element that contains
 *  one or more rendered chips. The host (renderer-host bridge) provides
 *  the `dispatchCommand` callback which forwards `{cellId}` to VS Code via
 *  `vscode.commands.executeCommand('llmnb.revealCell', {cellId})`.
 *
 *  Tests call `bindProvenanceChipHandlers` directly with a stub
 *  `dispatchCommand` to assert the dispatched payload. */
export function bindProvenanceChipHandlers(
  root: { addEventListener: (t: string, h: (ev: Event) => void) => void },
  dispatchCommand: (command: string, payload: { cellId: string }) => void
): void {
  if (typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (ev: Event) => {
    const tgt = (ev as { target?: unknown }).target;
    if (!tgt || typeof (tgt as { getAttribute?: unknown }).getAttribute !== 'function') {
      return;
    }
    const el = tgt as { getAttribute: (n: string) => string | null; closest?: (s: string) => unknown };
    const owning =
      typeof el.closest === 'function'
        ? (el.closest(`[${REVEAL_DATA_ATTR}]`) as { getAttribute: (n: string) => string | null } | null)
        : (el.getAttribute(REVEAL_DATA_ATTR) ? el : null);
    if (!owning) return;
    const cellId = owning.getAttribute(REVEAL_DATA_ATTR);
    if (typeof cellId === 'string' && cellId.length > 0) {
      dispatchCommand('llmnb.revealCell', { cellId });
    }
  });
}
