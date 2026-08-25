# Kernel wiring audit — current subsystem construction map

**Status**: _preparatory_ (the leading underscore in the filename marks
it as not-yet-reference). This doc is scaffolding for
[`PLAN-kernel-facade.md`](../../06%20-%20Roadmaps/PLAN-kernel-facade.md)
Phase 2, commit 1. It maps how the kernel is **actually wired today** so
the `Kernel` facade can be built against reality rather than against the
plan's stale `file:line` anchors (the plan was written against a flat
module layout that has since been reorganized into subpackages). Absorb
the durable parts into `architecture.md` when the refactor lands, then
delete this file. It is intentionally **not** listed in the kernel
[`README.md`](README.md) file table.

Every `file:line` below was opened and confirmed against the submodule
at its current pin. Kernel package root:
[`vendor/LLMKernel/llm_kernel/`](../../../vendor/LLMKernel/llm_kernel/).
Paths are given relative to that root.

> **Headline finding.** Three of the facade plan's construction-outline
> steps do not match the current code: (1) there is no
> `attach_operator_bridge` helper; (2) `MCPManager` is **not** part of
> subsystem-attach wiring at all; (3) `MetadataWriter` takes **no**
> `event_log_path` — there is no `events.jsonl` anywhere in the tree.
> The `os._exit(rc)` the plan attributes to `pty_mode.boot_kernel:45`
> actually lives in `app.py:46`, and `app.py` is **dormant scaffolding**
> — the live `pty-mode` path is the legacy synchronous
> `pty_mode.main()`. See §6 and §7.

---

## 1. Subsystem inventory

Each subsystem is a discrete, well-bounded class. All five core capture
subsystems are internally thread-safe via `threading.RLock` (the
supervisor and dispatcher are held on hot paths, hence *reentrant*
locks). The MCP outbound client is async, not locked.

| Subsystem | Class | Module (rel. to pkg root) | Constructor signature (required + notable) | Thread-safety |
|---|---|---|---|---|
| Dispatcher | `CustomMessageDispatcher` | [`capture/custom_messages.py`](../../../vendor/LLMKernel/llm_kernel/capture/custom_messages.py) `:156` | `(kernel, comm_target="llmnb.rts.v2", buffer_size, heartbeat_interval_sec, *, read_only=False)` — only positional dep is a kernel-shaped object exposing `.session`, `.iopub_socket`, `.shell.comm_manager`, `._parent_header`. | `self._lock: RLock` `:175`. `start()`/`stop()`/`emit()` all lock. Runs a heartbeat daemon thread. |
| Run tracker | `RunTracker` | [`capture/run_tracker.py`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py) `:184` | `(trace_id, sink, agent_id=None, zone_id=None, ...)` — `sink` is normally the dispatcher (anything with the `Sink` protocol / `emit`). `trace_id` coerced to 32-hex OTLP. | `self._lock: RLock` `:200`. `start_run`/`complete_run`/`iter_runs` lock. |
| Metadata writer | `MetadataWriter` | [`capture/metadata_writer/_writer.py`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) `:44` | `(dispatcher=None, run_tracker=None, session_id=None, blob_threshold_bytes, autosave_interval_sec, event_log_queue_cap, workspace_root=None, intent_queue_overflow_threshold)` — **all optional**. No `event_log_path`. `workspace_root` defaults to `Path.cwd()` and is only used for the queue-overflow disk fallback (`.llmnb-overflow-*.json`, `.llmnb-intent-queue/`). | `self._lock: RLock` `:72` + `self._intent_queue_lock: RLock` `:163`. `start()` spins a 30s autosave timer thread; `stop(emit_final=True)` joins it. |
| Agent supervisor | `AgentSupervisor` | [`supervision/agent_supervisor.py`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py) `:176` | `(run_tracker, dispatcher, litellm_endpoint_url, kernel_python=sys.executable, agent_silence_threshold_seconds, silence_watchdog_granularity_seconds)` — three required deps. | `self._lock: RLock` `:206` (reentrant; held on spawn/restart while logging re-enters) + `self._auto_flip_lock: Lock` `:223`. Runs on threads, not asyncio; each agent gets two daemon reader threads + a watchdog. |
| Operator bridge | `OperatorBridgeServer` | [`mcp/mcp_server.py`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py) `:116` | `(agent_id, zone_id, trace_id=None, run_tracker=None, dispatcher=None)` — the internal stdio MCP server agents connect to. `run_stdio()` `:1707` is the async serve loop; `main()` `:1749` is the `mcp-server` subcommand entry. | `self._pending_lock: Lock` `:165` (operator round-trips), `self._rate_lock: Lock` `:174` (non-reentrant by design — must not log inside it). |
| MCP outbound client | `MCPManager` | [`mcp/mcp_manager.py`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_manager.py) `:24` | `(logger=None)` — FastMCP-based outbound client. All methods `async` (`connect_server`, `call_tool`, `disconnect_all_servers`, …). | Not lock-guarded; async, single-loop. **Only constructed in [`kernel.py`](../../../vendor/LLMKernel/llm_kernel/kernel.py) `:135`** (the IPython `LLMKernel`), never in the attach helpers or the subcommand boots. |

