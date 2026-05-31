# BSP-004: Kernel Runtime — asyncio under uvicorn

**Status**: Issue 1, 2026-04-27
**Related**: BSP-001 (proxy lifecycle), BSP-002 (conversation graph), BSP-003 (writer registry), RFC-008 (PTY+socket transport — wire UNCHANGED)
**Scope**: V1

## 1. Scope

This BSP changes the kernel's process runtime from "synchronous main + threads" to "asyncio event loop hosted by uvicorn." It does **not** change the wire, the data model, the dispatcher contract, the MCP transport, or the extension. The wire stays RFC-008 (PTY for process plumbing; socket for data plane). The dispatcher, OperatorBridgeServer, MetadataWriter, AgentSupervisor stay sync. Only the boot sequence and the socket I/O layer become async.

**Why uvicorn at all if we're not exposing HTTP routes?** Three things uvicorn does that we'd otherwise build ourselves:

1. **Asyncio loop + lifespan** — clean startup/shutdown ordering for subsystems via `@asynccontextmanager`.
2. **Signal handling** — graceful SIGTERM/SIGINT delivered to the loop, no manual `signal.signal(...)` dance.
3. **Worker scaling primitive** — `--workers N` available for V3+ if/when needed (V1 runs one worker).

The HTTP server side is incidental — we can expose `/health` and call it a day. If V2+ adds richer HTTP routes (snapshots, intents over HTTP, OpenAPI), they're additive.

## 2. What changes

| File | Change |
|---|---|
| `llm_kernel/app.py` (NEW, ~40 lines) | FastAPI app with `lifespan` that calls the existing subsystem-attach logic; `/health` route |
| `llm_kernel/__main__.py` | `pty-mode` subcommand invokes `uvicorn.run("llm_kernel.app:app", ...)` instead of the synchronous `_pty_main` |
| `llm_kernel/pty_mode.py` | `_run_read_loop` becomes `_serve_socket_async` using `asyncio.start_server` (POSIX UDS) / `asyncio.start_server` over TCP. Per-line dispatch becomes an async callback that calls the existing sync dispatcher via `await loop.run_in_executor(None, dispatcher.dispatch, env)` if the handler is slow, or directly if it's fast. |
| `llm_kernel/socket_writer.py` | Unchanged — the writer side stays sync because it's called from sync code (handlers emitting OTLP spans). The async socket reader interleaves with the sync writer fine because they hold the lock independently. |

## 3. What does NOT change

- Wire format (RFC-006, RFC-008 — PTY plumbing + socket framing)
- Discovery (extension allocates socket, passes via `LLMKERNEL_IPC_SOCKET` env var; or we can switch to "kernel prints port to stdout" later)
- CustomMessageDispatcher's public API (`register_handler`, `emit`)
- All `OperatorBridgeServer._route_*` and `_handle_*` methods
- AgentSupervisor (still uses subprocess.Popen + reader threads — those are isolated; future BSP can migrate)
- MetadataWriter (sync internals; autosave can stay `threading.Timer` or migrate to `asyncio.create_task` opportunistically)
- BSP-001 proxy lifecycle (proxies still spawn as separate uvicorn processes for now; future BSP can mount as routers)
- The extension side (PtyKernelClient unchanged; node-pty spawn unchanged; socket protocol unchanged)
- All existing tests (the wire is unchanged)

## 4. Boot sequence (after this BSP)

```
extension spawns kernel via node-pty
  python -m llm_kernel pty-mode  (args unchanged)
    →  __main__.py imports uvicorn, calls uvicorn.run("llm_kernel.app:app", ...)
       uvicorn starts the asyncio loop
       lifespan startup runs:
         - connect SocketWriter to LLMKERNEL_IPC_SOCKET (existing logic)
         - emit kernel.ready handshake
         - install OTLP log handler
         - attach_kernel_subsystems(synthetic_kernel)
         - dispatcher.start() — registers handlers as today
         - start the async socket reader (asyncio.start_server callback parses
           lines, dispatches via existing dispatcher)
         - start MetadataWriter autosave (sync timer or async task)
       uvicorn serves /health and waits
       
  kernel runs as long as uvicorn is alive
  
  on SIGTERM (extension shutdown):
    uvicorn lifespan shutdown:
      - stop socket reader
      - metadata_writer.snapshot(trigger="shutdown")
      - metadata_writer.stop()
      - dispatcher.stop()
      - SocketWriter.close()
```

## 5. Why this is small

The dispatcher's `_on_comm_msg(comm, msg)` callback is what gets called when an envelope arrives. Today it runs on the kernel's IO thread (which we synthesized in `_PtyKernel`). After this BSP, the same callback is invoked from an asyncio coroutine — but the callback itself doesn't need to be async, because we call it via `loop.run_in_executor(None, dispatcher.handle_inbound, msg)` for handlers that might block, or directly for ones that are fast.

The callback signature stays `(comm, msg) -> None`. The handlers stay sync. The dispatcher's queue (BSP-003) can stay a `queue.Queue` or migrate to `asyncio.Queue` at our leisure.

## 6. Failure modes

Same K-codes as RFC-008 (wire unchanged) and BSP-001 (proxy unchanged). One addition:

| Code | Symptom | Marker | Action |
|---|---|---|---|
| K50 | uvicorn lifespan startup raised before subsystems attached | `kernel_lifespan_startup_failed` with `error` | Surface to operator; check kernel.stderr from PTY |

## 7. Forward-compat with V2+

