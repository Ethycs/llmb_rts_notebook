// PLAN-S5.0.1 §3.8 — contamination badge component.
//
// A small DOM chip rendered above a cell's regular run output when the cell
// carries `metadata.rts.cells[<id>].contaminated == true` (Layer 1 detector
// in vendor/LLMKernel sets this on agent output that contains a magic-name
// pattern). Visual: amber warning chip with text
//   `⚠ Contamination detected (N entries)`
// where N = `contamination_log.length`.
//
// Click expands a panel that lists each log entry (`line`, `source`, `ts`,
// `layer`) and surfaces a `Reset` button. The reset click dispatches the
// `llmnb.resetContamination` VS Code command via the renderer's host
// post-message bridge — `reset-contamination.ts` registers the handler and
// emits the operator-action envelope to the kernel. Only the explicit
// operator-action path flips the flag false (PLAN-S5.0.1 §3.10 K3F).
//
// This file is bundled into the renderer webview (run-renderer.ts), so it
// exports a pure-string HTML render plus a thin click-binding helper. No
// VS Code imports allowed here.

import { escapeHtml, escapeAttr } from './escape.js';

/** PLAN-S5.0.1 §3.8 — one entry of `cells[<id>].contamination_log`. */
export interface ContaminationLogEntry {
  /** The offending agent/tool output line (verbatim). */
  line: string;
  /** Which output stream the line came from (`stdout`, `stderr`,
   *  `tool_result`, …). */
  source: string;
  /** ISO8601 timestamp the detector emitted the entry. */
  ts: string;
  /** Detector layer that flagged the line. PLAN-S5.0.1 calls out two:
   *  `always_on_plain` (plain magic name in body) and `hash_emission_ban`
   *  (hashed-magic pattern in agent output). Forward-compat: any string. */
  layer: string;
}

/** Information needed to render the badge for one cell. The renderer host
 *  (see run-renderer.ts) extracts this from the cell's `metadata.rts.cells`
 *  slot and hands it to `renderContaminationBadge`. */
export interface ContaminationBadgeProps {
  /** Stable cell identifier (the kernel uses `cell.id`; the extension
   *  treats `cell.document.uri.toString()` as the operator-side key. The
   *  reset-contamination command accepts either; we ship whatever the host
   *  resolves at render time). */
  cellId: string;
  /** Whether the cell is currently flagged. When false, the renderer SHOULD
   *  NOT include the badge at all (the function returns the empty string). */
  contaminated: boolean;
  /** Append-only audit log of contamination events. Length drives the chip
   *  count; entries populate the expanded panel rows. */
  contamination_log: ContaminationLogEntry[];
}

/** CSS classes the badge emits. Exported so tests can assert structure
 *  without coupling to inline string literals. */
export const CONTAMINATION_BADGE_CLASS = 'rts-contamination-badge';
export const CONTAMINATION_PANEL_CLASS = 'rts-contamination-panel';
export const CONTAMINATION_RESET_BUTTON_CLASS = 'rts-contamination-reset';

/** Data-* action key the click handler dispatches on. The shared
 *  run-renderer.ts delegated handler routes any `data-rts-action` click to
 *  the host's operator-action sink; for the reset button we instead want
 *  the host to invoke a VS Code command, so we use a distinct attribute
 *  (`data-rts-cmd`) recognized by `bindContaminationBadgeHandlers`. */
export const RESET_DATA_ATTR = 'data-rts-reset-contamination';

/** Pure HTML render. Returns `''` when the cell is not contaminated so the
 *  caller can unconditionally interpolate without an if-guard. */
