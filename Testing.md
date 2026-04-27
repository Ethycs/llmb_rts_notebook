# Testing Guide

This document describes the test architecture for `llmb_rts_notebook` and how to use it. It complements [Engineering_Guide.md](Engineering_Guide.md) §9 (Verification rituals) and §11 (Anti-patterns) with practical "what to run when" guidance and debug recipes.

The purpose is to keep test usage coherent across contributors and across the project's life. Per Bell-System discipline, tests are not afterthoughts — they are the spec's enforcement mechanism. A passing test for an RFC is the RFC's only proof of conformance; a failing test surfaces an RFC ambiguity or an implementation drift before it reaches the operator.

---

## 1. The test pyramid

The project's tests live in five tiers. Pick the lowest tier that proves what you need to prove.

```
                  ┌─────────────────────────┐
                  │  Tier 5: live operator  │  manual; not automated
                  │  (open VS Code, F5,     │
                  │   /spawn in cell)       │
                  ├─────────────────────────┤
                  │  Tier 4 (Layer 1 e2e):  │  automated, but environment-dependent
                  │  live-kernel.test.ts    │  (covers substrate; live agent path
                  │                         │   skipped — see §6)
                  ├─────────────────────────┤
                  │  Tier 3: smokes         │  3 modes: paper-telephone (in-process),
                  │  __main__.py arms       │   metadata-writer, agent-supervisor
                  │                         │  (live OAuth/mitm)
                  ├─────────────────────────┤
                  │  Tier 2: contract       │  extension @vscode/test-cli + Mocha;
                  │  test/contract/*.test.ts│  kernel pytest under xdist
                  ├─────────────────────────┤
                  │  Tier 1: unit           │  pure-function tests; no
                  │  (parseCellDirective,   │  fixtures, milliseconds
                  │   _attrs, etc.)         │
                  └─────────────────────────┘
```

Each tier covers what tiers below it can't, and is more expensive than the tier below.

| Tier | What it asserts | Speed | Run when |
|---|---|---|---|
| 1 (unit) | Pure functions match their spec | <1ms each | Always; on every save |
| 2 (contract) | Modules satisfy their RFC contracts (envelope shapes, MIME types, dispatcher behavior, renderer output) | <1s each | Before every commit |
| 3 (smokes) | Kernel subsystems work in process (stub kernel + paper-telephone, real Anthropic via passthrough) | 5-30s each | After kernel work; before merge |
| 4 (e2e) | Extension activates inside real VS Code, kernel spawns via real `node-pty`, ready handshake, hydrate, heartbeat | ~15s | Before merge of extension changes |
| 5 (live operator) | Operator opens a `.llmnb`, types `/spawn`, sees the cell render — full hero loop | minutes | Before each ship |

---

## 2. Run commands by tier

All commands below are runnable from the repo root.

### Tier 1 — kernel unit tests

```bash
.pixi/envs/kernel/python.exe -m pytest \
  vendor/LLMKernel/tests/test_run_tracker.py \
  vendor/LLMKernel/tests/test_custom_messages.py \
  vendor/LLMKernel/tests/test_metadata_writer.py \
  vendor/LLMKernel/tests/test_agent_supervisor.py \
  vendor/LLMKernel/tests/test_socket_writer.py \
  vendor/LLMKernel/tests/test_otlp_log_handler.py \
  vendor/LLMKernel/tests/test_drift_detector.py \
  vendor/LLMKernel/tests/test_metadata_writer.py \
  vendor/LLMKernel/tests/test_pty_mode.py \
  -n auto --dist=loadfile --timeout=60 -q
```

### Tier 1 — extension unit tests (same suite as Tier 2)

The extension only has unit + contract tests; both run via the same command:

```bash
cd extension && pixi run -e kernel npm run test:contract
```

Filter by file with `--grep`:

```bash
cd extension && pixi run -e kernel npm run test:contract -- --grep "parseCellDirective"
```

### Tier 2 — contract tests

#### Kernel contract suite

```bash
.pixi/envs/kernel/python.exe -m pytest \
  vendor/LLMKernel/tests/ \
  --ignore=vendor/LLMKernel/tests/test_kernel.py \
  --ignore=vendor/LLMKernel/tests/test_multimodal_display.py \
  --ignore=vendor/LLMKernel/tests/test_pdf_notebook_integration.py \
  --ignore=vendor/LLMKernel/tests/test_integration_magic.py \
  --ignore=vendor/LLMKernel/tests/test_magic_commands.py \
  --ignore=vendor/LLMKernel/tests/test_provider_detection.py \
  --ignore=vendor/LLMKernel/tests/test_import.py \
  -n auto --dist=loadfile --timeout=60 -q
```

The `--ignore` list excludes upstream LLMKernel tests that depend on `ipywidgets` (not in our Pixi env). Keep this list updated as upstream churns; cf. Engineering Guide §9.2.

