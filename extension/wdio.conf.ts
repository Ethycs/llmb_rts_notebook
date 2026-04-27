// WebdriverIO + wdio-vscode-service configuration.
//
// This is the renderer integration layer: a real VS Code Extension Host with
// the llmb extension loaded. Tests under `test/wdio/**/*.ts` will drive the
// notebook UI and assert MIME-renderer output for the 13 RFC-001 tools.
//
// GATING: WebdriverIO downloads a VS Code binary on first run. It is *not*
// invoked by `npm test`. Instead the operator runs a separate task
// (`npm run test:e2e`) so CI workflows can opt in.
//
// Pattern adapted from
//   https://github.com/webdriverio-community/wdio-vscode-service#readme
//   https://webdriver.io/docs/configurationfile/
//
// TODO(T1-renderer): no specs ship with this scaffold yet. Add files under
// `extension/test/wdio/` (e.g. notify.e2e.ts, report-completion.e2e.ts) once
// the renderer-driven assertion harness is online.

import * as path from 'node:path';
import * as url from 'node:url';
import type { Options } from '@wdio/types';

const __filename: string = url.fileURLToPath(import.meta.url);
const __dirname: string = path.dirname(__filename);

/** Absolute path to the extension under test (the directory holding package.json). */
const EXTENSION_PATH: string = __dirname;

export const config: Options.Testrunner = {
  // ---- Test framework ----------------------------------------------------
  runner: 'local',
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000
  },

  // ---- Specs / suites ----------------------------------------------------
  // Paths are TypeScript; ts-node hooks transpile on the fly via
  // tsConfigPath below. The directory ships empty (see test/wdio/.gitkeep).
  specs: ['./test/wdio/**/*.ts'],
  exclude: [],

  // ---- Capabilities ------------------------------------------------------
  // wdio-vscode-service launches one VS Code per capability. Setting the
  // capability `browserName` to `vscode` is what triggers the service.
  capabilities: [
    {
      browserName: 'vscode',
      // Pin to a known-good VS Code stable. `insiders` is also valid.
      browserVersion: 'stable',
      'wdio:vscodeOptions': {
        // Path to the extension folder containing package.json.
        extensionPath: EXTENSION_PATH,
        // Extra workspace to open in the Extension Development Host.
        workspacePath: path.join(EXTENSION_PATH, 'test', 'fixtures', 'workspace'),
        // TODO(T1-renderer): wire this once we publish a v0.x .vsix; for now
        // the dev-mode load via extensionPath is sufficient.
        vscodeArgs: { 'disable-extensions': true }
      }
    }
  ],

  // ---- Services ----------------------------------------------------------
  services: ['vscode'],

  // ---- Reporters / logging ----------------------------------------------
  logLevel: 'info',
  reporters: ['spec'],

  // ---- TypeScript --------------------------------------------------------
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      transpileOnly: true,
      project: path.join(EXTENSION_PATH, 'tsconfig.test.json')
    }
  }
};
