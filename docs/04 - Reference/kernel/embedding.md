# Embedding the kernel as a library

**Status**: reference (slice 2). **Stability: unstable** — the public API
may change before slice 4; see [`architecture.md`](architecture.md).
**Source of truth**: [`kernel_facade.py`](../../../vendor/LLMKernel/llm_kernel/kernel_facade.py).
**Related**: [`architecture.md`](architecture.md) (the facade's wiring,
lifecycle, and full public surface), [`capture-invariants.md`](capture-invariants.md)
(the properties the captured event stream guarantees),
[`PLAN-kernel-facade.md`](../../06%20-%20Roadmaps/PLAN-kernel-facade.md).

This is the library-embedding guide: how to `from llm_kernel import Kernel`
and drive the substrate in-process from a Python script, a FastAPI app, or
a Jupyter cell. For the wiring internals and the complete method table,
read [`architecture.md`](architecture.md) first.

## Async-only — here's why

The facade is **async-only**, and it never calls `asyncio.run` for you.
Use it under `async with`.

The reason is event-loop safety. The facade is a thin async shell over
subsystems that are themselves synchronous (they run on their own threads,
not on the loop). Its async surface exists so it can (a) capture and reuse
*your* event loop rather than owning one, and (b) bridge the subsystem
threads back to your loop for `subscribe_events`. If the facade called
`asyncio.run` internally it would create and tear down its own loop —
which would conflict with a loop you already run (FastAPI, Jupyter) and
strand the executor bridge. So there is deliberately no synchronous
entry point: you own the loop, the facade borrows it.

## Event-loop ownership

- `start()` captures `asyncio.get_running_loop()` at the moment it runs,
  unless you passed an explicit `loop=` to the constructor. There must
  already be a running loop — construct and start the kernel from inside
  an `async def`.
- The facade **never** calls `asyncio.run`. You (or your host framework)
  own the loop's lifetime.
- It **coexists** with a host loop. Under FastAPI or in a Jupyter cell the
  loop is already running; `start()` simply adopts it. This is why the
  library-embedding path is safe under uvicorn where the dormant `app.py`
  lifespan lives.
- `subscribe_events` bridges subsystem threads to your loop by awaiting
  the sink's blocking wait inside `loop.run_in_executor(...)` — so a
  running loop is required for the async accessor, not just for `start`.

## Threadsafety

- **Public methods are threadsafe.** The sync delegators (`spawn_agent`,
  `send_user_turn`, `revert`, `stop`, `list_agents`, `list_zones`) and
  `read_event_log` delegate to subsystems whose own locks cover the call;
  the lifecycle (`start` / `shutdown`) is guarded by a `threading.Lock`.
- **Subscription is async-only.** `subscribe_events` is the one method
  that must run on the event loop — it is an async generator and uses the
  loop's executor to bridge the subsystem threads. Do not call it from a
  plain thread.
- `read_event_log` is a plain synchronous snapshot read and is safe to
  call from anywhere, including after `shutdown()` (it returns whatever
  was captured before teardown).

## A worked example

The example below constructs a kernel, inspects it, reads the event log,
and drains a live subscription — without spawning a real agent. **Spawning
needs `ANTHROPIC_API_KEY` and a running LiteLLM proxy** (the supervisor
runs a pre-spawn health check against `litellm_endpoint_url`, default
`http://127.0.0.1:8000/v1`), so a doc example avoids real spawns — this
mirrors the plan's library-embedding smoke.

```python
import asyncio
from pathlib import Path

from llm_kernel import Kernel


async def main() -> None:
    async with Kernel(workdir=Path("./scratch")) as k:
        # No transport bound, no agents spawned — a usable kernel.
        assert k.list_agents() == []
        assert k.list_zones() == []

        # Native, in-memory read of the captured envelope stream
        # (Family-A run spans + Family-B..G control envelopes).
        frames = k.read_event_log()          # [since:until] slice
        print(f"{len(frames)} envelopes captured so far")

        # Live subscription: replays from `since`, then yields new
        # frames until shutdown closes the sink. Drain briefly here.
        async def drain() -> None:
            async for frame in k.subscribe_events(since=0):
                print("event:", frame.get("type", "?"))

        task = asyncio.create_task(drain())
        await asyncio.sleep(0.1)
        task.cancel()
    # Leaving the `async with` block calls shutdown():
    # agents terminated, metadata snapshotted, sink closed — which
    # ends the subscription generator cleanly.
    print("facade smoke OK")


asyncio.run(main())
```

`asyncio.run(main())` is *your* call at the top level — the facade never
makes it for you. Everything the kernel does happens inside `main`'s
already-running loop.

## Patterns

### A pytest fixture

`tmp_path` gives each test its own `workdir`; the async context manager
handles setup and teardown.

```python
import pytest
from llm_kernel import Kernel


@pytest.fixture
async def kernel(tmp_path):
    async with Kernel(workdir=tmp_path) as k:
        yield k


async def test_starts_empty(kernel):
    assert kernel.list_agents() == []
    assert kernel.read_event_log() == kernel.read_event_log()  # stable snapshot
```

### Binding a transport

A transport is any object with async `bind(kernel)` and `stop()` — a thin
hook, not a formal protocol (see [`architecture.md`](architecture.md#transport-protocol)).
`bind` is awaited now; `stop` is awaited first during shutdown, so the
wire is drained before agents are terminated.

```python
async with Kernel(workdir=Path("./scratch")) as k:
    await k.bind_transport(my_transport)   # my_transport.bind(k) is awaited
    await k.run_forever()                  # block until cancelled
    # on exit, shutdown() awaits my_transport.stop() first
```

`run_forever()` blocks until the surrounding task is cancelled — it is a
convenience for a subprocess wrapper (e.g. one that installs a SIGTERM
handler). Embedded / library callers usually drive the kernel directly and
never call it.

### Reading vs. subscribing to the event log

Both read the same in-memory sink; pick by whether you need history or a
live feed.

| Need | Use | Notes |
|---|---|---|
| A point-in-time snapshot (history) | `read_event_log(*, since=0, until=None)` | Synchronous; returns the emission-ordered slice `[since:until]`. Safe after shutdown. |
| A live feed (history, then new frames) | `subscribe_events(*, since=0)` | Async generator; replays from `since`, then yields new frames until `shutdown()` closes the sink and the generator ends. |

Both surface the native [RFC-006](../atoms/protocols/family-d-event-log.md)
envelope stream (Family-A run spans are OTLP-shaped; Families B..G are
control envelopes) — the same frames a wire consumer would see. Neither is
an OTLP *export*; an OTLP export transport is deferred.

### FastAPI / ASGI host

Under a host that already runs a loop, adopt it inside the lifespan and
stash the kernel on `app.state`:

```python
from contextlib import asynccontextmanager
from pathlib import Path
from llm_kernel import Kernel


@asynccontextmanager
async def lifespan(app):
    async with Kernel(workdir=Path("./scratch")) as k:
        app.state.kernel = k
        yield
```

The facade adopts uvicorn's running loop via `get_running_loop()` — no
nested `asyncio.run`, no loop conflict.

## Entry-point subprocesses are not facade consumers yet

The kernel's subprocess entry points — `pty-mode` and `serve` — do **not**
go through the facade. The facade is **additive**: it is a new embeddable
path added alongside the known-good subprocess boots, which were
deliberately left untouched (the entry-point migration is deferred; the
live pty path remains the legacy synchronous `pty_mode.main`). See
[`architecture.md`](architecture.md#deviations-from-the-original-plan) for
the rationale. If you are running the kernel as a subprocess, you are on
the legacy path, not the embedding path documented here.