Expected: ~291 passed + 2 skipped + 0 errors in <30s.

#### Extension contract suite (includes integration smoke + Layer 1 e2e)

```bash
cd extension && pixi run -e kernel npm run test:contract
```

Expected: ~106 passing + 1 pending (the live-Claude e2e test; see §6).

### Tier 3 — kernel smokes

Three smokes cover progressively more of the substrate:

#### Tier 3a — paper-telephone (in-process)

```bash
PYTHONPATH=vendor/LLMKernel pixi run -e kernel python -m llm_kernel paper-telephone-smoke
```

Asserts: an in-process span flows through `RunTracker` → `CustomMessageDispatcher` → `display_data`/`update_display_data` JSON in OTLP shape. No agent. No network. ~1s.

#### Tier 3b — metadata-writer

```bash
PYTHONPATH=vendor/LLMKernel pixi run -e kernel python -m llm_kernel metadata-writer-smoke
```

Asserts: `MetadataWriter` builds a `notebook.metadata` Family F snapshot with the right `metadata.rts` substructures and `snapshot_version`. ~1s.

#### Tier 3c — agent-supervisor (live Anthropic; needs auth)

```bash
LLMKERNEL_USE_PASSTHROUGH=1 PYTHONPATH=vendor/LLMKernel \
  pixi run -e kernel python -m llm_kernel agent-supervisor-smoke
```

Asserts: a real Claude Code subprocess spawns with the project's MCP config, makes 5+ Anthropic API calls (intercepted via mitmproxy), emits `notify` + `report_completion`, and run records flow through to the dispatcher. **Requires a working `.env` with `ANTHROPIC_API_KEY` at the repo root.** ~30s; ~$0.01-0.05 in API cost per run.

Without `LLMKERNEL_USE_PASSTHROUGH=1`, the smoke calls Anthropic directly without mitm — same auth, just no flow capture.

### Tier 4 — Layer 1 e2e (live VS Code + real kernel)

```bash
cd extension && pixi run -e kernel npm run test:contract -- --grep "e2e: live kernel"
```

Asserts (what passes today):
- Extension activates inside a real VS Code Extension Host (via `@vscode/test-cli`)
- `PtyKernelClient` spawns `python -m llm_kernel pty-mode` via `node-pty`
- Ready handshake completes (`kernel.ready` LogRecord)
- `heartbeat.kernel` emits on the 5s cadence (verified by waiting 11s)
- `notebook.metadata` `mode:"hydrate"` round-trip (open document with persisted state, verify it loads)

Currently NOT covered by the e2e (see §6 below):
- The full operator loop (typing `/spawn` in a cell → live Claude → `notify` span in cell output) is `test.skip`'d. The substrate works; the operator-loop integration is environment-sensitive and lacks diagnostic visibility from inside the test runner.

### Tier 5 — live operator (manual)

The actual ship-readiness gate. Not automated.

1. `cd extension && pixi run -e kernel npm run package && pixi run -e kernel npm run package:renderer`
2. Open VS Code, F5 in `extension/` to launch the Extension Development Host
3. Open a `.llmnb` file in the dev host's workspace
4. Type `/spawn alpha task:"emit one notify and complete"` in a code cell
5. Shift+Enter
6. Watch: cell shows the `notify` widget. The status bar shows "kernel ok." The map view (Ctrl+Shift+P → `LLMNB: Open map view`) shows the agent.
7. Optional: Ctrl+Shift+P → `LLMNB: Show kernel terminal` to see the kernel's PTY output for debugging.

If any step breaks, follow the debug recipes in §5 below.

---

## 3. The verification ritual

Per Engineering Guide §9.1, verification before a merge is **all green** at the relevant tier and below:

| Change scope | Required tiers |
|---|---|
| Pure-function utility | 1 |
| Extension component (renderer, applier, parser) | 1 + 2 |
| Wire format change | 1 + 2 + 3a |
| Kernel subsystem (run_tracker, dispatcher) | 1 + 2 + 3a + 3b |
| RFC implementation | 1 + 2 + relevant 3 + 4 |
| Substrate refactor | All except 5 |
| V1 ship-readiness | All five |

---

## 4. Test parallel-safety constraints (CRITICAL)

The kernel suite runs under `pytest -n auto --dist=loadfile`. Tests MUST be parallel-safe (Engineering Guide §9.2 + §11.7):

