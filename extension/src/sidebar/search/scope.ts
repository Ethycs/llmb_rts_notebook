// PLAN-S10 search — extract the searchable text for a single
// notebook cell under a given scope. Pure helpers; no VS Code
// notebook-document mutation, no async.

import * as vscode from 'vscode';
import type { SearchScope } from './types.js';

/** MIME for the cell-output items that carry OTLP run records
 *  (the renderer side bridges this MIME into `application/vnd.rts.run+json`
 *  per RFC-006 §1). Tool-call args are nested under each span's
 *  `attributes` map. */
const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** Read the input (cell source) text. */
export function getCellInputText(cell: vscode.NotebookCell): string {
  return cell.document.getText();
}

/** Decode an `Uint8Array` of a NotebookCellOutputItem as UTF-8.
 *  Tolerates non-UTF8 by falling back to empty string. */
function decodeItem(item: vscode.NotebookCellOutputItem): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(item.data);
  } catch {
    return '';
  }
}

/** Read all output-text content for a cell. Iterates each output's
 *  items and joins with newlines so search can match across items.
 *  Excludes blob bodies per FSP-002 §3 ("only blob references are
 *  searchable, not the resolved content") — anything looking like a
 *  `$blob:sha256:` sentinel passes through but blob bodies aren't
 *  resolved here. */
export function getCellOutputText(cell: vscode.NotebookCell): string {
  const parts: string[] = [];
  for (const out of cell.outputs) {
    for (const item of out.items) {
      parts.push(decodeItem(item));
    }
  }
  return parts.join('\n');
}

/** Extract tool-call attribute text from a cell's `application/vnd.rts.run+json`
 *  outputs. Walks each OTLP span's `attributes[]` and concatenates
 *  string values into a single searchable blob. Non-JSON or non-span
 *  outputs are skipped. */
export function getCellToolCallText(cell: vscode.NotebookCell): string {
  const parts: string[] = [];
  for (const out of cell.outputs) {
    for (const item of out.items) {
      if (item.mime !== RTS_RUN_MIME) continue;
      const raw = decodeItem(item);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      collectStringAttributeValues(parsed, parts);
    }
  }
  return parts.join('\n');
}

/** Walk an OTLP span (or any tree) for `attributes[].value.stringValue`
 *  and `attributes[].key`. Defensive against arbitrary nested shapes —
 *  the wire format may evolve, but the extraction stays lossy + safe. */
function collectStringAttributeValues(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collectStringAttributeValues(v, out);
    return;
  }
  // OTLP attribute pair shape: { key, value: { stringValue: "..." } }
  const obj = node as Record<string, unknown>;
  const key = obj['key'];
  const valueWrap = obj['value'];
  if (
    typeof key === 'string' &&
    valueWrap &&
    typeof valueWrap === 'object' &&
    typeof (valueWrap as { stringValue?: unknown }).stringValue === 'string'
  ) {
    out.push((valueWrap as { stringValue: string }).stringValue);
    return;
  }
  for (const v of Object.values(obj)) collectStringAttributeValues(v, out);
}

/** Top-level dispatcher — returns the searchable text union for a
 *  cell under the given scope. The `selected` scope is handled at
 *  the host level (caller filters the cell list); this function
 *  treats it as `all` for any cell that does get passed in. */
export function getSearchableText(
  cell: vscode.NotebookCell,
  scope: SearchScope
): string {
  switch (scope) {
    case 'inputs':
      return getCellInputText(cell);
    case 'outputs':
      return getCellOutputText(cell);
    case 'tool_calls':
      return getCellToolCallText(cell);
    case 'all':
    case 'selected':
    default:
      return [
        getCellInputText(cell),
        getCellOutputText(cell),
        getCellToolCallText(cell)
      ]
        .filter((s) => s.length > 0)
        .join('\n');
  }
}
