// PLAN-S10 sidebar-search follow-on — match-finder contract tests.
//
// Pure-unit-tier-style tests that open small notebooks via
// vscode.workspace.openNotebookDocument and exercise the match-finder
// against them. Covers FSP-002 §3 semantics: default plain-substring
// case-insensitive, case toggle, whole-word, regex, scope filters,
// F70 invalid regex, snippet extraction, and the cap behaviour.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  buildSearchRegex,
  escapeRegexLiterals,
  findMatches
} from '../../src/sidebar/search/match-finder.js';
import type { SearchOptions } from '../../src/sidebar/search/types.js';

const NOTEBOOK_TYPE = 'llmnb';

function defaultOptions(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: 'all',
    ...overrides
  };
}

async function notebookWithCells(
  cells: Array<{ value: string; kind?: vscode.NotebookCellKind }>
): Promise<vscode.NotebookDocument> {
  const data = new vscode.NotebookData(
    cells.map((c) => {
      const kind = c.kind ?? vscode.NotebookCellKind.Code;
      return new vscode.NotebookCellData(
        kind,
        c.value,
        kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'llmnb-cell'
      );
    })
  );
  return vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
}

suite('contract: PLAN-S10 sidebar-search match-finder', () => {
  test('default plain-substring search is case-insensitive', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: '@@spawn Alpha task:"build a WIDGET"' },
      { value: '@alpha: this cell holds nothing relevant' }
    ]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'widget' })
    );
    assert.equal(out.total, 1);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].cellIndex, 0);
    // Snippet shows the matched text in the snippet window.
    assert.ok(out.matches[0].snippet.toLowerCase().includes('widget'));
  });

  test('caseSensitive toggle excludes lowercase matches', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'lower case match here' },
      { value: 'UPPER case MATCH here' }
    ]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'MATCH', caseSensitive: true })
    );
    assert.equal(out.total, 1);
    assert.equal(out.matches[0].cellIndex, 1);
  });

  test('wholeWord toggle boundaries the search', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'cat catalog scattered' },
      { value: 'cat alone' }
    ]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'cat', wholeWord: true })
    );
    // cat in cell 0 + cat in cell 1 = 2. catalog / scattered excluded.
    assert.equal(out.total, 2);
    const cellIndices = out.matches.map((m) => m.cellIndex).sort();
    assert.deepEqual(cellIndices, [0, 1]);
  });

  test('regex mode interprets the query as JS RegExp', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([{ value: 'order_id=42 order_id=99 other=1' }]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'order_id=\\d+', regex: true })
    );
    assert.equal(out.total, 2);
  });

  test('regex mode surfaces F70 invalid-regex via the error field', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([{ value: 'irrelevant' }]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: '[unterminated', regex: true })
    );
    assert.equal(out.matches.length, 0);
    assert.ok(out.error);
    assert.ok(out.error!.startsWith('search_regex_invalid'));
  });

  test('inputs scope only searches cell source text', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'directive: SEARCH-ME', kind: vscode.NotebookCellKind.Code },
      { value: '# markdown SEARCH-ME header', kind: vscode.NotebookCellKind.Markup }
    ]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'SEARCH-ME', scope: 'inputs' })
    );
    assert.equal(out.total, 2, 'both cells have the term in their source');
  });

  test('selected scope only considers selected cell indices', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'alpha pattern here' },
      { value: 'beta pattern here' },
      { value: 'gamma pattern here' }
    ]);
    const out = findMatches(
      nb,
      new Set([1]),
      defaultOptions({ query: 'pattern', scope: 'selected' })
    );
    assert.equal(out.total, 1);
    assert.equal(out.matches[0].cellIndex, 1);
  });

  test('returns empty result for empty query (no error)', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([{ value: 'something' }]);
    const out = findMatches(nb, new Set(), defaultOptions({ query: '' }));
    assert.equal(out.total, 0);
    assert.equal(out.matches.length, 0);
    assert.equal(out.error, undefined);
  });

  test('returns empty result when no active notebook is supplied', () => {
    const out = findMatches(undefined, new Set(), defaultOptions({ query: 'x' }));
    assert.equal(out.total, 0);
    assert.equal(out.matches.length, 0);
    assert.equal(out.truncated, false);
  });

  test('matches across multiple cells preserve cellIndex order', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'first cell with TERM' },
      { value: 'second cell with TERM' },
      { value: 'third cell with TERM' }
    ]);
    const out = findMatches(nb, new Set(), defaultOptions({ query: 'TERM' }));
    assert.equal(out.total, 3);
    assert.deepEqual(out.matches.map((m) => m.cellIndex), [0, 1, 2]);
  });

  test('snippet matchStart/matchEnd index into the snippet string', async function (): Promise<void> {
    this.timeout(15000);
    const nb = await notebookWithCells([
      { value: 'a very long preamble before the keyword and a trailing tail' }
    ]);
    const out = findMatches(
      nb,
      new Set(),
      defaultOptions({ query: 'keyword' })
    );
    assert.equal(out.matches.length, 1);
    const m = out.matches[0];
    const slice = m.snippet.slice(m.matchStart, m.matchEnd);
    assert.equal(slice.toLowerCase(), 'keyword');
  });

  test('buildSearchRegex escapes literals when regex flag is off', () => {
    const built = buildSearchRegex(defaultOptions({ query: 'a.b*c', regex: false }));
    assert.ok('regex' in built && built.regex);
    // 'a.b*c' should NOT match 'aXbZZZc' when regex is off.
    assert.equal('aXbZZZc'.match(built.regex!), null);
    assert.notEqual('a.b*c'.match(built.regex!), null);
  });

  test('escapeRegexLiterals escapes meta characters', () => {
    assert.equal(escapeRegexLiterals('a.b*c'), 'a\\.b\\*c');
    assert.equal(escapeRegexLiterals('[]()'), '\\[\\]\\(\\)');
  });

  test('whole-word + regex composes correctly', () => {
    const built = buildSearchRegex(
      defaultOptions({ query: 'cat', wholeWord: true, regex: true })
    );
    assert.ok('regex' in built && built.regex);
    assert.notEqual('the cat sat'.match(built.regex!), null);
    assert.equal('catastrophe'.match(built.regex!), null);
  });
});
