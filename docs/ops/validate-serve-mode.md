# Validate `python -m llm_kernel serve` end-to-end

**Status:** Pending — never run against a live kernel.
**Filed:** 2026-05-07 after Tier-3 smoke surfaced 3 harness bugs in the
PTY-spawn path (commit 28c3658). Same risk class likely lurks in serve
mode; we just haven't paid for the discovery yet.
**Owner:** unassigned.

## Why

`serve_mode.py` (664 LoC, PLAN-S5.0.3d) lets the kernel run as a
standalone TCP server. The extension, CLI, and future external drivers
could all attach to one shared kernel instead of each spawning its own
PTY. The code shipped with unit tests but **no live integration smoke**.
The Tier-3 PTY smoke campaign just caught three bugs that unit tests
could not detect:

1. `--input-format=stream-json` ignores the trailing positional argv,
   so the harness never seeded the agent's first turn
2. `_log_run` collided with `LogRecord.name` (KeyError on every tool
   call; tools appeared "unavailable" to the agent)
3. stdin never closed → claude waited indefinitely for the next turn

The serve path has its own list of integration seams that have never
been exercised end-to-end. Bugs of equivalent class may exist there.

## Acceptance criteria

A serve-mode smoke that:

1. Boots `python -m llm_kernel serve --bind 127.0.0.1:<port>` with
   `LLMNB_AUTH_TOKEN` set
2. Connects via `llm_client.connect_to_kernel(transport="tcp", bind=...,
   auth_token=...)` from a SEPARATE Python process (not in-process
   scaffolding — that path is `boot_minimal_kernel`)
3. Drives one full agent turn: `notify` + `report_completion` reach
   the run-tracker
4. Disconnect cleanly; kernel keeps running
5. Re-connect a second time; second turn succeeds
6. Wrong auth token → `auth_failed` envelope and connection close on
   the kernel side; client surfaces the auth error
7. Second concurrent connection → `kernel_busy` rejection
8. SIGINT to the kernel → graceful shutdown (final snapshot emitted,
   no zombie processes)

Each criterion gets one test in `vendor/LLMKernel/tests/test_serve_smoke.py`
(or per the existing test layout convention).

## Known integration seams to exercise

These are the surfaces most likely to harbor PTY-equivalent bugs:

- **Bearer-token compare** under env-var read timing (token loaded
  before bind? after?). Constant-time compare via `hmac.compare_digest`
  is in place; verify it's actually called on every connection.
- **Handshake envelope shape** — RFC-006 envelope vs whatever
  `serve_mode.handshake` accepts. If shapes drift, clients silently
  fail to attach.
- **Proxy-mode plumbing** — `--proxy passthrough` starts a local mitm
  server inside the serve process. Same ANTHROPIC_BASE_URL plumbing as
  PTY mode, but inside a long-lived server. The kernel.stderr capture
  pattern from PTY mode does NOT apply.
- **Reader thread on the TCP socket** — analogous to the PTY stdout
  reader. Same back-pressure risk: if the reader thread blocks, the
  client's stdout buffer fills and claude (driven by the client) hangs.
- **Claude binary resolution from a long-lived server** — the
  `LLMNB_CLAUDE_BIN` discovery probe is per-spawn. A serve-mode kernel
  spawns claude per agent; verify each spawn correctly resolves the
  binary even when the env var changes between spawns (it shouldn't,
  but the surface exists).
- **Kernel survives client disconnect** — the docstring claims this;
  no test validates it.
- **`kernel_busy` on second connection** — V1 single-client; second
  client should reject before any work is dispatched.
- **SIGINT graceful shutdown** — terminate_all + final snapshot. PTY
  mode goes through this; serve mode's path has not been exercised.

## Out of scope

- TLS (V2; trusted-network model for V1)
- Multi-client concurrent (V2; PLAN-S5.0.3 §10 risk #4)
- Unix-socket transport (V2)
- BSP-004 V3 async dispatch (deferred per BSP-004 v2.0.1 §"V3 plan")

## Suggested approach

Mirror the PTY Tier-3 layout: a `_run_serve_smoke` in
`vendor/LLMKernel/llm_kernel/__main__.py` that boots `serve` in a
subprocess, drives one agent turn from the parent, and asserts on the
run-tracker. Cost: ~1-2h for the happy path; an additional ~1-2h for
the failure-path tests (auth_failed, kernel_busy, SIGINT). Total
**~2-4h** for a complete validation tier.

This task should land before the headless `llmnb` CLI ships against a
serve-mode kernel, since the CLI is the first non-test driver that
will attach over TCP and any latent bugs become user-visible there.

## Related

- [PLAN-S5.0.3 driver-extraction](../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md)
- [serve_mode.py](../../vendor/LLMKernel/llm_kernel/serve_mode.py)
- [Testing.md §"Tier 3"](../../Testing.md) — the existing PTY smoke
- Commits 28c3658 / b275e94 — Tier-3 PTY smoke fixes (the parallel work
  this task mirrors)
