# `extension/` — VS Code extension

V1 VS Code extension for `.llmnb` notebooks. The eventual contents are produced by the **subtractive fork** of [`vendor/vscode-jupyter`](../vendor/vscode-jupyter/) per [DR-0011](../docs/decisions/0011-subtractive-fork-vscode-jupyter.md) and [chapter 07](../docs/dev-guide/07-subtractive-fork-and-storage.md).

The current state is a Stage 0 stub: just enough manifest, tsconfig, and entry point for `npm install` and `npm run build` to succeed. No NotebookController is registered yet; that is Track C Round 2 work, gated on the four RFCs landing under [`docs/rfcs/`](../docs/rfcs/).

## Build

```
npm install      # from repo root, via npm workspaces
npm run build    # tsc → out/
npm run package  # esbuild → dist/extension.js
npm test         # @vscode/test-electron + WebdriverIO (added in Stage 4)
```

## Track C plan

- **Round 1 (parallel cuts)**: import the chapter-07 cut list — Python integration, IPyWidgets, remote servers, debugging, viewers, web-target, IntelliSense — three agents on disjoint slices.
- **Round 2 (rebind)**: register `.llmnb` exclusively, register one `NotebookController` dispatching to LLMKernel via `jupyter_client`, wire the RFC-003 custom-message router, register the `application/vnd.rts.run+json` MIME renderer. **Status: landed.** `src/notebook/jupyter-kernel-client.ts` connects to a Jupyter server via `@jupyterlab/services`, decodes RFC-003 envelopes from `display_data` / `update_display_data` (run lifecycle) and from a `llmnb.rts.v1` Comm (other families), and feeds them into the existing `MessageRouter`. The `StubKernelClient` is preserved behind the `llmnb.kernel.useStub` config flag for offline development.

The submodule at `vendor/vscode-jupyter/` stays unmodified as the import baseline; the cuts happen on a **copy** placed under this directory.

## Manual smoke (R2)

Spin up LLMKernel as a kernelspec under a Jupyter server, then point VS Code at it:

```
# terminal 1: start a Jupyter server (no browser, fixed token)
pixi run -e kernel jupyter server --no-browser \
    --IdentityProvider.token=devtoken --port=8888

# terminal 2: install the kernelspec (one-time)
pixi run -e kernel python -m ipykernel install --user \
    --name=llm_kernel --display-name="LLMKernel"
```

Then in VS Code, set:

- `llmnb.kernel.serverUrl` = `http://127.0.0.1:8888` (default)
- `llmnb.kernel.token` = `devtoken`
- `llmnb.kernel.kernelName` = `llm_kernel` (default)

Open a `.llmnb` file and execute a cell; envelopes flow through the real client.

To fall back to the in-process stub (no Jupyter server required), set `llmnb.kernel.useStub` = `true`.
