# Overnight session report — 2026-04-28

**Scope**: closed-out the post-mega-round triage and pushed the first persistent-Claude slice. 7 commits in parent + 4 commits in submodule.

## What landed

| # | Commit | Slice |
|---|---|---|
| 1 | `b4ec3e3` | Controller race fix (stub-kernel exec.end before await) + stale TCP test |
| 2 | `e26a352` | FSP-003 Pillar A scaffolding (typed-wait helpers, marker-tail, preflight) — **partial** |
| 3 | `ad6ccd1` | FSP-001/002/003 specs (cells→OpenUI, in-cell search, test campaign) |
| 4 | `0e2b3ac` | bump submodule: BSP-003 §10 intent dispatcher + test infra fixes |
| 5 | `73a71df` | bump submodule: socket `set_inheritable(False)` + read-loop instrumentation |
| 6 | `433e01c` | bump submodule: revert pty-mode to legacy `main()` (BSP-004 V2 not yet verified) |
| 7 | `c021557` | FSP-003 Pillar A: **complete** — last `waitFor` callers refactored to typed waits |
| 8 | `0938c86` | BSP-004 v2.0.1 — Issue 2 retrospective + V3 (sock_recv) plan |
| 9 | `45e127b` | bump submodule: BSP-002 §4 Phase 1 + K-CM respawn logging + BSP-004 V2 (uvicorn + dedicated thread) |

Submodule (`vendor/LLMKernel`) commits: `f7e12f8`, `ae5849c`, `51cc7a4`, `6b543b5`, `6316037`, `b9293e0`.

## Verified state

| Suite | Result | Notes |
|---|---|---|
| Kernel pytest | **317 pass / 0 fail** | +4 from Phase 1 persistent-Claude tests |
| Extension `npm run build` | clean | |
| Extension `npm run build:tests` | clean | |
| Extension `npm run test:contract` | unverified here | environmental — needs claude on PATH + no other VS Code instance. Preflight (Pillar B) now correctly skips with K74 reason instead of timing out. |
| Tier 4 e2e | unverified here | same as above. Last failing-run marker showed kernel boots fine + spawn dispatches; the regression is in the read loop after spawn. **The `set_inheritable(False)` fix on the data-plane socket should address it.** Legacy `main()` is the dispatch path now (not BSP-004 uvicorn) — V2 retry exists in tree but is gated behind verification. |

## Notable architecture moves

### Test #4 (live `/spawn` 180s timeout) — root-cause analysis

Marker file from a failing run (`llmnb-e2e-markers-44504-...`):
```
agent_spawn_received → supervisor_spawn_popen_started (pid=53016)
  → agent_spawn_returned
[+1.4s]
async_serve_socket_exited
```

The kernel's `_run_read_loop` exits 1.4s after the agent_spawn handler returns. Hypothesis: on Windows, `subprocess.Popen` (called from a thread-pool executor worker that's mid-`select()` on the data-plane socket) inherits the inheritable socket fd, and OS-level handle-lifecycle interaction EOFs the parent's `recv`.

**Fix shipped:** `socket.set_inheritable(False)` on the data-plane socket in [socket_writer.py:97](vendor/LLMKernel/llm_kernel/socket_writer.py#L97). Strict improvement on Windows regardless of dispatch model.

**Dispatch reverted to legacy `main()`** (commit `6b543b5`) per your "go back to the last time it worked" direction. BSP-004 V2 (uvicorn + dedicated `threading.Thread` for read loop) exists but is not the active path. V3 (sock_recv-based, actually leverages asyncio) sketched in BSP-004 v2.0.1.

### BSP-002 §4 Phase 1 — persistent Claude

Phase 1 lays groundwork without changing operator-visible behavior:
1. `AgentHandle.claude_session_id` — UUID assigned at fresh spawn time
2. `--session-id <uuid>` passed to claude
3. Spawn idempotency — second `/spawn alpha` while first is alive returns the existing handle (no double-Popen)

Phase 2 (queued) adds `--resume <claude_session_id>` for dead-process re-spawn. Phase 3+ adds stdin-based @alpha continuation (`--input-format=stream-json`).

### FSP-003 Pillar A complete

Every `waitFor` call site in extension tests now uses `waitForActivation`/`waitForKernelReady`/`waitForCellComplete`/`waitForHydrate` with K-coded errors and marker-tail dumps. No more "predicate did not become true within Xms" — every timeout has a cause.

### K-AS / K-CM vocabulary

The mega-round flagged a mismatch on `respawn_from_config` return values. Resolution: K-AS's vocabulary (`spawned | skipped | failed`) is the contract. K-CM previously discarded the return value (no runtime bug). Now [custom_messages.py:898+](vendor/LLMKernel/llm_kernel/custom_messages.py#L898) captures and logs the breakdown at INFO with structured extras (`kernel.hydrate.respawn_summary`).

## What's left for verification on your machine

1. **Tier 4 e2e (`npm run test:live` from `extension/`)** — needs `claude` on PATH (or shell with pixi env active) and no other VS Code instance holding the install mutex. Expected outcome: spawn dispatches, kernel reads notify span, cell renders. If this passes, V1 substrate is verified end-to-end.

2. **Extension contract suite (`npm run test:contract`)** — same env requirements (mutex). Should be 104 pass / 0 fail since the controller race fix and stale TCP fix landed.

If Tier 4 fails:
- Read the marker file (path printed in test output) — the new break-reason markers (`read_loop_select_error` / `read_loop_recv_error` / `read_loop_peer_eof` / `read_loop_shutdown_event_set`) will name which path fired.
- If `read_loop_peer_eof` again → `set_inheritable(False)` wasn't enough; consider `subprocess.Popen` `creationflags=DETACHED_PROCESS` on Windows.
- Other break paths → different bug; the marker error message will name it.

## What I did NOT do (deliberately deferred)

- **BSP-002 §4 Phase 2 (`--resume` plumbing)** — requires verifying `claude --print --resume` semantics, which I can't test without claude on PATH.
- **BSP-004 V3 (sock_recv-based async dispatch)** — sketched in [BSP-004 v2.0.1](docs/notebook/BSP-004-kernel-runtime.md); deferred until V1 ships.
- **Cell-as-agent-identity rendering (BSP-002 §6)** — extension-side UX work; queued for after V1 substrate ship.
- **The remaining `profile_default/history.sqlite`** modification — local IPython state; should be gitignored, not committed.

## Recommended morning checklist

1. Pull latest, eyeball the 9 commits since `b082963`
2. Close any stray VS Code instances
3. From `extension/`: `npm run test:contract` → expect 104 pass
4. From `extension/`: `npm run test:live` → expect the live-spawn test green (or marker-tail diagnostic if not)
5. Decide: ship as V1 if tests pass, or investigate marker output if not