---

## 2. Canonical construction / wiring order (`_kernel_hooks.py`)

Read in full: [`_kernel_hooks.py`](../../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py).
This is the **existing canonical wiring order** the facade's `start()`
must reproduce. Every helper stashes its product on a `kernel._llmnb_*`
attribute and is **idempotent** (returns the existing instance if
already attached).

| Helper | Line | Constructs | Order / cross-wiring |
|---|---|---|---|
| `attach_dispatcher` | `:43` | `CustomMessageDispatcher(kernel)`, then calls `dispatcher.start()` immediately. | Foundation; everything else depends on it. Stashes `_llmnb_dispatcher`. |
| `attach_run_tracker` | `:58` | `RunTracker(trace_id, sink=dispatcher, agent_id, zone_id)`. | Calls `attach_dispatcher` first so the sink exists. Stashes `_llmnb_run_tracker`. |
| `attach_agent_supervisor` | `:83` | `AgentSupervisor(run_tracker, dispatcher, litellm_endpoint_url=url)`. | `url` = arg → `LLMKERNEL_LITELLM_ENDPOINT_URL` env → `_DEFAULT_LITELLM_ENDPOINT` (`http://127.0.0.1:8000/v1`, `:40`). Stashes `_llmnb_agent_supervisor`. |
| `attach_metadata_writer` | `:109` | `MetadataWriter(dispatcher, run_tracker)`, then `writer.start()` (30s autosave). | Stashes `_llmnb_metadata_writer`. |
| `attach_kernel_subsystems` | `:132` | **One-call bootstrap.** See ordered steps below. | Returns the 5-tuple `(dispatcher, tracker, bridge, supervisor, metadata_writer)`. |

**There is no `attach_operator_bridge` helper.** The plan lists one; it
does not exist. The `OperatorBridgeServer` is constructed *inline* inside
`attach_kernel_subsystems` at `:154`.

### `attach_kernel_subsystems` step order (`:132`–`:168`)

1. Read identity from env (`:147`–`:149`): `LLMKERNEL_AGENT_ID`
   (default `"kernel"`), `LLMKERNEL_ZONE_ID` (default `"default"`),
   `LLMKERNEL_RUN_TRACE_ID` (default fresh UUID4).