export function renderContaminationBadge(props: ContaminationBadgeProps): string {
  if (!props.contaminated) {
    return '';
  }
  const entries = Array.isArray(props.contamination_log) ? props.contamination_log : [];
  const n = entries.length;
  const headerId = `rts-cont-${props.cellId}-header`;
  const panelId = `rts-cont-${props.cellId}-panel`;
  const rows = entries.map((e) => `
    <tr>
      <td class="rts-cont-ts">${escapeHtml(e.ts ?? '')}</td>
      <td class="rts-cont-source">${escapeHtml(e.source ?? '')}</td>
      <td class="rts-cont-layer">${escapeHtml(e.layer ?? '')}</td>
      <td class="rts-cont-line"><code>${escapeHtml(e.line ?? '')}</code></td>
    </tr>`).join('');
  // Inline styles for amber/warning palette: we DON'T own styles.css from
  // here (it's a renderer-bundle resource), so colors are inlined with the
  // documented VS Code CSS variables for theme-correctness.
  return `
<div class="${CONTAMINATION_BADGE_CLASS}" data-rts-cell-id="${escapeAttr(props.cellId)}">
  <button type="button"
          class="rts-contamination-chip"
          id="${escapeAttr(headerId)}"
          data-rts-toggle="${escapeAttr(panelId)}"
          aria-controls="${escapeAttr(panelId)}"
          aria-expanded="false"
          style="background:var(--vscode-inputValidation-warningBackground,#5a3e00);
                 color:var(--vscode-inputValidation-warningForeground,#ffd966);
                 border:1px solid var(--vscode-inputValidation-warningBorder,#b8860b);
                 padding:4px 10px;border-radius:3px;cursor:pointer;
                 font-family:var(--vscode-font-family,sans-serif);
                 font-size:var(--vscode-font-size,13px);">
    &#9888; Contamination detected (${n} ${n === 1 ? 'entry' : 'entries'})
  </button>
  <div class="${CONTAMINATION_PANEL_CLASS}"
       id="${escapeAttr(panelId)}"
       hidden
       style="margin-top:6px;padding:8px;
              background:var(--vscode-editor-background,#1e1e1e);
              color:var(--vscode-foreground,#cccccc);
              border:1px solid var(--vscode-panel-border,#444);
              border-radius:3px;">
    <table class="rts-contamination-table" style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--vscode-panel-border,#444);">
          <th style="padding:2px 6px;">Time</th>
          <th style="padding:2px 6px;">Source</th>
          <th style="padding:2px 6px;">Layer</th>
          <th style="padding:2px 6px;">Line</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:8px;display:flex;justify-content:flex-end;">
      <button type="button"
              class="${CONTAMINATION_RESET_BUTTON_CLASS}"
              ${RESET_DATA_ATTR}="${escapeAttr(props.cellId)}"
              style="padding:4px 10px;border-radius:3px;cursor:pointer;
                     background:var(--vscode-button-background,#0e639c);
                     color:var(--vscode-button-foreground,#ffffff);
                     border:1px solid var(--vscode-button-border,transparent);">
        Reset contamination
      </button>
    </div>
  </div>
</div>`;
}

/** Wire the click handler for the reset button onto a root element that
 *  contains a rendered badge. The host (renderer-host bridge) provides the
 *  `dispatchCommand` callback which forwards `{cellId}` to VS Code via
 *  `vscode.commands.executeCommand('llmnb.resetContamination', {cellId})`.
 *
 *  Tests call `bindContaminationBadgeHandlers` directly with a stub
 *  `dispatchCommand` to assert the dispatched payload. */
export function bindContaminationBadgeHandlers(
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
    // The button or any descendant: find the closest element carrying the
    // reset attribute.
    const owning =
      typeof el.closest === 'function'
        ? (el.closest(`[${RESET_DATA_ATTR}]`) as { getAttribute: (n: string) => string | null } | null)
        : (el.getAttribute(RESET_DATA_ATTR) ? el : null);
    if (!owning) return;
    const cellId = owning.getAttribute(RESET_DATA_ATTR);
    if (typeof cellId === 'string' && cellId.length > 0) {
      dispatchCommand('llmnb.resetContamination', { cellId });
    }
  });
}
