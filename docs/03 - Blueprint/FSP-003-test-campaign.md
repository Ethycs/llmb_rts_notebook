# FSP-003: Test campaign — failure-mode-typed waits, preflight, tiered fixtures

**Status**: Future Spec, Issue 1, 2026-04-28
**Targeting**: V1 ship-readiness (test infra refactor; not feature work)
**Related**: Engineering_Guide.md §11.7 (parallel-test safety), RFC-008 (PTY transport — what `kernel.ready` means)
**Driver**: 5-agent mega-round verification surfaced that current "did not become true within Xms" timeouts are opaque — every failure looks the same regardless of root cause (mutex collision, kernel never connected, dispatch didn't fire, output didn't commit).

## 1. Scope

The current test infrastructure has three problems that became blockers during the V1 mega-round verification:

1. **Opaque timeouts.** `waitFor(predicate, timeoutMs)` returns `predicate did not become true within Xms`. The predicate could fail because activation never started, kernel never connected, dispatch didn't fire, or the output didn't commit. Each of those is a different bug; the test infra can't distinguish.
2. **Environmental cross-talk.** A second VS Code instance holding the install mutex causes `vscode-test` to silently downgrade — activation never reaches our extension entrypoint; tests time out 200 seconds later with no useful signal.
3. **Tier conflation.** Unit tests, stub-kernel integration tests, and live-kernel e2e tests share the same `npm run test:contract` script, the same `vscode-test` user-data-dir, and the same heartbeat infra. A live-kernel preflight failure (no Claude CLI; no Pixi env) blocks the unit and stub tiers from running.

This FSP specifies the test infrastructure that closes those three problems. It does **not** touch the wire, data model, runtime, or any production code. It is purely test-side discipline.

## 2. Three pillars

### Pillar A — Failure-mode-typed waits

Replace `waitFor(predicate, timeoutMs)` with **phase-typed** wait helpers, each carrying a numbered failure code in its timeout error message. The numbering joins the existing K-class namespace (K70+ reserved for test-infra failures).

| Helper | Awaits | Timeout error code |
|---|---|---|
| `waitForActivation(ext, timeoutMs)` | `vscode.extensions.getExtension(EXT_ID)?.isActive === true` AND extension's `activate()` `ExtensionApi` available | K70: activation never reached |
| `waitForKernelReady(api, timeoutMs)` | `api.getKernelClient()?.isReady === true` (new accessor — see §3) | K71: kernel.ready handshake never observed |
| `waitForCellComplete(doc, cellIndex, timeoutMs)` | `doc.cellAt(cellIndex)` has at least one output AND its terminal output is a closed RTS_RUN_MIME span (`endTimeUnixNano` set, status non-UNSET) | K72: terminal span never observed |
| `waitForHydrate(loader, uri, timeoutMs)` | the loader's `pending` map no longer contains `uri` AND the applier saw the `hydrate_complete` snapshot | K73: hydrate confirmation never observed |

Each helper logs a structured diagnostic record on timeout: `{code, observed_state, deadline_ms, marker_file_tail}`. Test reporters parse the code and surface a one-line cause instead of "predicate did not become true."

#### What the marker file is

The marker file is a **structured diagnostic stream** that the extension and kernel both write to during their lifecycles. Each event is a single JSON line with `{ts, component, event, fields...}` — e.g. `{"ts": 1234567890, "component": "extension", "event": "activation_started", "session_id": "..."}` or `{"ts": ..., "component": "kernel", "event": "pty_spawn_args", "argv": [...]}`. The path is `${TMPDIR}/llmnb-marker-${session_id}.jsonl`, exposed via env var `LLMNB_MARKER_FILE`.

It already exists in opt-in form (`LLMNB_E2E_VERBOSE=1`, added during the V1 hero-loop debugging). This FSP makes it **always-on for tests** (not for production — production diagnostics go through OTLP per RFC-006). When a typed-wait helper times out, it reads the last 50 lines and includes them in the failure record. That converts "predicate did not become true within 5000ms" into "K71: kernel.ready never observed; last marker = `pty_spawn_args` at +1.2s; no `kernel_ready` observed by deadline."

