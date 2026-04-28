// FSP-003 Pillar C — T0 unit tier mocharc.
//
// Pure-module tests (no VS Code, no kernel, no I/O). Runs via mocha CLI
// against compiled JS under `out/test/test/unit/**`. Tests that need
// the VS Code extension host live under T2 (test:stub) instead; tests
// that need a real Pixi kernel live under T3 (test:live).
//
// Cadence: every commit; budget <5s. No `vscode` import allowed in
// these tests — the unit tier runs without an Extension Host so any
// `require('vscode')` would throw `Cannot find module 'vscode'`.

'use strict';

module.exports = {
  // Compiled JS only — tsconfig.test.json emits to out/test.
  spec: ['out/test/test/unit/**/*.test.js'],
  ui: 'tdd',
  reporter: 'spec',
  timeout: 5000,
  color: true,
  // FSP-003 §4 — unit tier MUST NOT exceed 5s total. Mocha doesn't have
  // a native suite-level deadline; the per-test 5s timeout above plus
  // the absence of I/O work here keeps total runtime in budget.
  recursive: true,
  // Require nothing — unit tests have zero ambient dependencies.
  require: []
};