- **Locks**: `threading.RLock` if any code under the lock might invoke a logger handler that re-enters the same module. Engineering Guide §11.7 documents the `SocketWriter` deadlock that surfaced this rule.
- **Filesystem**: tests use `tmp_path` from pytest. Never write to fixed paths.
- **Environment**: tests use `monkeypatch.setenv` / `monkeypatch.delenv`. Never raw `os.environ[...] = ...`.
- **Sockets**: tests use ephemeral ports (`bind(("127.0.0.1", 0))`) and unique UDS paths under `tmp_path`. Never bind to a fixed port.
- **Threads**: `daemon=True` and `join(timeout=N)` in a `finally` block. Non-daemon threads block pytest exit.
- **Hypothesis**: profile uses `database=InMemoryExampleDatabase()` so xdist workers don't contend on `~/.hypothesis/examples/`.
- **Logging**: tests in `tests/conftest.py` autouse-fixture `_isolate_root_logger` which captures and restores the root logger's handlers per test.

Same constraints apply to extension Mocha tests. CJS module output means **no `import.meta`** in test code (use CJS globals `__filename`/`__dirname` if needed).

---

## 5. Debug recipes

### "Test hangs for >30s"

1. Run the offending test file in isolation:
   ```bash
   .pixi/envs/kernel/python.exe -m pytest <path/to/test.py> -q --timeout=30
   ```
2. If it hangs alone, check for: TCP send-buffer deadlock (1000 frames × 250B exceeds Windows default `SO_SNDBUF`; need a background drain thread before producers), socket leak, or a `time.sleep(N)` larger than 30s.
3. If it hangs only when run with other files, suspect cross-file state leakage. Logger handlers and module-level singletons are common culprits. Add `_isolate_root_logger` autouse fixture if not already in `conftest.py`.

### "Cell exec ends `false` immediately; no spans"

