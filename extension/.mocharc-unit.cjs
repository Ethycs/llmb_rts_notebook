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

const fs = require('node:fs');
const path = require('node:path');

// FSP-003 Pillar C scaffolding: T0 unit tier exists in tsconfig but no
// tests have been migrated into test/unit/ yet. Until then, the unit
// tier is a no-op — pointing mocha at a missing dir errors on
// "argument 'id' must be a non-empty string". Detect the missing dir
// and feed mocha an empty file pattern that resolves cleanly.
const unitDir = path.join(__dirname, 'out', 'test', 'test', 'unit');
const hasUnitTests =
  fs.existsSync(unitDir) &&
  fs.readdirSync(unitDir).some((f) => f.endsWith('.test.js'));

module.exports = {
  spec: hasUnitTests
    ? ['out/test/test/unit/**/*.test.js']
    : [path.join(__dirname, '.mocharc-unit.empty-suite.js')],
  ui: 'tdd',
  reporter: 'spec',
  timeout: 5000,
  color: true,
  recursive: true
};
