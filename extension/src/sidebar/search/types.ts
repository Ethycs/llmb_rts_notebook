// PLAN-S10 (sidebar search follow-on) — shared types for the WebviewView
// search UI and the host-side match finder.
//
// Mirrors the FSP-002 §2.1 surface as far as the public VS Code API
// allows. The "floating above the editor" position is replaced with
// a sidebar WebviewView; everything else (M-of-N counter, scope
// filter, regex toggle, case / whole-word toggles, click-to-reveal)
// matches the FSP-002 spec verbatim.

/** The four FSP-002 scopes plus `selected` (cells currently selected
 *  in the active editor). `selected` is filtered at the host side
 *  before the match-finder runs. */
export type SearchScope = 'all' | 'inputs' | 'outputs' | 'tool_calls' | 'selected';

/** All FSP-002 §3 search semantics flags. */
export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: SearchScope;
}

/** One hit returned to the webview. `cellId` is the canonical id the
 *  webview hands back via `navigate` — the host resolves it through
 *  `llmnb.revealCell` (PLAN-S5.0.2 §3.2).
 *
 *  `snippet` is a short context window around the hit so the operator
 *  sees enough to disambiguate. `matchStart`/`matchEnd` are char
 *  offsets *within the snippet* (not the original document), letting
 *  the webview render the hit with bold without re-running the regex. */
export interface Match {
  cellIndex: number;
  cellId: string;
  scope: SearchScope;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

/** Host → webview: posted on every search-options change after the
 *  host has run the match finder. `total` is the full match count
 *  (we cap displayed matches at MAX_DISPLAYED_MATCHES; `total` lets
 *  the webview render "Showing N of M"). */
export interface SearchResultsMessage {
  type: 'results';
  matches: Match[];
  total: number;
  truncated: boolean;
  /** Surface for FSP-002 F70 invalid-regex. The webview renders this
   *  as a tooltip on the input instead of an empty result set. */
  error?: string;
}

/** Webview → host: search request driven by debounced input. */
export interface SearchRequestMessage {
  type: 'search';
  options: SearchOptions;
}

/** Webview → host: navigate to the cell containing this match. */
export interface NavigateMessage {
  type: 'navigate';
  cellId: string;
}

/** Webview → host: initial bootstrap so the host knows the view is
 *  ready to receive messages. Posted once after DOMContentLoaded. */
export interface ReadyMessage {
  type: 'ready';
}

export type HostToWebviewMessage = SearchResultsMessage;
export type WebviewToHostMessage = SearchRequestMessage | NavigateMessage | ReadyMessage;

/** Cap on how many matches we ship to the webview per search. Keeps
 *  the DOM lightweight on 1000+ cell notebooks. The webview renders
 *  a "(N more not shown)" footer when `truncated` is true. */
export const MAX_DISPLAYED_MATCHES = 500;

/** Half-window size for the snippet around each match (in chars).
 *  Total snippet length is `2 * SNIPPET_HALF_WIDTH + match length`. */
export const SNIPPET_HALF_WIDTH = 40;
