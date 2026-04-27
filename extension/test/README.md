# Extension test harness — Stage 4 / Track T1

This directory holds the three-layer test pyramid for the llmb RTS Notebook
extension. The layout follows `docs/dev-guide/08-testing-strategy.md` and
RFC-004 (doc-driven contract tests).

## Layers

### 1. Contract tests — `test/contract/**`

Fast, in-Extension-Host walks of every documented API surface. The doc-driven
rule: **every test cites the spec section it walks** in a comment. If the
spec drifts, these tests are the canary.

Walked surfaces:

- `notebook-controller.test.ts` — VS Code NotebookController API
  (`vscode.notebooks.createNotebookController`, `controller.executeHandler`,
  `NotebookCellExecution.{start,end,appendOutput,replaceOutput,clearOutput}`,
  `NotebookCellOutputItem.json`, `workspace.openNotebookDocument`).
- `mime-renderer.test.ts` — `application/vnd.rts.run+json` renderer at
  `dist/run-renderer.js`. Walks RFC-001 tool dispatch (`notify`),
  RFC-003 Family A (`run.start`/`run.event`/`run.complete`), and the
  fail-closed contract on malformed input. **Skipped if** `dist/run-renderer.js`
  is missing — run `npm run package` first.
- `message-router.test.ts` — `MessageRouter` against RFC-003. Walks all 10
  message types, fail-closed semantics F1/F2, and major-version mismatch F10.

### 2. Integration smokes — `test/integration/**`

Operator workflow simulation. In-process equivalent of Stage 3's
paper-telephone smoke; uses `llmnb.kernel.useStub=true` so it runs without a
Jupyter server.

- `smoke-stub-kernel.test.ts` — opens a one-cell `.llmnb`, executes it,
  asserts a `run.complete{status=success}` envelope appears as a
  `application/vnd.rts.run+json` cell-output item.

### 3. Renderer integration (e2e) — `test/wdio/**`

WebdriverIO + `wdio-vscode-service` drives a real VS Code with the extension
loaded; asserts the rendered DOM for the 13 RFC-001 tools.

**Status:** scaffolding only. No specs ship yet.

> TODO(T1-renderer): renderer-driven WebdriverIO tests are deferred. Add
> files under `test/wdio/` (e.g. `notify.e2e.ts`,
> `report-completion.e2e.ts`) once the renderer-driven assertion harness is
> online.

This layer is gated on `npm run test:e2e` because WebdriverIO downloads a
VS Code binary on first run.

## Running

```bash
# Install deps (from repo root)
pixi run -e kernel npm --prefix extension install

# Build extension + tests
pixi run -e kernel npm --prefix extension run build

# Bundle the renderer (mime-renderer.test.ts skips otherwise)
pixi run -e kernel npm --prefix extension run package

# Contract + integration via @vscode/test-cli
pixi run -e kernel npm --prefix extension run test:contract

# Renderer integration (downloads VS Code on first run)
pixi run -e kernel npm --prefix extension run test:e2e
```

## Required `package.json` script entries

The operator should add the following to `extension/package.json` under
`"scripts"` (this agent does **not** edit `package.json` to avoid colliding
with parallel agents):

```jsonc
{
  "scripts": {
    "build:tests": "tsc -p ./tsconfig.test.json",
    "pretest:contract": "npm run build:tests && npm run package",
    "test:contract": "vscode-test",
    "pretest:e2e": "npm run build && npm run package",
    "test:e2e": "wdio run ./wdio.conf.ts"
  }
}
```

The existing `test` script (`vscode-test`) keeps working as the alias for the
contract+integration suites; `pretest` already chains `build` + `lint`.

## Required `.vscode/launch.json` (sandbox blocked write)

Tooling sandbox prevents this agent from writing inside `extension/.vscode/`.
The operator should create `extension/.vscode/launch.json` with:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "${workspaceFolder}/test/fixtures/workspace"
      ],
      "outFiles": [
        "${workspaceFolder}/dist/**/*.js",
        "${workspaceFolder}/out/**/*.js"
      ],
      "preLaunchTask": "npm: build"
    },
    {
      "name": "Run Extension Tests",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "--extensionTestsPath=${workspaceFolder}/out/test/test/suite/index",
        "${workspaceFolder}/test/fixtures/workspace"
      ],
      "outFiles": [
        "${workspaceFolder}/out/test/**/*.js"
      ],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

## Doc-driven rule

Every contract test cites the RFC / dev-guide section it walks. When you add
a new test, add a `// Spec reference:` comment at the top of the suite or on
each `test()` block. This is the load-bearing convention from RFC-004.
