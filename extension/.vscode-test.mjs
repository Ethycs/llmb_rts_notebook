// @vscode/test-cli configuration for the llmb RTS Notebook extension.
//
// This file is the canonical entry point for the contract + integration test
// layers (see test/README.md). The renderer integration layer (WebdriverIO) is
// configured separately in wdio.conf.ts and is gated on `npm run test:e2e`
// because it downloads a VS Code binary.
//
// The shape and option surface follow the @vscode/test-cli convention; see
//   https://code.visualstudio.com/api/working-with-extensions/testing-extension
//   https://github.com/microsoft/vscode-test-cli#readme
//
// Tests are compiled to `out/test/**` by `tsconfig.test.json`. The existing
// in-src `*.test.ts` files (extension.test.ts, notebook/jupyter-kernel-client.test.ts
// authored under Track C R1 / C R2) are also picked up because tsconfig.test.json
// emits them under `out/test/src/...` after we mirror the src tree on compile.

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // Glob of compiled JS test files. Both the in-src tests and the new
  // contract/integration tests under extension/test/ land here after build.
  files: 'out/test/**/*.test.js',

  // Open VS Code with this fixture workspace so cell execution can resolve
  // a real `.llmnb` document via vscode.workspace.openNotebookDocument().
  workspaceFolder: './test/fixtures/workspace',

  // Path to the extension under test (relative to this config file).
  extensionDevelopmentPath: '.',

  // Mocha options, mirrored in `.mocharc.json` for non-vscode-test invocations.
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    reporter: 'spec',
    color: true
  }
});
