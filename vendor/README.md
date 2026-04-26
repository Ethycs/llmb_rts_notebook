# `vendor/` — pinned external dependencies

Two submodules feed V1 implementation. Both stay **unmodified in this directory**; modifications happen on copies elsewhere.

| Submodule | Upstream | Pinned commit | Role |
|-----------|----------|---------------|------|
| [`vendor/LLMKernel/`](LLMKernel/) | [`Ethycs/LLMKernel`](https://github.com/Ethycs/LLMKernel) | `8867f487d9866e1e26d0597f68ffe2753798e434` | Sole-kernel baseline. Track B hardens this into the MCP/PTY mediator ([DR-0015](../docs/decisions/0015-kernel-extension-bidirectional-mcp.md)) by adding modules under `llmkernel/`. |
| [`vendor/vscode-jupyter/`](vscode-jupyter/) | [`microsoft/vscode-jupyter`](https://github.com/microsoft/vscode-jupyter) | `1763c63c8c01e715f149b4e0101a20ece9a0897f` | Subtractive-fork baseline ([DR-0011](../docs/decisions/0011-subtractive-fork-vscode-jupyter.md)). Track C copies the source into [`extension/`](../extension/) and applies the chapter-07 cut list. |

## How submodules update

```bash
# bring in the pinned versions on a fresh clone
git submodule update --init --recursive

# bump LLMKernel to a new upstream commit (rare; coordinate with Track B work)
cd vendor/LLMKernel
git fetch && git checkout <new-sha>
cd ../..
git add vendor/LLMKernel
git commit -m "vendor: bump LLMKernel to <new-sha>"
```

`vendor/vscode-jupyter` is read-only for the lifetime of V1 — it is the baseline for diffing the subtractive cuts, never a target for direct edits.

## License notes

Both upstreams are MIT-licensed. The fork output in `extension/` keeps MIT attribution per upstream's `LICENSE`; the wrapper repository is GPL-3.0-only (see [`../LICENSE`](../LICENSE)).