When V2 adds richer HTTP routes (`/v1/snapshot`, `/v1/intents`, OpenAPI per RFC-009 if drafted), they're additive — same `app.py`, more routes. The wire conversion (V2: extension switches from socket to HTTP/WS) becomes "register a WebSocket route alongside the existing socket reader; deprecate the socket once extensions migrate."

For V3 RTS, `--workers N` is available; one worker per kernel (V3 would have many kernels for fleet view, each its own uvicorn).

For V4 multi-everything, the intent envelope pattern (BSP-003) is what gets coordinated; the wire (HTTP by then) is the standard transport for distributed services.

## 8. Implementation slice (single, ~2 hours)

K-RT — kernel runtime migration:

1. Create `app.py` with FastAPI app + lifespan
2. Refactor `pty_mode.main` body into an async function callable from lifespan
3. Convert `_run_read_loop` to `asyncio.start_server` (or its TCP equivalent)
4. Update `__main__.py` to invoke uvicorn for `pty-mode`
5. Re-run Tier 4 e2e (live-kernel.test.ts)

No extension changes, no test changes, no wire changes. If the runtime swap works, every existing test should pass unchanged.

## V1.x retrospective — what landed, what regressed, what V3 looks like

### V1 attempt 1 (commit 2264834, 2026-04-27)

Implemented the §8 slice. `pty-mode` invoked `uvicorn.run("llm_kernel.app:app", ...)`; the lifespan called `boot_kernel()` and then scheduled `_async_serve_socket(state)` as an asyncio task. The serve coroutine wrapped the existing synchronous `_run_read_loop` in `loop.run_in_executor(None, ...)` because Windows `ProactorEventLoop` doesn't support `add_reader` on socket fds.

**This regressed Tier 4 e2e.** The marker file from a failing run showed:

```
agent_spawn_received → supervisor_spawn_popen_started (pid=53016) → agent_spawn_returned
[+1.4s]
async_serve_socket_exited
```

The kernel's read loop exited 1.4 seconds after the agent_spawn handler returned. The Claude subprocess was alive, but the kernel stopped reading from the data plane, so the operator's `notify` span never reached the cell — Tier 4 timed out at 180s where the prior session ran in 8.7s.

**Hypothesis (not fully confirmed):** `subprocess.Popen` on Windows, called from a thread-pool executor worker, has different handle-inheritance / lifecycle behavior than from the main thread. The data-plane socket is inheritable by default on Windows; when Claude's child process is spawned from the executor worker that's mid-`select()` on the socket, something in the OS-level handle dance EOFs the parent's `recv`.

### V1 attempt 2 (BSP-004 V2, commit 6316037)

Replaced `loop.run_in_executor` with a dedicated `threading.Thread` for the read loop. Same runtime model, clearer lifecycle (named thread, no pool sharing). `_async_serve_socket` now polls `read_thread.is_alive()` until exit instead of awaiting an executor Future.

**Honest assessment:** V2 leverages uvicorn for `/health` + lifespan ordering + signal handling only. The read path is still threaded — the asyncio loop doesn't actually drive it. Verification of whether V2 fixes the Tier 4 regression is deferred until a clean machine run (claude on PATH, no other VS Code instance holding the install mutex). The set_inheritable(False) fix on the data-plane socket (commit 51cc7a4) is a strict improvement either way.

### V3 plan (when V2 falls short, or when we want real async leverage)

**Use `loop.sock_recv()` for reads on the asyncio loop.** This is what the original §8 sketch wanted but couldn't do under ProactorEventLoop's `add_reader` limitation. `sock_recv` works on both Selector and Proactor loops on Python 3.8+ (ProactorEventLoop uses overlapped I/O internally for it).

Sketch:

```python
async def _async_serve_socket(state):
    sock = state["writer"]._sock
    sock.setblocking(False)
    loop = asyncio.get_event_loop()
    buffer = bytearray()
    while not state["shutdown_event"].is_set():
        try:
            chunk = await asyncio.wait_for(loop.sock_recv(sock, 4096), 0.5)
        except asyncio.TimeoutError:
            continue
        if not chunk:
            break
        buffer.extend(chunk)
        # Lines are dispatched via run_in_executor so the synchronous
        # handler chain (comm_manager → handler → AgentSupervisor.spawn
        # → subprocess.Popen) doesn't block the asyncio loop. This puts
        # subprocess.Popen back on a worker thread — which is where V1
        # attempt 1 had the regression. Mitigation: the data-plane
        # socket's set_inheritable(False) (commit 51cc7a4) makes the
        # subprocess inherit nothing of consequence regardless of which
        # thread Popen runs on.
        while True:
            nl = buffer.find(b"\n")
            if nl < 0:
                break
            line = bytes(buffer[:nl])
            del buffer[:nl + 1]
            if line.strip():
                await loop.run_in_executor(None, _dispatch_inbound_line, line, state["kernel"])
```

V3 actually leverages asyncio: reads on the loop, blocking work offloaded explicitly via `run_in_executor`. Trade-off: dispatches now run on worker threads (same as V1 attempt 1's read loop did). The bet is that the inheritability fix neutralizes the original failure mode regardless of thread.

V3 is queued behind V1 ship-readiness — not blocking V1.

## Changelog

- **Issue 1, 2026-04-27**: initial. Targeted runtime swap; wire and substrate untouched.
- **Issue 2, 2026-04-28**: retrospective added. V1 attempt 1 regressed Tier 4 e2e; root cause hypothesis (subprocess.Popen-from-executor-worker EOF'ing the parent socket on Windows). V2 (dedicated thread) verification pending; V3 (sock_recv-based) sketched as the path that actually leverages asyncio. Inheritability fix on the data-plane socket (commit 51cc7a4) lands regardless.
