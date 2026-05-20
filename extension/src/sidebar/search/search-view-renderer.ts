/// <reference lib="dom" />
//
// PLAN-S10 sidebar-search WebviewView — webview-side renderer.
//
// Runs inside the WebviewView iframe. Owns:
//   - The toolbar (query input, scope select, case / word / regex toggles).
//   - The results list (renders matches, supports prev/next + click-reveal).
//   - The 200ms input debounce per FSP-002 §3.
//   - Keyboard bindings (Enter / Shift+Enter / Esc).
//
// Wire shape mirrors `extension/src/sidebar/search/types.ts`.

import type {
  HostToWebviewMessage,
  Match,
  SearchOptions,
  SearchScope,
  WebviewToHostMessage
} from './types.js';

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const DEBOUNCE_MS = 200;

const $ = <T extends Element>(id: string): T => {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`missing DOM element #${id}`);
  return el;
};

const queryInput = $<HTMLInputElement>('query');
const scopeSelect = $<HTMLSelectElement>('scope');
const caseBtn = $<HTMLButtonElement>('toggle-case');
const wordBtn = $<HTMLButtonElement>('toggle-word');
const regexBtn = $<HTMLButtonElement>('toggle-regex');
const prevBtn = $<HTMLButtonElement>('prev');
const nextBtn = $<HTMLButtonElement>('next');
const counterEl = $<HTMLSpanElement>('counter');
const resultsEl = $<HTMLUListElement>('results');
const truncatedEl = $<HTMLDivElement>('truncated');

interface RendererState {
  matches: Match[];
  active: number;
  total: number;
  truncated: boolean;
  error: string | undefined;
}

const state: RendererState = {
  matches: [],
  active: 0,
  total: 0,
  truncated: false,
  error: undefined
};

let debounceTimer: number | undefined;

function readOptions(): SearchOptions {
  return {
    query: queryInput.value,
    caseSensitive: caseBtn.getAttribute('aria-pressed') === 'true',
    wholeWord: wordBtn.getAttribute('aria-pressed') === 'true',
    regex: regexBtn.getAttribute('aria-pressed') === 'true',
    scope: scopeSelect.value as SearchScope
  };
}

function postSearch(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    vscode.postMessage({ type: 'search', options: readOptions() });
  }, DEBOUNCE_MS);
}

function toggleButton(btn: HTMLButtonElement): void {
  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', next ? 'true' : 'false');
  postSearch();
}

caseBtn.addEventListener('click', () => toggleButton(caseBtn));
wordBtn.addEventListener('click', () => toggleButton(wordBtn));
regexBtn.addEventListener('click', () => toggleButton(regexBtn));
scopeSelect.addEventListener('change', () => postSearch());
queryInput.addEventListener('input', () => postSearch());

queryInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      navigateBy(-1);
    } else {
      navigateBy(1);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    queryInput.value = '';
    postSearch();
  }
});

prevBtn.addEventListener('click', () => navigateBy(-1));
nextBtn.addEventListener('click', () => navigateBy(1));

function navigateBy(delta: number): void {
  if (state.matches.length === 0) return;
  const n = state.matches.length;
  state.active = ((state.active + delta) % n + n) % n;
  render();
  revealActive();
}

function revealActive(): void {
  const m = state.matches[state.active];
  if (!m) return;
  vscode.postMessage({ type: 'navigate', cellId: m.cellId });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSnippet(m: Match): string {
  const before = escapeHtml(m.snippet.slice(0, m.matchStart));
  const hit = escapeHtml(m.snippet.slice(m.matchStart, m.matchEnd));
  const after = escapeHtml(m.snippet.slice(m.matchEnd));
  return `${before}<mark>${hit}</mark>${after}`;
}

function render(): void {
  // Counter / error styling on the input.
  if (state.error) {
    queryInput.classList.add('error');
    counterEl.classList.add('error');
    counterEl.textContent = 'Invalid pattern';
    queryInput.title = state.error;
  } else {
    queryInput.classList.remove('error');
    counterEl.classList.remove('error');
    queryInput.title = '';
    if (state.total === 0) {
      counterEl.textContent = queryInput.value.length > 0 ? 'No matches' : 'No results';
    } else {
      counterEl.textContent = `${state.active + 1} of ${state.total}`;
    }
  }
  prevBtn.toggleAttribute('disabled', state.matches.length === 0);
  nextBtn.toggleAttribute('disabled', state.matches.length === 0);

  // Results list.
  resultsEl.innerHTML = '';
  if (state.matches.length === 0) {
    if (!state.error && queryInput.value.length > 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No matches.';
      resultsEl.appendChild(empty);
    }
  } else {
    state.matches.forEach((m, i) => {
      const li = document.createElement('li');
      if (i === state.active) li.classList.add('active');
      li.innerHTML =
        `<span class="cell-label">#${m.cellIndex + 1} · ${escapeHtml(m.scope)}</span>` +
        renderSnippet(m);
      li.addEventListener('click', () => {
        state.active = i;
        render();
        revealActive();
      });
      resultsEl.appendChild(li);
    });
  }

  // Truncation footer.
  if (state.truncated) {
    truncatedEl.hidden = false;
    truncatedEl.textContent = `Showing ${state.matches.length} of ${state.total} matches. Refine the query to see the rest.`;
  } else {
    truncatedEl.hidden = true;
    truncatedEl.textContent = '';
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'results') return;
  state.matches = msg.matches;
  state.total = msg.total;
  state.truncated = msg.truncated;
  state.error = msg.error;
  state.active = msg.matches.length > 0 ? 0 : 0;
  render();
});

// Tell the host we're ready and request the initial result (which will
// be an empty set because the input is empty, but it pins the wiring).
vscode.postMessage({ type: 'ready' });
render();