### Pillar B — Environmental preflight

A `suiteSetup` fixture in each tier verifies the environment **before** any test runs. On any check failure, it skips the entire tier with a clear human-readable reason — no 200-second timeout.

Preflight checks:

| Check | Tier(s) | Failure → |
|---|---|---|
| VS Code install mutex available (no other Code instance) | all extension tiers | Skip with `another VS Code instance is running; close it and retry` |
| `vscode-test` cache populated | all extension tiers | Skip with `vscode-test cache empty; run npm run download-vscode` |
| `pixi run -e kernel python -c "import llm_kernel"` succeeds | live-kernel tier | Skip with `kernel pixi env not installed; run pixi install -e kernel` |
| `claude --version` succeeds | live-kernel tier | Skip with `claude CLI not on PATH; install per docs/setup.md` |
| `ANTHROPIC_API_KEY` env or Claude OAuth session valid | live-kernel tier | Skip with `no Anthropic credentials; set ANTHROPIC_API_KEY or run claude login` |
| Workspace has no orphan kernel processes (no stale `python -m llm_kernel pty-mode`) | live-kernel tier | Skip with `orphan kernel from prior run; kill it and retry` |

Preflight is fast (sub-second per check). It runs once per tier. The skip path emits a structured `tier_skipped` event so CI dashboards can distinguish "skipped due to environment" from "passing" or "failing."

### Pillar C — Tiered fixtures

Three explicit tiers, three npm scripts, isolated `vscode-test` user-data-dirs where applicable.

| Tier | Scope | Runner | Isolation | Cadence |
|---|---|---|---|---|
| **T0 unit** | Pure module tests (no VS Code, no kernel, no I/O) | mocha CLI | n/a | every commit; <5s |
| **T2 stub-integration** | Real extension + existing `StubKernelClient` (in-process) | vscode-test | `.vscode-test/userdata-stub` | every commit; <30s |
| **T3 live-e2e** | Real VS Code + real Pixi Python kernel + Claude CLI | vscode-test | `.vscode-test/userdata-live` | manual + nightly; <60s |

`package.json` scripts:

```json
{
  "test:unit": "mocha --config .mocharc-unit.cjs",
  "test:stub": "vscode-test --user-data-dir=.vscode-test/userdata-stub --config .vscode-test-stub.mjs",
  "test:live": "vscode-test --user-data-dir=.vscode-test/userdata-live --config .vscode-test-live.mjs",
  "test:contract": "npm run test:unit && npm run test:stub"
}
```

`test:contract` (the existing CI entrypoint) becomes T0+T2. `test:live` is opt-in — manual or scheduled. The mutex collision can no longer span tiers because each VS Code-bearing tier has its own user-data-dir, and T0 doesn't touch VS Code at all.

The kernel side already has tiered separation via `pytest -m`; this FSP brings the extension up to parity.

> **Future work — spec-driven state-machine simulators (V3+).** When multi-kernel coordination lands, a simulator pair (kernel sim + extension sim, both walking RFC-006/008 transition tables in-memory) becomes valuable for fault injection and Hypothesis-style property tests. Out of scope for V1; revisit when the wire surface grows or when we hit the first cross-kernel coordination bug.

## 3. New surfaces required

| Surface | Where | Purpose |
|---|---|---|
| `KernelClient.isReady: boolean` | `src/notebook/controller.ts` (interface) | What `waitForKernelReady` polls. PtyKernelClient sets `true` after `kernel.ready` handshake; StubKernelClient sets `true` immediately after `attachRouter`. |
| `ExtensionApi.getActivationDiagnostics()` | `src/extension.ts` | Returns `{activated_at, kernel_started_at, kernel_ready_at, hydrate_count, last_marker}` for failure-mode-typed waits to dump on timeout. |
| `MarkerFileTail` helper | `extension/test/util/marker-tail.ts` | Reads the last N lines of the LLMNB diagnostic marker file; used by all failure-mode-typed waits. |

## 4. Failure modes (K-class — test-infra namespace, K70+)

