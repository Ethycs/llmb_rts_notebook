# BSP-006: Embedded ASGI runtime — write the server, don't ship one

**Status**: Issue 1 — Exploratory, 2026-04-28
**Related**: BSP-004 (kernel runtime — uvicorn V1/V2 retrospective + V3 sock_recv plan), RFC-008 (PTY transport), RFC-009 (zone control)
**Driver**: BSP-004 V1 and V2 both regressed Tier 4 e2e (V1: read-loop EOF at +1.4s; V2: proxy startup `FileNotFoundError` inside lifespan). Both bugs trace to subprocess/lifecycle behavior under uvicorn's thread context on Windows. Switching ASGI servers (hypercorn, granian, daphne) doesn't fix the underlying `subprocess.Popen` issues. The remaining option: **write our own minimal ASGI runtime** so we own every line of the lifecycle and can fix the Windows subprocess interactions directly.

This BSP is exploratory. It sketches what an embedded ASGI runtime looks like, what it costs to build, what we lose vs uvicorn, and whether the trade is worth it.

## 1. What is "ASGI internally"?

ASGI ([Asynchronous Server Gateway Interface](https://asgi.readthedocs.io/)) is a protocol — a set of conventions for how an HTTP/WebSocket server hands requests to a Python async application. It defines three message types:

- **HTTP scope + receive/send** — one HTTP request → one ASGI app invocation
- **WebSocket scope + receive/send** — one WS connection
- **Lifespan scope + receive/send** — server startup/shutdown signals

uvicorn is one ASGI *server*. FastAPI, Starlette, Django Channels are ASGI *apps*. The protocol between them is just async function calls and dict-shaped messages.

Writing "ASGI internally" means: implement the server side of the protocol ourselves. We don't ship uvicorn or hypercorn — instead we have a small `kernel_asgi.py` module that:
1. Listens on a TCP port (HTTP) and an in-memory channel (data plane)
2. Decodes incoming requests into ASGI scope + receive coroutine
3. Calls the registered ASGI app
4. Streams the app's send messages back out

The app stays the same — `FastAPI(lifespan=...)` or any other ASGI app works. We just don't import uvicorn.

## 2. Why we'd want this

| Concern | uvicorn | Embedded ASGI |
|---|---|---|
| Subprocess.Popen during lifespan startup | Lifespan runs in uvicorn's signal-handler context; `mitmdump`'s subprocess EOF'd parent socket on Windows (V1); `mitmdump` not on PATH inside lifespan (V2) | We control the thread the lifespan runs on. Subprocess.Popen runs from main thread, exact same context as legacy `main()`, no surprises. |
| Read-loop dispatch model | uvicorn owns the asyncio loop; we tried `run_in_executor` (V1, broken) and `threading.Thread` polled by asyncio (V2, semi-broken) | We can run the read loop on the asyncio loop directly via `asyncio.start_server` or `loop.sock_recv` per RFC-009 §V3. Or on the main thread if we choose. |
| Signal handling | uvicorn installs its own SIGTERM/SIGINT handlers and translates to lifespan shutdown | We install whatever we want; matches pre-BSP-004 main() behavior exactly. |
| /health route | Free | We write the endpoint by hand: ~10 lines. |
| Worker scaling | `--workers N` provided | Out of scope for V1 (one worker per kernel anyway per BSP-004 §1). |
| Hot reload | `--reload` provided | Not used; out of scope. |
| HTTP/2 / 3 / WebSockets | Provided | We add only what we need — V1 is HTTP/1.1 + RFC-008 socket. WebSocket support is a future RFC if V2 wire migrates to WS. |
| Performance | Battle-tested, fast | Equivalent for our load (single-digit qps on /health, the data plane is RFC-008 socket, not HTTP). |
| Dependency footprint | uvicorn brings httptools, websockets, watchfiles, click, pyyaml | Zero new deps; stdlib `asyncio` + `socket` + `http.server` if needed. |
| Lines of code we own | ~0 lines we maintain | ~300-500 lines we maintain |

The trade is **complexity tax (we own the runtime) vs control (we can fix Windows-specific bugs without forking a dependency)**.

## 3. What an embedded runtime would look like

A new module `vendor/LLMKernel/llm_kernel/kernel_asgi.py`. About 300 lines. Three responsibilities:

### 3.1 Lifespan driver

```python
async def run_lifespan(app, state: dict) -> None:
    """Drive the ASGI lifespan protocol against `app`.

    1. Construct the lifespan scope.
    2. Define receive() that yields {"type": "lifespan.startup"} once,
       then waits for shutdown (Event-based).
    3. Define send() that captures lifespan.startup.complete /
       lifespan.startup.failed and lifespan.shutdown.complete.
    4. Call app(scope, receive, send) — this runs until shutdown.
    """
```

This is ~50 lines. It calls our existing `app.py` lifespan exactly the same way uvicorn does. The lifespan body still calls `pty_mode.boot_kernel()` etc. — no kernel changes.

### 3.2 HTTP server (only for /health)

```python
async def serve_http(host: str, port: int, app) -> int:
    """Minimal asyncio-based HTTP/1.1 server. Reads the request, parses
    method + path + headers, builds an ASGI HTTP scope, calls the app
    with a tiny receive/send pair, writes the response back. Returns
    the bound port (for port=0 OS-pick).
    """
```

Pure asyncio + socket + a request-line/header parser (stdlib `http.server` has primitives we can reuse). ~150 lines including streaming response support. /health doesn't need anything fancy.

### 3.3 Signal handling + main loop

```python
async def main(app, host="127.0.0.1", port=0) -> int:
    loop = asyncio.get_event_loop()
    state = {}
    # Install SIGTERM/SIGINT handlers identical to legacy main()
    loop.add_signal_handler(signal.SIGTERM, ...)
    loop.add_signal_handler(signal.SIGINT, ...)
    # Lifespan + HTTP serve as concurrent tasks
    await asyncio.gather(
        run_lifespan(app, state),
        serve_http(host, port, app),
    )
```

About 30 lines. SIGINT/SIGTERM go through the same `shutdown_event` the read loop polls.

The critical difference vs uvicorn: **the read loop can be invoked from anywhere we want in this main()**. We can put it on the main thread (legacy main() behavior) or schedule it as an asyncio task — our choice, no battles with uvicorn's lifespan ordering.

## 4. The V3 read-loop design (carries over from BSP-004 §"V3 plan")

With embedded ASGI, the read loop is purely our problem. The V3 design from BSP-004 v2.0.1 still applies:

```python
async def serve_socket_v3(state):
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
        # Per-line dispatch via run_in_executor so the synchronous
        # comm_manager.deliver chain doesn't block the asyncio loop.
        # subprocess.Popen calls inside the dispatcher run on a worker
        # thread, but the data-plane socket has set_inheritable(False)
        # (zone_control fix) so handle inheritance no longer EOFs us.
        while True:
            nl = buffer.find(b"\n")
            if nl < 0: break
            line = bytes(buffer[:nl])
            del buffer[:nl + 1]
            if line.strip():
                await loop.run_in_executor(None, _dispatch_inbound_line, line, state["kernel"])
```

This actually leverages asyncio for reads. The dispatcher's sync chain runs on a worker thread, which is exactly the BSP-004 V1 condition that broke us. **The fix that changed**: the data-plane socket is now non-inheritable (zone_control commit `51cc7a4`), so subprocess.Popen on a worker no longer EOFs the parent's recv. V3 should work.

If it doesn't, the diagnostic is right there in the marker file (`read_loop_*` break-reason markers from `pty_mode.py:894+`).

## 5. What we lose

| Lost | Mitigation |
|---|---|
| `--workers N` for fleet kernels (V3 RTS) | Spawn N kernel processes, one per zone. Each runs its own embedded ASGI. The whole point of the per-zone model. |
| `--reload` for dev | Use legacy `main()` for non-uvicorn dev paths (already retained). |
| HTTP/2 + WebSockets out of the box | V1 doesn't need them. If V2 wire migrates to WS, write a 50-line WS handshake. |
| Battle-tested HTTP parsing edge cases | /health is one trivial endpoint; we control the input. |
| OpenAPI / Starlette goodies | Re-add by importing Starlette as the ASGI app — Starlette runs under our embedded server identically to uvicorn's. |

The losses are real but **all future-V2+ concerns**. V1 doesn't need any of them.

## 6. Cost estimate

- `kernel_asgi.py` initial implementation: ~6 hours (lifespan driver + minimal HTTP/1.1 + signal handling).
- Migrate `__main__.py pty-mode` from `uvicorn.run(...)` to `asyncio.run(kernel_asgi.main(app))`: ~30 minutes.
- V3 `serve_socket` per §4: ~2 hours.
- Tests (`test_kernel_asgi.py`): ~2 hours covering lifespan startup/shutdown ordering, /health responds 200, signal-driven shutdown sets shutdown_event, V3 read loop dispatches one line correctly.
- Re-run Tier 4 e2e: ~1 hour bring-up + diagnosis.

Total: ~12 hours. Compare to: keeping uvicorn and chasing each new Windows-quirk regression as it arises. Five sessions of "the proxy bug" eats 12 hours easily.

## 7. Recommendation

**Tactical**: Stay with legacy `main()` for V1 ship. It works. Don't block the cell roadmap (BSP-005) on a runtime swap.

**Strategic**: When V3 multi-kernel coordination forces us to revisit (BSP-002 §"V3+ forward-compat"), do this BSP. The 12-hour cost is reasonable when:
- We need /health for fleet-management (V3+)
- Or we need HTTP routes for OpenAPI'd intent submission (V2+ wire migration)
- Or we hit a third uvicorn-Windows-specific bug

**What to do now**: defer this BSP until one of those triggers. Keep BSP-004's app.py / boot_kernel / shutdown_kernel scaffolding in tree (they're reused by an embedded runtime identically to uvicorn). Stay on legacy main(). When the trigger fires, this doc is the design.

## 8. Open questions

1. **Should /health be HTTP at all?** If it's only for fleet-management probes (V3+), an in-process status query via the existing RFC-008 socket might be simpler — no HTTP server needed. Then BSP-006 collapses to "write a tiny lifespan driver, no HTTP." About 80 lines instead of 300.
2. **Where does the read loop live in the embedded design — main thread or asyncio task?** §4 sketches the asyncio-task version. The main-thread version is closer to legacy main() and might be safer if the V3 worker-thread subprocess behavior still surprises us on Windows.
3. **Single-file or split?** This BSP sketches a single `kernel_asgi.py`. Could be `kernel_asgi/{lifespan.py, http.py, signal.py, main.py}`. Single-file is easier to review and the volume doesn't justify a package.

## 9. What this is NOT

- Not a replacement for FastAPI — the app stays whatever ASGI app we pick. Embedded runtime just serves it.
- Not a goal of "fewer dependencies." We could keep uvicorn AND have an embedded path for the kernel; this BSP says "swap uvicorn for embedded" because that's what closes the V1/V2 regression class.
- Not blocking V1 ship. Legacy main() is good enough; this is for the next runtime upgrade window.

## Changelog

- **Issue 1, 2026-04-28**: initial exploratory sketch. ~300-line embedded runtime; V3 read-loop carries over from BSP-004 §"V3 plan"; recommendation is *defer* until V3 multi-kernel or HTTP-route trigger fires.
