// Mocha runner used by `runTest.ts` / @vscode/test-electron.
//
// Discovers compiled `.test.js` files under `out/test/...` and registers them
// with a Mocha instance running in BDD mode. The `@vscode/test-cli` path
// described in `.vscode-test.mjs` does this automatically; this file exists
// for the legacy `runTest.ts` flow only.
//
// Pattern adapted from
//   https://github.com/microsoft/vscode-extension-samples/blob/main/helloworld-test-sample/src/test/suite/index.ts

import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

// CJS test build — __filename and __dirname are Node globals.

/** Recursively collects every file ending in `.test.js` under `root`. */
function collectTestFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) {
    return out;
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        out.push(full);
      }
    }
  }
  return out;
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    reporter: 'spec',
    timeout: 60000
  });

  // Walk both the test/ tree (contract + integration) and the in-src tests
  // (extension.test.ts, notebook/jupyter-kernel-client.test.ts).
  const testRoots: string[] = [
    path.resolve(__dirname, '..'), // out/test/test/...
    path.resolve(__dirname, '..', '..', 'src') // out/test/src/... (in-src tests)
  ];

  for (const root of testRoots) {
    for (const file of collectTestFiles(root)) {
      mocha.addFile(file);
    }
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err: unknown) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