2. `dispatcher = attach_dispatcher(kernel)` `:150` (also `start()`s it).
3. `tracker = attach_run_tracker(kernel, trace_id, agent_id, zone_id)` `:151`.
4. `bridge = OperatorBridgeServer(agent_id, zone_id, trace_id, run_tracker=tracker, dispatcher=dispatcher)` `:154`, stashed on `_llmnb_operator_bridge` `:158`.
5. `supervisor = attach_agent_supervisor(kernel, tracker, dispatcher)` `:159`.
6. `metadata_writer = attach_metadata_writer(kernel, dispatcher, tracker)` `:160` (also `start()`s the autosave).
7. **Cross-wire the bridge** (`:165`–`:167`): `bridge.kernel = kernel`,
   `bridge.agent_supervisor = supervisor`, `bridge.metadata_writer =
   metadata_writer` — so the bridge's `agent_spawn` / `drift_acknowledged`
   routes resolve without falling through to the kernel-attribute probe
   (the synthetic `_PtyKernel` doesn't expose them).

> **The dispatcher's own collaborators are wired *outside* this helper.**
> `attach_kernel_subsystems` wires the *bridge*'s collaborators but does
> **not** call `dispatcher.set_metadata_writer` / `set_agent_supervisor`
> / `set_shutdown_event` / `set_drift_detector` / `set_current_volatile_provider`,
> nor `supervisor.set_metadata_writer`. Those `set_*` calls happen in the
> **transport boot** (pty_mode; see §3) after the 5-tuple returns. The
> facade must reproduce *both* halves.

---

## 3. Per-entry-point boot map

There are four live wiring paths plus the dormant BSP-004 scaffold. Who
constructs, who owns the event loop, and what teardown exists differ
sharply across them.

### 3a. `transports/pty_mode.py` — the live PTY+socket kernel

The `pty-mode` subcommand dispatches to `pty_mode.main()` directly
(see §3d), **not** to `app.py`/uvicorn. `main()` `:284` is the
authoritative boot sequence today.

Boot order inside `main()`:

1. Read `LLMKERNEL_IPC_SOCKET` `:293`; **fail fast `return 2`** if absent (`:297`–`:303`).
2. Optional termios raw mode (`_set_raw_mode_if_tty`, POSIX+TTY only) `:307`.
3. `SocketWriter().connect(address)` `:309`–`:311`; **`return 3`** on `OSError` (`:312`–`:320`).
4. Write the boot banner to PTY stderr `:326`.
5. `_emit_ready_handshake(writer, session_id)` `:335` — RFC-008 §4 first data-plane frame, *before* any subsystem logs.
6. `_start_owned_proxy_or_none()` `:343` (BSP-001 proxy lifecycle). Sentinels: `_PROXY_START_FAILED` → **`return 12`** (`:344`); `_PROXY_CONFIG_REJECTED` → **`return 11`** (`:349`). On success sets `LLMKERNEL_LITELLM_ENDPOINT_URL` env so `attach_agent_supervisor` reads it.
7. Install `OtlpDataPlaneHandler` on root + `llm_kernel` loggers, strip stdout StreamHandlers `:358`–`:364` (`_install_handler` returns a restorer).
8. `kernel = _PtyKernel(writer)` `:367` — the synthetic kernel shell (`_PtyKernelSession`, `_PtyCommManager`, `_PtyComm`, `_PtyShell`, lines `:90`–`:229`) that routes IOPub `session.send` and Comm traffic onto the `SocketWriter`.
9. `attach_kernel_subsystems(kernel)` `:371` → 5-tuple (this is the §2 canonical order).
10. **Dispatcher collaborator wiring** `:387`–`:395`: `set_shutdown_event`, `set_metadata_writer`, `set_agent_supervisor`, `set_drift_detector(DriftDetector())`.
11. `dispatcher.start()` **again** `:402` — idempotent (guarded by `_started`, `custom_messages.py:356`); the second call is what registers the Comm target on the synthetic kernel so inbound envelopes reach handlers.
12. `set_current_volatile_provider(...)` `:405`–`:420`.
13. Install SIGINT/SIGTERM handlers `:422`–`:444` (SIGINT → `interrupt_event`, SIGTERM → `shutdown_event`); `ValueError` swallowed when not on the main thread.
14. `_run_read_loop(...)` `:452` — blocking select/recv loop parsing newline-delimited frames, dispatching via `_dispatch_inbound_line` → `comm_manager.deliver("llmnb.rts.v2", …)`.

**Event-loop ownership**: none. `pty_mode.main` is fully synchronous +
threads. No asyncio.

**Teardown** (`main`'s `finally` `:455`–`:485`), in order:
`metadata_writer.snapshot(trigger="shutdown")` → `metadata_writer.stop(emit_final=False)`
→ `dispatcher.stop()` → `proxy_server.stop()` (if kernel-owned) →
`writer.close()` → `termios_restore()` → `handler_restore()`. Returns 0.

`boot_kernel()` `:746` and `shutdown_kernel()` `:882` are a **separate,
duplicated** copy of this sequence packaged for the (dormant) `app.py`
lifespan: `boot_kernel` returns either a `state` dict `:865`–`:879` or an
`int` rc on early failure (2/3/11/12) — it never calls `os._exit`;
`shutdown_kernel` `:882` mirrors the same teardown order.
`_async_serve_socket` `:665` runs `_run_read_loop` on a **dedicated
thread** (not the executor pool — see the docstring's Windows
`subprocess.Popen` rationale) and is only referenced by `app.py`.

### 3b. `transports/serve_mode.py` — TCP transport with bearer-token auth

`main()` `:525`. Independent, **minimal** subsystem boot — it does *not*
use `_kernel_hooks` and constructs no supervisor, bridge, or metadata
writer.

Boot order:

1. Parse argv (`_build_parser` `:68`); read token from the env var named by `--auth-token-env` (default `LLMNB_AUTH_TOKEN`) `:537` — **never from argv** (leaks via `ps`). Missing token → **`return 2`**.
2. `_parse_bind` `:548`; `0.0.0.0` prints a trusted-network warning `:554`.
3. Bind + listen on TCP `:564`–`:568`; bind failure → **`return 3`**.
4. `_boot_kernel_for_serve(proxy_mode)` `:263` — builds a **`MagicMock` kernel** `:279` with hand-rolled `_Session` / `_CommMgr`, then constructs only `CustomMessageDispatcher(kernel)` `:295` + `RunTracker(...)` `:296`, plus an optional proxy server. Returns a small state dict.
5. Install SIGINT/SIGTERM → `stop_event.set()` + `listener.shutdown` `:596`–`:612`.
6. Accept loop `:617`–`:650`: one connection at a time (second client gets `kernel_busy` via `_busy_close` `:486`); per-connection work on a daemon thread running `_serve_connection` `:349`.

Auth is in `_validate_handshake` `:210`: wire-major must match
(`version_mismatch_major` else), bearer scheme required, constant-time
`hmac.compare_digest` `:250`, else `auth_failed`. Outbound frames are
tapped by **monkey-patching `dispatcher.emit`** `:404`–`:413` (restored on
disconnect).

**Event-loop ownership**: none — threading model, deliberately (see the
module docstring's "Threading, not asyncio" rationale).

**Teardown**: `stop_event.set()` → `listener.close()` →
`active_thread.join(timeout=5)` → `_teardown_serve_kernel(boot_state)`
`:328` (which only stops the optional proxy). Returns 0.

### 3c. `app.py` — FastAPI `lifespan` (BSP-004, **currently dormant**)

[`app.py`](../../../vendor/LLMKernel/llm_kernel/app.py). The
`@asynccontextmanager lifespan` `:30` is the BSP-004 asyncio-under-uvicorn
runtime — but **nothing invokes it in the live path** (§3d shows
`pty-mode` uses the legacy sync `main`). Treat it as scaffolding the
facade will supersede, not preserve verbatim.

- Module-level `_state: Dict` `:26` and `_serve_task` `:27` hold subsystem state (not `app.state`).
- `state_or_rc = pty_mode.boot_kernel()` `:37`. If an `int` (boot failed), it writes stderr and calls **`os._exit(state_or_rc)`** `:46` — this is the real location of the `os._exit(rc)` the plan cites (the plan misattributes it to `pty_mode.boot_kernel:45`). The comment `:44`–`:45` says the codes match legacy `pty_mode.main` (2/3/11/12); uvicorn would not otherwise propagate the failure.
- On success: `_state.update(state_or_rc)` `:48`; `_serve_task = asyncio.create_task(pty_mode._async_serve_socket(_state))` `:49`.
- `yield` `:53`; on shutdown `:54`–`:74`: set `_state["async_done"]`, `await asyncio.wait_for(_serve_task, 2.0)` (cancel on timeout), `pty_mode.shutdown_kernel(_state)`, `_state.clear()`.
- `GET /health` `:80` reads `_state.get("session_id")` (module dict, not `app.state`).

### 3d. `__main__.py` — subcommand dispatch

[`__main__.py`](../../../vendor/LLMKernel/llm_kernel/__main__.py). The
`if __name__ == '__main__'` block `:664`–`:751` routes subcommands:

| Subcommand | Line | Wires / boots |
|---|---|---|
| `mcp-server` | `:686` | `mcp_server.main(argv)` — the `OperatorBridgeServer` stdio server. |
| `litellm-proxy` | `:690` | `_run_litellm_proxy` `:67` — proxy only; blocks on signal. |
| `serve` | `:716` | `serve_mode.main(argv)` (§3b). |
| **`pty-mode`** | **`:723`** | `pty_mode.main(argv)` `:740` — **the legacy synchronous path, explicitly labeled "the known-good V1 path"** `:724`. It does **not** import uvicorn or touch `app.py`. |
| `pty-mode-smoke` / `*-smoke` | `:692`–`:749` | In-process smoke harnesses. |
| *(no subcommand)* | `:750` | `main()` `:55` → `LLMKernelApp` (IPython kernel; see §3e). |

The comment block `:723`–`:739` records that BSP-004 (uvicorn) was tried
twice and regressed Tier-4 e2e both times, so `pty-mode` was reverted to
`pty_mode.main` while the `app.py`/`boot_kernel` scaffolding is carried
forward for a future V3.

### 3e. Legacy IPython path — `attach_kernel_subsystems` on an `IPythonKernel`

[`kernel.py`](../../../vendor/LLMKernel/llm_kernel/kernel.py) `LLMKernel`
`:61`. `__init__` `:85` constructs `self.mcp_manager = MCPManager(...)`
`:135` (the **only** `MCPManager` construction in the tree) and calls
`attach_kernel_subsystems(self)` `:176`. Here the *kernel itself* is the
real `IPythonKernel` — a **different ownership model** than the synthetic
`_PtyKernel`: subsystems live as `self._llmnb_*` attributes on the live
kernel and IOPub flows through the real Jupyter session, not a
`SocketWriter`. The facade plan **keeps this path as-is** (out of scope);
note it but do not migrate it.

`do_shutdown(restart)` `:657` teardown order: `dispatcher.stop()` →
`mcp_manager.disconnect_all_servers()` (async, via loop) → OpenAI
assistant cleanup → `executor.shutdown(wait=False)` → `super().do_shutdown`.

---

## 4. Shutdown ordering (what exists today)

Teardown consistently **reverses construction** and always runs a final
metadata snapshot first. Consolidated:

| Path | Order |
|---|---|
| `pty_mode.main` finally `:455` | snapshot(`shutdown`) → `metadata_writer.stop(emit_final=False)` → `dispatcher.stop()` → proxy.stop() → writer.close() → termios_restore → handler_restore |
| `pty_mode.shutdown_kernel` `:882` | identical to above (mirror for `app.py`) |
| `app.py` lifespan `:54` | signal `async_done` → await/cancel serve task → `shutdown_kernel(_state)` → `_state.clear()` |
| `serve_mode.main` finally `:651` | stop_event → listener.close → join conn thread → `_teardown_serve_kernel` (proxy only) |
| `kernel.py do_shutdown` `:657` | dispatcher.stop → mcp_manager.disconnect_all → assistant cleanup → executor.shutdown |

The supervisor's own `terminate_all(grace_seconds=10.0)`
[`agent_supervisor.py:1745`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)
is **not called by any current boot path's teardown** — the live paths
(pty/serve) never construct a supervisor that outlives the process, and
the IPython path relies on process exit. The facade's `shutdown()` will
be the *first* caller to add `supervisor.terminate_all()` to a teardown
sequence; there is no existing ordering to copy for it, so slot it
**before** the metadata flush (agents should stop emitting before the
final snapshot).

---

## 5. Facade construction plan, grounded in real code

What `Kernel.start()` must construct/wire, mirroring the real calls. This
is the §2 canonical order **plus** the pty_mode collaborator wiring
(§3a steps 10–12), minus the transport.

1. Build/adopt a kernel-shaped object. Embedded/library use has no
   IPython kernel and no socket; the facade needs its own shell
   analogous to `_PtyKernel` but routing IOPub to an in-process sink
   rather than a `SocketWriter`. **This does not exist yet** — it is new
   code the facade must supply (the plan under-specifies it).
2. `CustomMessageDispatcher(kernel)` + `dispatcher.start()` — mirrors
   `attach_dispatcher` (`_kernel_hooks.py:43`).
3. `RunTracker(trace_id=<fresh uuid4/hex>, sink=dispatcher, agent_id, zone_id)`
   — mirrors `attach_run_tracker` (`:58`).
4. `MetadataWriter(dispatcher=dispatcher, run_tracker=run_tracker, workspace_root=workdir)`
   + `writer.start()` — mirrors `attach_metadata_writer` (`:109`).
   **Use `workspace_root=workdir`, not `event_log_path`** (see §6).
5. `AgentSupervisor(run_tracker, dispatcher, litellm_endpoint_url=url)`
   — mirrors `attach_agent_supervisor` (`:83`); resolve `url` the same
   way (arg → `LLMKERNEL_LITELLM_ENDPOINT_URL` → `_DEFAULT_LITELLM_ENDPOINT`).
6. *(Optional, if the facade wants agent MCP connectivity)* construct
   `OperatorBridgeServer(agent_id, zone_id, trace_id, run_tracker, dispatcher)`
   inline and cross-wire `bridge.kernel / .agent_supervisor /
   .metadata_writer` — mirrors `attach_kernel_subsystems:154`–`167`.
7. Collaborator wiring on the dispatcher (mirror `pty_mode.py:387`–`420`):
   `set_metadata_writer(writer)`, `set_agent_supervisor(supervisor)`,
   `set_drift_detector(DriftDetector())`, `set_current_volatile_provider(...)`,
   and `set_shutdown_event(...)` if the facade owns a shutdown signal.
   Consider also `supervisor.set_metadata_writer(writer)`
   ([`agent_supervisor.py:2479`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py))
   for the contamination detector — currently no path calls it.
8. **Do NOT construct `MCPManager`** in `start()` — it is not part of
   this wiring (§6). The plan's step 5 is wrong.

`shutdown()` reverses (new ordering, since no path does all of this today):
`supervisor.terminate_all()` → `metadata_writer.snapshot(trigger="shutdown")`
→ `metadata_writer.stop(emit_final=False)` → `dispatcher.stop()` →
(bridge/transport stop) → any owned proxy stop. Make it idempotent
(each subsystem's `stop`/`start` already guards on a `_started` flag).

**Default `event_log_path`**: the plan proposes `workdir/.llmnb/events.jsonl`.
**This does not exist and cannot be honored as written** — `MetadataWriter`
has no `event_log_path` parameter and there is no `events.jsonl` sink in
the codebase (verified by full-tree grep). The event log is an in-memory
list of OTLP spans surfaced only inside the Family F `notebook.metadata`
snapshot; historical projection is done by `EventLogReplayer`
([`capture/event_log.py:123`](../../../vendor/LLMKernel/llm_kernel/capture/event_log.py))
over a list of envelopes. If the facade wants durable `read_event_log` /
`subscribe_events`, that is **net-new persistence**, not a parameter
wire-up — flag it for the facade class design (commits 2/4).

---

## 6. Risks & subtleties for the refactor

1. **`os._exit(rc)` lives in `app.py:46`, not `pty_mode`.** `boot_kernel`
   *returns* an int rc; `app.py` translates it to a hard `os._exit`
   because uvicorn won't propagate a lifespan-startup failure. The live
   `pty_mode.main` instead **`return`s** the rc (2/3/11/12) up to
   `sys.exit` in `__main__`. The facade's `start()` runs inside a
   caller's event loop with no process to hard-exit — mirroring
   `os._exit` there would kill the embedding host. **Raise a typed
   exception carrying the rc instead**, and let subprocess wrappers
   translate it back to an exit code. This is the single most important
   semantic to get right, and the plan's guidance ("mirror the
   `os._exit`") is wrong for the embedded case.

2. **`MCPManager` is not a capture subsystem.** It is the *outbound*
   FastMCP client, constructed only in the IPython `LLMKernel:135`. No
   subcommand boot, no attach helper, and no test-fixture wiring touches
   it. Including it in `Kernel.start()` (plan step 5) would introduce a
   dependency none of the behavior-preserving paths have. Omit it.

3. **`MetadataWriter` has no `event_log_path` / `events.jsonl`.** See §5.
   Building the facade around a durable JSONL event log is designing
   against a sink that does not exist. Either drop the parameter or
   scope in real persistence explicitly.

4. **The dispatcher is `start()`ed twice today** (`attach_dispatcher:52`,
   then again in `pty_mode:402`). It is idempotent
   (`custom_messages.py:356`), but the *second* call is load-bearing on
   the synthetic kernel — it registers the Comm target after the shell
   exists. The facade must ensure Comm-target registration happens
   against whatever kernel shell it builds (§5 step 1), not assume the
   first `start()` sufficed.

5. **`_state` module dict vs `app.state.kernel`.** `app.py` uses a
   module-global `_state` and `_serve_task`, and `/health` reads the
   module dict `:88`. The plan's commit 8 moves to `app.state.kernel`;
   that is a real behavior change to the health endpoint's data source —
   fine, but it must be done atomically with the endpoint edit (`:80`),
   and remember `app.py` is dormant, so this commit changes scaffolding,
   not the live pty path.

6. **Event-loop ownership.** No current capture path owns an asyncio
   loop — pty and serve are sync+threads; only `app.py` (dormant) and
   `MCPManager`/`OperatorBridgeServer.run_stdio` are async. The plan's
   `get_running_loop()`/no-`asyncio.run` contract is sound *because*
   the subsystems are sync; the facade's async surface is a thin shell
   over sync subsystems, so "public methods threadsafe, subscription
   async-only" is achievable. Do not add `asyncio.run` anywhere.

7. **BSP-004 must be respected, but it is aspirational, not live.**
   [BSP-004](../../03%20-%20Blueprint/BSP-004-kernel-runtime.md) §4
   documents the uvicorn-lifespan boot order and §"V1.x retrospective"
   records that it regressed Tier-4 twice and was reverted. The facade
   should honor BSP-004's *ordering* (connect → ready handshake → OTLP
   handler → attach subsystems → dispatcher.start → serve → autosave;
   shutdown reverses) but must not assume `app.py`/uvicorn is the
   running entry point. If the facade lands option (a) from the plan,
   BSP-004 needs the amendment the plan calls for.

8. **Not-just-construction concerns in the entry points** — the facade
   must not silently drop these when it hoists construction:
   - Signal handlers (`pty_mode:422`–`444`, `serve_mode:596`; SIGINT →
     interrupt, SIGTERM → shutdown). Embedded use should *not* install
     process-global signal handlers — leave that to subprocess wrappers.
   - The RFC-008 ready handshake (`pty_mode:335`) and boot banner
     (`:326`) — transport concerns, belong in the PTY shim, not `start()`.
   - OTLP log-handler install + stdout-stripping (`pty_mode:358`,
     `_install_handler:585`) — transport concern.
   - BSP-001 proxy lifecycle (`pty_mode:343`, `_start_owned_proxy_or_none:501`)
     — sets `LLMKERNEL_LITELLM_ENDPOINT_URL` that `attach_agent_supervisor`
     later reads. If the facade skips proxy startup, the supervisor's
     pre-spawn health check will probe the default `:8000` URL.
   - `/health` endpoint (`app.py:80`) — HTTP concern.
   - serve-mode's bearer-token auth + `emit` monkey-patch
     (`serve_mode:250`, `:404`) — transport concern for the TCP shim.

---

## 7. Stale-anchor reconciliation table

The facade plan and the kernel `README.md` still reference the **old flat
layout**. Actual current paths (all relative to
[`vendor/LLMKernel/llm_kernel/`](../../../vendor/LLMKernel/llm_kernel/)):

| Plan / README references (old flat path) | Actual current path | Notes |
|---|---|---|
| `agent_supervisor.py` | `supervision/agent_supervisor.py` | class `AgentSupervisor` `:176` |
| `custom_messages.py` | `capture/custom_messages.py` | class `CustomMessageDispatcher` `:156` |
| `run_tracker.py` | `capture/run_tracker.py` | class `RunTracker` `:184` |
| `metadata_writer.py` | `capture/metadata_writer/_writer.py` | now a package; class `MetadataWriter` `:44` (re-exported via `capture/metadata_writer/__init__.py`) |
| `mcp_server.py` | `mcp/mcp_server.py` | class `OperatorBridgeServer` `:116`; `main` `:1749` |
| `mcp_manager.py` | `mcp/mcp_manager.py` | class `MCPManager` `:24` |
| `pty_mode.py` | `transports/pty_mode.py` | `main` `:284`, `boot_kernel` `:746`, `shutdown_kernel` `:882` |
| `serve_mode.py` | `transports/serve_mode.py` | `main` `:525` |
| `wire/tools.py` | `wire/tools.py` | unchanged (already subpackaged) |
| `_kernel_hooks.py` | `_kernel_hooks.py` | unchanged (package root) |
| `app.py` | `app.py` | unchanged (package root); dormant scaffold |
| `__main__.py` | `__main__.py` | unchanged (package root) |
| `kernel.py` | `kernel.py` | unchanged; IPython `LLMKernel` `:61` |
| `attach_operator_bridge` (plan §"Why…close") | **does not exist** | bridge is built inline in `attach_kernel_subsystems:154` |
| `MetadataWriter(event_log_path=…)` (plan outline) | **no such param** | use `workspace_root=`; no `events.jsonl` sink exists |

Import form used throughout the current code is the fully-qualified
subpackage path, e.g. `from llm_kernel.supervision.agent_supervisor
import AgentSupervisor` and `from llm_kernel.capture.custom_messages
import CustomMessageDispatcher` (see `_kernel_hooks.py:17`–`21`).

---

## Appendix — what looks wrong or infeasible in the facade plan

For correction before commit 2:

- **`MCPManager` in `start()`** (plan "Wiring inside `start()`" step 5 /
  public "Private" list `_mcp_manager`): not part of subsystem wiring;
  only the IPython kernel builds it. Drop it.
- **`event_log_path` default `workdir/.llmnb/events.jsonl`** (plan
  `__init__` + outline step 3): no such param, no such file. Replace
  with `workspace_root=workdir`; treat durable event-log persistence as
  net-new scope.
- **"mirror the `os._exit(rc)` in `start()`"** (Con 5): correct location
  is `app.py:46`; embedded `start()` must raise, not `os._exit`.
- **`attach_operator_bridge`** referenced as an existing helper: it does
  not exist; the bridge is inline in `attach_kernel_subsystems`.
- **`shutdown()` calling `supervisor.terminate_all()`**: fine and
  desirable, but note *no current path does this* — it is new behavior,
  not a mirror, so it needs its own test rather than a
  "behavior-preserving" claim.
- **`app.py` as the pty-mode entry** (Con 5 / commit 8): `app.py` is
  dormant; the live `pty-mode` path is `pty_mode.main`. Commit 8 edits
  scaffolding — the behavior-preserving smoke that matters
  (`pty-mode-smoke`) exercises `pty_mode.main`, so keep that green
  independently of the `app.py` refactor.
