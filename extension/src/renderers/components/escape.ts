// HTML escaping utilities for renderer components.
//
// All renderer components produce HTML strings that are assigned via
// element.innerHTML. Untrusted input (tool args, agent-supplied text) MUST
// be passed through escapeHtml() before interpolation; values used inside
// HTML attributes (id, data-*, value) MUST go through escapeAttr().
//
// Pattern adapted from vendor/vscode-jupyter/src/platform/webviews/ which
// uses similar small string-escape helpers in lieu of pulling in a full
// templating library for renderer bundles.

/** Escape a string so it is safe to embed in HTML element text content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string so it is safe to embed inside a double-quoted HTML
 *  attribute value. Stricter than escapeHtml: also strips C0 control
 *  characters that browsers may interpret inside attributes. */
export function escapeAttr(s: string): string {
  // eslint-disable-next-line no-control-regex
  return escapeHtml(s).replace(/[\x00-\x1f\x7f]/g, '');
}
