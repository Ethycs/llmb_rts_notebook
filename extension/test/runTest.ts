// Legacy @vscode/test-electron runner.
//
// `@vscode/test-cli` (configured via `.vscode-test.mjs`) is the primary
// entry-point for CI. This script is the lower-level alternative for callers
// that need finer control over the Electron download / launch arguments
// (e.g. running against a specific VS Code version, passing extra
// `--disable-extensions`, or wiring up a custom user-data-dir).
//
// Pattern adapted from the @vscode/test-electron README:
//   https://github.com/microsoft/vscode-test#readme
// and the canonical sample at
//   https://github.com/microsoft/vscode-extension-samples/blob/main/helloworld-test-sample/src/test/runTest.ts

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// CJS test build — __filename and __dirname are Node globals.

async function main(): Promise<void> {
  try {
    // The folder containing the extension's package.json.
    // After compile this file lives at `extension/out/test/test/runTest.js`
    // (rootDir is `extension/`, outDir is `out/test`), so go up three levels:
    //   out/test/test -> out/test -> out -> extension/
    const extensionDevelopmentPath: string = path.resolve(__dirname, '..', '..', '..');

    // The path to the compiled Mocha runner (out/test/test/suite/index.js).
    const extensionTestsPath: string = path.resolve(__dirname, 'suite', 'index');

    // Open the fixture workspace so the test can resolve a `.llmnb` document.
    const workspacePath: string = path.resolve(
      extensionDevelopmentPath,
      'test',
      'fixtures',
      'workspace'
    );

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        // Avoid 3rd-party extension noise during the test run.
        '--disable-extensions'
      ]
    });
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error('[runTest] Failed to run tests:', err);
    process.exit(1);
  }
}

void main();
