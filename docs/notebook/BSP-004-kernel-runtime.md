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

## Changelog

- **Issue 1, 2026-04-27**: initial. Targeted runtime swap; wire and substrate untouched.
