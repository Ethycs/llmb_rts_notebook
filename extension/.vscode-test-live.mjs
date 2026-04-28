// FSP-003 Pillar C — T3 live-e2e tier config.
//
// Real VS Code, real Pixi-managed Python kernel via PtyKernelClient,
// real Claude CLI subprocess. Opt-in via `npm run test:live` — the
// default commit-time `test:contract` does NOT include this tier.
//
// Preflight (`preflightLive` from extension/test/util/preflight.ts) is
// the gate: the suite skips with a one-line cause + remediation
// pointer if the pixi env is missing, the claude CLI isn't on PATH,
// no Anthropic credentials are present, or an orphan kernel is
// holding a session id.
//
// Isolation: dedicated user-data-dir so the live tier can run
// alongside the stub tier (separate VS Code install state).
//
// Cadence: manual + nightly; budget <60s per FSP-003 Pillar C.

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // T3 selection: e2e suite only. Contract + integration are covered
  // in T2; running them again here would just inflate the live tier's
  // wall-clock and Anthropic-API spend.
  files: ['out/test/test/e2e/**/*.test.js'],
  workspaceFolder: './test/fixtures/workspace',
  extensionDevelopmentPath: '.',
  launchArgs: ['--user-data-dir=.vscode-test/userdata-live'],
  mocha: {
    ui: 'tdd',
    timeout: 180000,
    reporter: 'spec',
    color: true
  }
});
