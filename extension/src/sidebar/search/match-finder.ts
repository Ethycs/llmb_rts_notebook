// PLAN-S10 search — the host-side match finder.
//
// Pure functions (modulo reading cell content via getSearchableText).
// Given a notebook + selected cell indices + options, returns a
// flat `Match[]` plus a `total` count and a `truncated` flag.
//
// FSP-002 §3 semantics:
//   - Default: plain substring, case-insensitive.
//   - `caseSensitive: true` flips the comparison.
//   - `wholeWord: true` boundaries each match with `\b` (added to the
//     compiled pattern; plain substring is converted to a regex).
//   - `regex: true` interprets `query` as JavaScript RegExp. Invalid
//     patterns surface as `error: "search_regex_invalid"`.
//   - Excludes blob bodies — handled by scope.ts (only blob references
//     pass through, not resolved bodies).

import * as vscode from 'vscode';
import {
  MAX_DISPLAYED_MATCHES,
  SNIPPET_HALF_WIDTH,
  type Match,
  type SearchOptions,
  type SearchScope,
  type SearchResultsMessage
} from './types.js';
import { getSearchableText } from './scope.js';
import { candidateCellIds } from '../../notebook/contamination-badge.js';

/** Cap on matches per cell so a runaway regex on a huge cell doesn't
 *  block the host. The webview already caps the total at
 *  MAX_DISPLAYED_MATCHES; this is a defensive inner bound. */
const PER_CELL_MATCH_CAP = 250;

/** Build the regex used for matching from the user's options.
 *  Returns `undefined` if the query is empty or the compiled pattern
 *  is invalid (caller surfaces F70). */
export function buildSearchRegex(
  options: SearchOptions
): { regex: RegExp; error?: undefined } | { regex?: undefined; error: string } | { regex?: undefined; error?: undefined } {
  const { query } = options;
  if (!query) return {}; // empty query: no error, no regex
  let pattern: string;
  if (options.regex) {
    pattern = query;
  } else {
    pattern = escapeRegexLiterals(query);
  }
  if (options.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  const flags = `${options.caseSensitive ? '' : 'i'}g`;
  try {
    return { regex: new RegExp(pattern, flags) };
  } catch (err) {
    return { error: `search_regex_invalid: ${(err as Error).message}` };
  }
}

/** Escape regex metacharacters so plain-substring search behaves
 *  predictably. Mirrors the standard JS pattern used by VS Code's
 *  own find widget. */
export function escapeRegexLiterals(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Top-level entry point — exported for tests + the provider. */
export function findMatches(
  notebook: vscode.NotebookDocument | undefined,
  selectedCellIndices: ReadonlySet<number>,
  options: SearchOptions
): SearchResultsMessage {
  if (!notebook) {
    return { type: 'results', matches: [], total: 0, truncated: false };
  }
  const built = buildSearchRegex(options);
  if ('error' in built && built.error) {
    return {
      type: 'results',
      matches: [],
      total: 0,
      truncated: false,
      error: built.error
    };
  }
  if (!built.regex) {
    return { type: 'results', matches: [], total: 0, truncated: false };
  }
  const matches: Match[] = [];
  let total = 0;
  const cells = notebook.getCells();
  for (let i = 0; i < cells.length; i += 1) {
    if (options.scope === 'selected' && !selectedCellIndices.has(i)) continue;
    const cell = cells[i];
    const text = getSearchableText(cell, options.scope);
    if (!text) continue;
    const cellMatches = findMatchesInText(text, built.regex);
    total += cellMatches.length;
    // Index hop only for the actual returned set — total counts all.
    const cellId = primaryCellId(cell);
    for (const m of cellMatches) {
      if (matches.length >= MAX_DISPLAYED_MATCHES) break;
      matches.push({
        cellIndex: i,
        cellId,
        scope: scopeLabel(options.scope, m.kind),
        snippet: m.snippet,
        matchStart: m.matchStart,
        matchEnd: m.matchEnd
      });
    }
    if (matches.length >= MAX_DISPLAYED_MATCHES) {
      // Continue counting `total` even after the cap so the operator
      // sees an honest "M of N" number.
      // The cell loop continues but stops appending matches.
    }
  }
  return {
    type: 'results',
    matches,
    total,
    truncated: total > matches.length
  };
}

/** Per-cell scanner. Caps at PER_CELL_MATCH_CAP. */
interface RawMatch {
  matchStart: number;
  matchEnd: number;
  snippet: string;
  kind: 'in-text';
}

function findMatchesInText(text: string, regex: RegExp): RawMatch[] {
  const out: RawMatch[] = [];
  // Defensive copy — global regexes carry `lastIndex` state. Resetting
  // here avoids any cross-call drift if the same RegExp instance is
  // (accidentally) reused.
  regex.lastIndex = 0;
  let safety = 0;
  while (out.length < PER_CELL_MATCH_CAP) {
    const m = regex.exec(text);
    if (m === null) break;
    const start = m.index;
    const end = start + m[0].length;
    // Avoid infinite loops on zero-width matches (regex with `*` etc).
    if (m[0].length === 0) {
      regex.lastIndex = end + 1;
    }
    out.push(extractSnippet(text, start, end));
    safety += 1;
    if (safety > PER_CELL_MATCH_CAP * 4) break;
  }
  return out;
}

function extractSnippet(text: string, matchStart: number, matchEnd: number): RawMatch {
  const snippetStart = Math.max(0, matchStart - SNIPPET_HALF_WIDTH);
  const snippetEnd = Math.min(text.length, matchEnd + SNIPPET_HALF_WIDTH);
  const raw = text.slice(snippetStart, snippetEnd).replace(/[\r\n\t]+/g, ' ');
  // Compress whitespace so the snippet is a single-line preview.
  const compressed = raw.replace(/\s{2,}/g, ' ');
  // Adjust the match offsets to point into the (potentially-compressed)
  // snippet. Worst case: the compression shifted offsets; we re-locate
  // the match in the snippet via indexOf. If we can't find it
  // (extremely degenerate input), fall back to the raw offsets.
  const offsetInRaw = matchStart - snippetStart;
  const matchText = text.slice(matchStart, matchEnd);
  const localIndex = compressed.indexOf(matchText, Math.max(0, offsetInRaw - 4));
  if (localIndex >= 0) {
    return {
      kind: 'in-text',
      snippet: compressed,
      matchStart: localIndex,
      matchEnd: localIndex + matchText.length
    };
  }
  return {
    kind: 'in-text',
    snippet: compressed,
    matchStart: Math.max(0, offsetInRaw),
    matchEnd: Math.min(compressed.length, offsetInRaw + (matchEnd - matchStart))
  };
}

/** The scope label we ship with each match is the operator's requested
 *  scope (so the UI can group / filter). For `selected` we still return
 *  `selected` because that's the scope the operator chose — the cell-
 *  iteration above already filters down. */
function scopeLabel(requested: SearchScope, _kind: string): SearchScope {
  return requested;
}

/** Pick the canonical cell id for click-to-reveal (`llmnb.revealCell`).
 *  Matches the priority order `candidateCellIds` uses. */
function primaryCellId(cell: vscode.NotebookCell): string {
  const ids = candidateCellIds(cell);
  return ids[0];
}
