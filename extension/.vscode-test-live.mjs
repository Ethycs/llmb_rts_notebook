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
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// FSP-003 Pillar C live tier — PATH bootstrapping.
//
// VS Code's Extension Host (and the kernel subprocess it spawns) inherits
// process.env.PATH from this runner. PowerShell + cmd.exe do NOT inherit
// pixi's env-activation, so a default PowerShell PATH does not include
// .pixi/envs/kernel/. That makes shutil.which("claude") in the kernel
// supervisor return None, and the preflight check (K74 claude CLI on
// PATH) fail-skips all live tests.
//
// Fix: resolve the pixi kernel env's bin directory (Windows: env root;
// POSIX: env/bin) and prepend it to process.env.PATH before vscode-test
// starts the Extension Host. This is the pixi-shell-style activation
// done explicitly so tests work without requiring the operator to have
// run `pixi shell -e kernel` first.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pixiBin = process.platform === 'win32'
  ? path.join(repoRoot, '.pixi', 'envs', 'kernel')
  : path.join(repoRoot, '.pixi', 'envs', 'kernel', 'bin');
if (fs.existsSync(pixiBin)) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH || '';
  if (!currentPath.split(sep).includes(pixiBin)) {
    process.env.PATH = `${pixiBin}${sep}${currentPath}`;
  }
}

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
