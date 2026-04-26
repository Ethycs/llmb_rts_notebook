---
turn_id: 108
merged_turn_id: 094
role: assistant
phase: 08-blockers-mediator-standards
source_lines: [12459, 12584]
source_sha256: 848e435ec3e3071cc04c13e234dd79700896c20a3dde9a51dbfbcc71936023c8
char_count: 9670
---



## Assistant

Yes — there's a clear standard, with a specific known gap that matters for your project. Let me lay it out.

The standard is two packages that work together:

@vscode/test-electron is the official package for running tests inside a real VS Code instance with full Extension API access. It handles downloading a specified VS Code version, unzipping it, and launching it with your extension loaded for testing. The core function is `runTests({ extensionDevelopmentPath, extensionTestsPath, ... })` npm, which programmatically drives the whole flow.

@vscode/test-cli is the wrapper that gives you a `vscode-test` command. You install both via `npm install --save-dev @vscode/test-cli @vscode/test-electron`, then add `"test": "vscode-test"` to your package.json scripts. The CLI looks for a `.vscode-test.js/mjs/cjs` config file relative to the working directory and uses Mocha exclusively under the hood. Visual Studio Code

The conventional structure is well-documented:

Test fixtures (sample workspaces, test files) go in a separate `test-fixtures/` directory, kept apart from source code. Mintlify The test runner lives at `src/test/runTest.ts`, the suite entry at `src/test/suite/index.ts`. When running integration tests, `--extensionTestsPath` points to the test runner script (typically `src/test/suite/index.ts`) that programmatically runs the suite via Mocha — and you can replace Mocha with any other framework that runs programmatically. Visual Studio Code

For debugging tests inside VS Code itself, the canonical config is:

The `extensionHost` launch type is the magic — it spawns VS Code with your extension under a debugger.

Adding `--disable-extensions` to `launchArgs` disables all extensions except the one being tested npm, which you almost always want for deterministic tests. Without it, the test instance loads every extension installed globally, and any of them could interfere.

You can pin tests to specific VS Code versions: `version: '1.36.1'` for a specific release, `version: 'insiders'` for the Insiders channel, or `downloadAndUnzipVSCode('1.35.0')` for explicit control over the executable path. npm This matters for your fork since you want to track upstream vscode-jupyter against specific stable VS Code versions.

The canonical starting point is Microsoft's helloworld-test-sample at `microsoft/vscode-extension-samples`. It's the official template — fork its layout for your fork's test suite.

There's also the Extension Test Runner marketplace extension (`ms-vscode.extension-test-runner`) that integrates with the CLI for in-editor test debugging. Worth installing for the developer experience.

This is the one that matters specifically for your project: the official VS Code documentation recommends `@vscode/test-electron` and `@vscode/test-web`, which provide limited testing capabilities and a total lack of support for testing webviews. Most VS Code extensions in the marketplace have minimal testing if any at all. DEV Community

This is a real gap. Your map view is a webview. Your cell renderers are webviews. The official toolkit doesn't test webview content meaningfully — it can verify the webview opens, but it can't drive interactions inside it or assert on its DOM.

The community workaround is WebdriverIO with VS Code integration: "WebdriverIO (and its new VS Code integration) you can automate VS Code like any other Electron or web application... starting VS Code with custom user settings, serving VS Code from a server to be accessed by any browser for testing web extensions, bootstrapping page objects with locators matching your VS Code version. Make life easier and run both unit and integration tests, access the VS Code APIs, and automate complex user flows or webviews using one test framework." DEV Community

WebdriverIO is the pragmatic choice when webview testing matters. It's heavier than `@vscode/test-electron` but it's the de facto solution for the gap.

Mapping to the test layers from earlier turns:

Doc-driven contract tests + Markov simulation + fault injection (Python side): these run as pytest, against LLMKernel directly. Already in your existing test infrastructure. No `@vscode/test-electron` needed — these test the kernel-side protocol implementation in isolation.

Unit tests of extension TypeScript code (no VS Code API): plain Mocha or Jest, no test-electron needed. Mock VS Code's API surface where used. Fast feedback during development.

Integration tests with real VS Code instance: `@vscode/test-electron` + `@vscode/test-cli`. Standard pattern. Tests that exercise the full extension activation, command registration, kernel connection, notebook editor interaction. Slower but high-fidelity.

Webview tests (map view, cell renderers): WebdriverIO with VS Code integration. The map view's interactivity (drag a zone, save a viewpoint) and the cell renderers' tool-call interactions (approve, deny, expand) need this layer.

