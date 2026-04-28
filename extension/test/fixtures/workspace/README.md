# Fixture workspace

This folder is the canonical workspace for both:

- **Tier 4 (automated e2e)** — `@vscode/test-cli`'s Extension Development Host opens this folder per `extension/.vscode-test.mjs`'s `workspaceFolder` setting
- **Tier 5 (manual F5)** — `extension/.vscode/launch.json`'s "Launch Extension" configuration opens this folder

Both paths see the same `.vscode/settings.json`, the same `.env` (resolved via `find_dotenv(usecwd=True)` walking up to the repo root), the same `test.llmnb`, and the same diagnostic artifact paths.

## Diagnostic artifacts (post-run)

When a kernel session runs (either tier), look here:

| Path | What it is | When to read |
|---|---|---|
| `.llmnb-kernel-markers.jsonl` | Per-stage progress markers from `llm_kernel/_diagnostics.py` | Every run; LAST line tells you what the kernel reached |
| `.llmnb-agents/<agent_id>/` | Empty unless `agent_spawn` handler ran | Existence proves the handler dispatched |
| `.llmnb-agents/<agent_id>/.run/<agent_id>/` | Created by `AgentSupervisor.spawn` after pre-flight passes | Existence proves spawn got past validation |
| `.llmnb-agents/<agent_id>/.run/<agent_id>/kernel.stderr.<id>.log` | stderr capture from the spawned `claude` process | Read when the agent crashed mid-run |
| `.llmnb-agents/<agent_id>/.run/<agent_id>/mcp-config.json` | MCP config file generated for the agent | Inspect to verify environment passed |

Each is git-ignored (via `.gitignore` at repo root) and `files.exclude`-hidden in the explorer (via `.vscode/settings.json`).

## Pre-flight before F5

1. Repo-root `.env` must contain a valid `ANTHROPIC_API_KEY` (this is the API-key path; OAuth via Claude Code's keychain isn't reachable from the Extension Host's spawn context)
2. `pixi run -e kernel npm run package && pixi run -e kernel npm run package:renderer` to rebuild the bundle (F5's `preLaunchTask` only runs `tsc`, not the bundler)
3. `pixi install -e kernel` if you haven't recently — the kernel env must include `claude` (verify with `pixi run -e kernel which claude`)

## Quick triage when a cell shows a red X

```bash
# From repo root:
cat extension/test/fixtures/workspace/.llmnb-kernel-markers.jsonl
```

LAST line tells you the stage. Common patterns:

- Last line `pty_mode_main_entry` only → kernel imported but crashed on env-read
- Last line `pty_mode_socket_connected` → handshake fine; agent_spawn never received
- Last line `agent_spawn_received` → handler ran, didn't reach `agent_spawn_calling_spawn`
- Last line `agent_spawn_raised` → spawn raised; the `error` field is the verbatim cause
- Last line `agent_spawn_returned` → spawn succeeded; agent crashed silently afterward (check `kernel.stderr.<id>.log`)

If the markers file doesn't exist at all, the kernel never started — check the kernel terminal panel (`Ctrl+Shift+P` → `LLMNB: Show kernel terminal`) for Python import errors.

## Resetting between runs

```bash
rm -rf extension/test/fixtures/workspace/.llmnb-agents/
rm -f extension/test/fixtures/workspace/.llmnb-kernel-markers.jsonl
```

(Or just delete the folder; it'll be recreated on the next run.)