| Code | Symptom | Diagnostic dump |
|---|---|---|
| K70 | Activation never reached (`extension.isActive === false` after timeout) | VS Code mutex state; vscode-test logs; preflight result |
| K71 | Kernel ready handshake never observed (`isReady === false` after timeout) | Marker file tail; PtyKernelClient state machine state; PTY stderr |
| K72 | Terminal span never observed (cell.outputs empty or no terminal closed span) | Last 50 marker-file lines; controller's inflight map snapshot; kernel emit log if T3 |
| K73 | Hydrate confirmation never observed (loader.pending still has uri) | Marker file tail; metadata-loader emit log; kernel hydrate handler invocation log |
| K74 | Preflight check failed (any) | Which check; expected vs observed; remediation pointer |

K70-K73 are fail-the-test-with-cause. K74 is skip-the-tier-with-reason. CI reports both clearly.

## 5. What this is NOT

- Not a CI overhaul. Existing CI keeps running `test:contract`; the change is internal to that script.
- Not a coverage gate. Coverage stays where it is; this is signal quality, not coverage quantity.
- Not a kernel test refactor. The kernel side is already tiered (`-m unit`, `-m integration`, `-m magic`); this FSP is extension-side parity.
- Not a replacement for paper-telephone smoke or Tier 4 live e2e — those become T1 and T3 of this campaign respectively, not new tests.

## 6. Implementation slice

Single ~4h slice owned by **X-TEST-INFRA**:

1. Refactor existing `waitFor` callers in extension tests to phase-typed helpers (~1h; mechanical, ~12 call sites)
2. Promote marker file from opt-in to always-on for tests; centralize the `MarkerFileTail` helper (~30min)
3. Implement preflight checks (~30min per tier × 2 ≈ 1h)
4. Split `package.json` scripts; create `.vscode-test-stub.mjs`, `.vscode-test-live.mjs`, `.mocharc-unit.cjs` (~30min)
5. Wire `KernelClient.isReady` + `ExtensionApi.getActivationDiagnostics` (~30min)
6. Verify T0+T2+T3 green on a clean machine (~30min)

No new dependencies. No production-code changes outside the two surfaces in §3 (both additive).

## 7. Why this is V1 ship-ready (not V2)

The V1 mega-round verification ritual (per the V1 Kernel Gap Closure plan) requires reading test failures correctly. Today every failure looks like "predicate did not become true within Xms," which is enough signal to know something is broken but not enough to fix it without manual log forensics. That forces the operator to chase phantom regressions when the real issue is environmental.

This FSP closes that gap. It is gates-of-V1 work — without it, declaring V1 "all green" is misleading because we can't tell whether green means "all subsystems functional" or "some failure modes are masked by other failure modes."

## 8. Resolved decisions

- **Q1 — Marker file**: promoted from opt-in (`LLMNB_E2E_VERBOSE=1`) to always-on for tests. Path is `${TMPDIR}/llmnb-marker-${session_id}.jsonl`, exposed via `LLMNB_MARKER_FILE`. Production stays OTLP-only; the marker file is test-infra. See Pillar A "What the marker file is."
- **Q2 — T3 live-e2e budget**: no budget. Tests use as many Anthropic API calls as needed. The operator can rate-limit at the OAuth/key level if desired; the test infra does not enforce.
- **Q3 — Kernel-side parity**: kernel pytest already emits structured failures (`-v --tb=short`); not a parity gap today. If multi-kernel coordination later exposes new failure modes that need typed waits or a simulator, revisit (see future-work note in Pillar C).

## Changelog

- **Issue 1, 2026-04-28**: initial. Three pillars proposed (typed waits, preflight, tiered fixtures); three open questions flagged.
- **Issue 2, 2026-04-28**: Q1/Q2/Q3 resolved. Marker file promoted to always-on; no T3 budget; full simulator pair (originally Pillar D) trimmed to a future-work note in Pillar C — overkill for V1 (1 kernel + 1 extension + 1 operator), revisit at V3 multi-kernel. Single ~4h X-TEST-INFRA slice; T0/T2/T3 tier table.
