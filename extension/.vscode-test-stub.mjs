// FSP-003 Pillar C — T2 stub-integration tier config.
//
// Loads the real extension into a real VS Code Extension Host but uses
// the StubKernelClient (no live Pixi kernel, no Claude CLI). Tests
// here cover the contract surfaces (router classification, controller
// lifecycle, metadata applier/loader, heartbeat consumer, PTY framing
// against a fake node-pty module) plus the integration smoke that
// activates the extension and executes one stub-emitted cell.
//
// Isolation: dedicated user-data-dir so a parallel stub run never
// collides with the live tier (FSP-003 Pillar C). Live e2e tests
// (`extension/test/e2e/**`) are explicitly excluded — they belong to
// `.vscode-test-live.mjs` (opt-in via `npm run test:live`).
//
// Cadence: every commit; budget <30s.

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // T2 selection: contract + integration + in-src smoke tests, but NOT
  // the live-kernel e2e suite. The pattern excludes files under
  // out/test/test/e2e/ entirely.
  files: [
    'out/test/test/contract/**/*.test.js',
    'out/test/test/integration/**/*.test.js',
    'out/test/src/**/*.test.js'
  ],
  workspaceFolder: './test/fixtures/workspace',
  extensionDevelopmentPath: '.',
  // FSP-003 Pillar C — dedicated user-data-dir so the stub tier can run
  // alongside (or shortly after) the live tier without mutex collisions.
  launchArgs: ['--user-data-dir=.vscode-test/userdata-stub'],
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    reporter: 'spec',
    color: true
  }
});