End-to-end tests (kernel + extension + UI): WebdriverIO again, since end-to-end usually involves webview interaction.

So your TypeScript test stack becomes:

Three frameworks for three layers, plus your Python side keeps using pytest. Reasonable; matches the natural test pyramid where the slowest tests are the rarest.

Concretely, for your fork:

A few project-specific concerns:

Your fork modifies vscode-jupyter, which has its own test infrastructure. When you fork, you inherit their existing tests. Most of those tests are for subsystems you cut. Decide early: do you delete their test directory and start fresh, or do you keep it as a baseline and add your tests alongside? I'd argue: delete almost all of it (tests for cut subsystems are noise), keep any tests for the subsystems you keep (notebook editor integration, kernel protocol handling), and add fresh tests for your additions.

The fork ships its own kernel (LLMKernel). Your integration tests need a real LLMKernel running. Either build LLMKernel as a test dependency (slow but realistic) or use a mock kernel (faster, less realistic). For the Markov-driven simulation tests, the mock kernel is the right answer. For end-to-end smoke tests, the real LLMKernel.

Webview testing is the load-bearing concern. Your project has webviews as central UI surfaces. Don't skip WebdriverIO. The "I'll just test it manually" trap is real and costly later.

Test fixtures should include sample .llmnb files. Your custom file format needs sample files for tests. `test-fixtures/` should have a few — empty notebook, simple conversation, complex conversation with branching, malformed file (for error handling tests).

Cross-language coordination is a real challenge. Python tests test the kernel; TypeScript tests test the extension; some tests need both running. Plan for this — probably a "make test-e2e" target that starts LLMKernel and runs WebdriverIO against it.

The standard exists, it's well-documented, and the gap (webviews) has a known community solution. For your fork, adopt the standard for layers it covers and add WebdriverIO for the layer it doesn't.

Want to dig into the WebdriverIO setup specifically, the cross-language test orchestration, the sample `.llmnb` fixture design, or the test-pyramid distribution for v1?

```javascript
my-extension/
├── src/
│   ├── extension.ts
│   └── test/
│       ├── suite/
│       │   ├── extension.test.ts
│       │   └── integration.test.ts
│       ├── runTest.ts
│       └── index.ts
├── test-fixtures/
│   └── workspace/
├── package.json
└── tsconfig.json
```

```json
{
  "version": "0.2.0",
  "configurations": [{
    "name": "Extension Tests",
    "type": "extensionHost",
    "request": "launch",
    "args": [
      "--extensionDevelopmentPath=${workspaceFolder}",
      "--extensionTestsPath=${workspaceFolder}/out/test/suite/index"
    ],
    "outFiles": ["${workspaceFolder}/out/test/**/*.js"],
    "preLaunchTask": "${defaultBuildTask}"
  }]
}
```

- Mocha/Jest for unit tests (fast, no VS Code)
- @vscode/test-electron + @vscode/test-cli for extension integration (standard, no webviews)
- WebdriverIO with VS Code integration for webview and UI tests (the gap-filler)

1. The directory layout: src/test/suite/, test-fixtures/, runTest.ts, index.ts. Don't deviate.
2. The runTest.ts pattern with runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: ['--disable-extensions'] }).
3. The .vscode-test.mjs config for the CLI — declarative, simple.
4. The extensionHost launch.json for in-editor debugging.
5. --disable-extensions to keep tests isolated.
6. Pinned VS Code version for reproducibility — pick a stable target (e.g., 'stable' or a specific release like '1.95.0') and lock it.
7. Copy from vscode-extension-samples — Microsoft maintains this as the reference template.

1. @vscode/test-electron + @vscode/test-cli for extension integration tests. Standard, well-supported, keep close to upstream patterns.
2. WebdriverIO with VS Code integration for webview tests. Worth the setup cost.
3. Mocha under the hood (the CLI's default; no reason to swap).
4. Standard directory layout copied from vscode-extension-samples.
5. Pin a specific VS Code version for reproducibility; bump deliberately.
6. --disable-extensions in test launches.
7. Three-framework TypeScript test stack: Mocha for unit, test-electron for integration, WebdriverIO for webview/E2E.
8. pytest stays for Python-side kernel tests, including Markov simulation and fault injection.
9. Test fixtures in test-fixtures/: sample .llmnb files of varying complexity, sample workspace folders for integration tests.
10. Delete most inherited tests from vscode-jupyter on fork; add fresh tests scoped to what survives.