1. Stub kernel: the stub's `executeCell` should synchronously emit fake spans through the sink before returning. Verify the stub exists and runs.
2. Live kernel (Tier 4 / Tier 5): the `PtyKernelClient.executeCell` awaits a terminal span via `Promise.race(terminalReached, 60s timeout)`. If no terminal span arrives in 60s, the promise rejects and the cell ends with the rejection error. Check (a) was `dispatcher.start()` called in `pty_mode.main` (registers the Comm target with the kernel's comm_manager), (b) is the bridge's `_route_operator_action` registered with the dispatcher (verify `bridge.dispatcher` is non-null at construction).

### "Live e2e: `/spawn` cell never produces output"

This is the test currently `test.skip`'d. Known difficulties (see §6 for full discussion):

1. **Kernel stderr is invisible from inside the test.** The kernel writes to PTY stderr, which is captured by the `KernelTerminal` Pseudoterminal. Inside `@vscode/test-cli`, no terminal panel is open, so the bytes are buffered and never read. To diagnose: temporarily wire `PtyKernelClient.onPtyData` to `console.error` during testing.
2. **OTel LogRecords go to the extension's output channel**, also invisible from the test. Add a `LogRecordObserver` that mirrors to `console.error` for diagnostic runs.
3. **OAuth vs API key auth.** Default Claude Code uses OAuth via the system keychain. The Extension Host's child-process spawn may not inherit the keychain context. Force API-key path: set `process.env.LLMKERNEL_USE_BARE = '1'` in `suiteSetup` so the kernel passes `api_key=ANTHROPIC_API_KEY, use_bare=True` to the supervisor.

### "Live agent path works in Tier 3 but not Tier 4"

Tier 3 (`agent-supervisor-smoke`) runs in the developer's shell with full env access. Tier 4 spawns the kernel from inside the Extension Host's `child_process`, which has reduced env inheritance. Differences that have surfaced:

- `.env` not auto-loaded → fixed by `find_dotenv(usecwd=True)` + `load_dotenv()` in `__main__.py` for all subcommands
- OAuth keychain not reachable → workaround: `LLMKERNEL_USE_BARE=1` + `ANTHROPIC_API_KEY`
- `cwd` is `vscode.workspace.workspaceFolders[0]` (the test fixture dir), not the repo root → ensure file paths use the resolver pattern

If still broken: the agent_spawn handler creates `<cwd>/.llmnb-agents/<agent_id>/` as `work_dir`. Inspect that directory after a failed run for partial spawn artifacts (mcp-config.json, system-prompt.txt, kernel.stderr.<id>.log). If empty, supervisor.spawn raised before any subprocess work.

### "Pytest test_X.py file doesn't show in test output"

Check it's not in the `--ignore` list (Tier 2 kernel command). Some upstream LLMKernel tests depend on `ipywidgets` and others; they're excluded.

### "Extension Host fails to launch"

Native module ABI mismatch. `node-pty` ships prebuilt binaries for the Pixi-managed Node 20 (build env), but VS Code's Electron has a different Node ABI. The extension's package script uses `--external:node-pty` so the binding is resolved at runtime from `node_modules/`, not bundled. If the binding still fails, run:

```bash
cd extension && npm rebuild node-pty --runtime=electron --target=<electron-version>
```

Find the Electron version in `.vscode-test/vscode-win32-x64-archive-*/resources/app/package.json`.

---

## 6. Known limits and tradeoffs

### Tier 4 live `/spawn` test is `test.skip`

The substrate parts of Tier 4 work (extension activation, kernel spawn via `node-pty`, ready handshake, heartbeat, hydrate path). The live `/spawn alpha task:"..."` directive that triggers a real Claude Code subprocess is currently `test.skip`'d.

**Why**: the live agent path through the Extension Host's spawn context has multiple potential failure modes (OAuth-vs-API-key auth, env inheritance, working-directory resolution, cross-process span routing) and the test runner doesn't surface kernel stderr, OTel LogRecords, or mitm flows in a way that lets us debug each iteration. We've made several fixes (`dispatcher.start()`, `find_dotenv()` in `__main__.py`, `LLMKERNEL_USE_BARE=1`, `work_dir` defaulting in the agent_spawn handler) but the integration test still times out.

**Coverage gap**: this means our automated suite does NOT prove the full operator loop end-to-end. Tier 3c (`agent-supervisor-smoke`) proves the kernel-side agent path with real Anthropic. Tier 4 substrate proves the wire works. Tier 5 (manual) closes the loop. Until the Tier 4 live test lands, **Tier 5 is the actual ship-readiness gate**.

**Path to fixing**: a focused diagnostic round (instrument the kernel to write structured progress markers to a file the test can poll, or expose `PtyKernelClient.onPtyData` via the ExtensionApi for the test to subscribe and assert on) would close the gap. Out of scope until V1.5 because the manual gate already covers it.

### Extension Host shares state across tests

VS Code's `@vscode/test-cli` reuses the Extension Host across all tests in a `vscode-test` invocation. Configuration changes via `vscode.workspace.getConfiguration().update()` persist between tests in the same suite. Tests that change config MUST restore it in `suiteTeardown` (or use `--no-cache` if state hygiene matters). The live e2e test does this for `kernel.useStub` / `kernel.pythonPath`.

### Tier 3c API costs

Each Tier 3c run hits Anthropic's API. With `claude-haiku-4-5` (default per `LLMKERNEL_SMOKE_MODEL`) and `LLMKERNEL_USE_PASSTHROUGH=1`, cost is typically $0.01-0.05 per run. Don't run it in tight loops. If iterating on a bug, drop to Tier 3a + Tier 3b first.

### Hypothesis profile is in-memory

The kernel uses `hypothesis` for property-based testing in `tests/markov/`. Database is configured in-memory (`InMemoryExampleDatabase()`) so xdist workers don't contend, BUT this means failure-shrinking examples are lost between runs. If a Hypothesis test fails, the seed is logged; reproduce by re-running with the same seed.

---

## 7. Adding a new test

### For a new RFC implementation

1. Read the RFC's "Failure modes" section. Each row should map to a test.
2. Read the RFC's "Worked example." Round-trip the worked example as the primary contract test.
3. Tier-2 contract tests live next to similar tests (`test/contract/` for extension; `tests/test_*.py` for kernel).
4. If the RFC has a "Backward-compatibility analysis" section, write tests for additive changes (new optional field, new enum value) — confirm receivers tolerate them.

### For a new directive or operator action

1. Pure-function unit test (Tier 1) for the parser.
2. Contract test (Tier 2) for the wire envelope shape — receiver dispatches correctly.
3. Smoke test (Tier 3) if the action triggers a kernel subsystem (e.g., agent_spawn → supervisor).

### For a new failure mode

Always test both the trigger condition and the recovery path. RFC failure-mode tables list the recipient response (log, refuse, emit error span). Assert the response, not just that the trigger doesn't crash.

---

## 8. Glossary

- **Tier 1 unit**: pure function, no fixtures, no I/O. Sub-millisecond.
- **Tier 2 contract**: module behavior against an RFC contract. Mocked I/O, in-process. Sub-second.
- **Tier 3 smoke**: kernel subsystem in process, optionally with real network (Tier 3c). Seconds.
- **Tier 4 e2e**: extension-side end-to-end inside a real VS Code Extension Host. Tens of seconds.
- **Tier 5 manual**: operator runs the full hero loop. Minutes.
- **Paper-telephone smoke**: in-process kernel + dispatcher + run tracker; no agent, no network. The minimum smoke.
- **Layer 1 e2e**: synonym for Tier 4. The first layer of e2e because Layer 2 (WebdriverIO UI tests) is V1.5+.
- **Tape**: opt-in OTLP/JSON Logs file capturing raw kernel observability per RFC-007. V1.5 work.

---

*This guide pairs with [Engineering_Guide.md](Engineering_Guide.md) §9-§11. When this guide and the Engineering Guide disagree, the Engineering Guide is authoritative; update this guide to match.*
