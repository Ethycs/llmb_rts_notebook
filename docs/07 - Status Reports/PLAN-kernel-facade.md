# Preparing the LLMKernel for integration as a Python object

## Context and motivation

A long design conversation traced what the LLMKernel project actually
is and where it can go. Early questions surfaced what makes the kernel
unique — its **MCP/LLM gateway fusion**: the kernel sits at the
intersection of three "everything flows through here" surfaces
(agent ↔ MCP tools, agent ↔ LLM, operator ↔ kernel), and every input
on every surface is captured with provenance. Later questions
explored how to **deploy** that gateway: as an MCP server (give it
legs); as a long-lived process clients can attach to durably; as
something Claude Code itself could use across conversations.

Then the question of **embedding** came up: could we deploy the
kernel as a Python object — a thing you `import` and use as a
library, not just spawn as a subprocess? The answer is yes, and the
shape is orthogonal to the MCP-server question: the Python object is
the *embeddable form*; MCP is one *transport* you can bind to it.
This plan covers the preparation work — what the kernel needs to
become embeddable.

This plan is the implementation-level detail for **slice 2** of the
approved substrate trajectory (a Claude Code planning artifact at
`~/.claude/plans/let-s-sketch-this-out-deep-peacock.md`, outside the
repo).
That trajectory listed four slices; slice 2 is "Kernel facade +
Transport + Extension contracts." This plan focuses tightly on the
**facade extraction** part — the work strictly required to embed the
kernel as a Python object. Transport binding and the Extension
protocol are documented inside the trajectory but are not blocking
for embedding (a kernel without any transport bound is a usable
library; transports are deployment options layered on top).

The first slice 1 commit has already shipped (`3c2e6d0 docs(kernel):
create docs/kernel/ — README index`). That commit included a planned
file `docs/kernel/embedding.md` slotted for slice 2 — i.e., this
plan's documentation deliverable.

## What "kernel as Python object" means in this codebase

The target shape, ergonomically:

```python
from llm_kernel import Kernel
from pathlib import Path

async def main():
    async with Kernel(workdir=Path("./scratch")) as k:
        agent_id = k.spawn_agent(zone_id="research", task="analyze X")
        k.send_user_turn(agent_id, "do Y now")

        async for event in k.subscribe_events(since=0):
            if event["type"] == "run.complete":
                break

        print(k.read_event_log(since=0))
```

Three deployment shapes follow from this same class, differentiated
only by what (if anything) gets bound to the kernel:

1. **Pure library** — no transport bound. The user drives the kernel
   directly from Python. Right for tests, scripts, embedding inside a
   larger service. State persists for the duration of the
   `async with` block.
2. **Library + transport(s)** — one or more transports bound after
   construction. The kernel does its normal work AND exposes a wire
   (PTY for the existing VS Code extension; streamable-HTTP for
   external MCP clients; TCP for headless deployments). Same class,
   different surface area.
3. **Subprocess** — the existing `python -m llm_kernel pty-mode` and
   friends become facade consumers under the hood. Behavior
   preserved; the subprocess shape is one wrapper around the
   embedded form.

The kernel doesn't change *what* it is by being embedded. The
capture invariants, supervision machinery, run-tracker, dispatcher,
event log all stay exactly as today. What changes is *who instantiates
them and how* — today that's the FastAPI `lifespan` in
[`app.py:29-73`](../../vendor/LLMKernel/llm_kernel/app.py)
and the per-subcommand wiring scattered across
[`__main__.py`](../../vendor/LLMKernel/llm_kernel/__main__.py); after
this plan, that's a single class that all entry points share.

## Why the existing code is close to this already

The subsystems already exist as discrete, well-bounded classes —
this plan is mostly a **reorganization of existing wiring**, not new
behavior. The codebase has been building toward this shape:

- [`AgentSupervisor`](../../vendor/LLMKernel/llm_kernel/agent_supervisor.py)
  — multi-agent process supervision, watchdog, restart machinery,
  thread-safe (`self._lock`). Already polymorphic over many agents
  in one instance.
- [`CustomMessageDispatcher`](../../vendor/LLMKernel/llm_kernel/custom_messages.py)
  — RFC-006 envelope routing, handler registry, families A/B/C/D/F/G.
  Already a proto-bus.
- [`RunTracker`](../../vendor/LLMKernel/llm_kernel/run_tracker.py)
  — OTLP span lifecycle. Single instance per trace, threadsafe.
- [`MetadataWriter`](../../vendor/LLMKernel/llm_kernel/metadata_writer.py)
  — event log queue (bounded, drop-oldest-on-overflow), durable
  snapshot, threadsafe.
- [`OperatorBridgeServer`](../../vendor/LLMKernel/llm_kernel/mcp_server.py)
  — the internal stdio MCP server agents connect to.
- [`MCPManager`](../../vendor/LLMKernel/llm_kernel/mcp_manager.py)
  — outbound MCP client (FastMCP-based).
- The wiring helper at
  [`_kernel_hooks.py`](../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py)
  (`attach_dispatcher`, `attach_run_tracker`,
  `attach_agent_supervisor`, `attach_operator_bridge`,
  `attach_metadata_writer`) is the **existing canonical wiring
  order**. The facade re-uses this order; it doesn't reinvent it.

What's missing is the **owner**. Today each entry point owns its own
wiring:
- [`app.py`](../../vendor/LLMKernel/llm_kernel/app.py) calls
  `pty_mode.boot_kernel()` inside the FastAPI lifespan.
- [`pty_mode.py`](../../vendor/LLMKernel/llm_kernel/pty_mode.py)
  owns the PTY+socket transport plus its own subsystem boot.
- [`serve_mode.py`](../../vendor/LLMKernel/llm_kernel/serve_mode.py)
  owns the TCP transport with bearer-token auth plus its own
  subsystem boot.
- [`_kernel_hooks.attach_kernel_subsystems`](../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py)
  attaches subsystems to an `IPythonKernel` instance (legacy
  IPython-kernel mode).

These four paths each construct the same subsystems in approximately
the same order, but they're not sharing the construction logic —
they're each calling out to overlapping helpers. The facade hoists
the construction into one class and lets each entry point be the
*caller* of that class rather than its *re-implementer*.

## Design conversation summary

The conversation went through several framings before landing on
embedding:

1. **PBX / Telephone tool** — could one agent call another? Yes, via
   the existing `send_user_turn` machinery; receiver doesn't time
   out because the kernel pushes turns, the agent doesn't listen.
2. **Python kernel bolt-on** — could we add a Python sibling kernel
   for authoring tools outside agent context? Yes, but the gain
   versus complexity depends on whether you embed (library use) vs.
   bolt on (sibling process).
3. **FastMCP server deployment** — could the kernel itself be an
   MCP server? Yes, additively. Three surfaces coexist in one
   process: internal stdio MCP for agents, kernel-host PTY+socket
   for the VS Code extension, external streamable-HTTP MCP for
   anyone.
4. **Multi-kernel / microkernel** — should we go full
   service-oriented? The system is already microkernel-shaped
   (RFC-006 envelope routing as proto-bus, executor_id as a
   forward-looking polymorphism slot). Recommendation was to
   formalize the bus when there's pressure; don't pre-build.
5. **Kernel as MCP server with multi-kernel deferred** — give the
   kernel legs by exposing it as an MCP server; defer multi-kernel
   until federation pressure surfaces. Multi-kernel becomes
   trivial: kernel-A's external MCP client connects to kernel-B's
   external MCP server.
6. **Kernel as Python object** — the embeddable form. Orthogonal
   axis to MCP server deployment; composes via the Transport
   protocol. **This plan.**
7. **PBX as separate concern** — coordination models like PBX
   should be extensions on top of the substrate, not core kernel
   features. Validates the extension contract slice 2 introduces.

The strategic reframing landed:
> The thing you've built isn't really "an LLM kernel"; it's a
> **legibility substrate for agentic work**. Capture invariants,
> failure-mode discipline, wire-format separation, identity-model
> clarity. Agent supervision is a *consumer* of that substrate, not
> its purpose. Coordination models — PBX, future ones — are also
> consumers, plugged in through extension contracts rather than
> carved into the core.

That reframing is what justifies the embedding work: a *substrate*
should be embeddable. A monolith that only runs as a subprocess
hides what's valuable inside an opaque process boundary. A library
exposes it.

## Pros

### Pro 1 — Testability gets dramatically cheaper

Today's tests instantiate `AgentSupervisor` and other subsystems
individually in fixtures, with hand-rolled wiring per test file. A
full-kernel integration test requires a subprocess and the
subsystem-attach dance. After the facade lands, `Kernel(workdir=
tmp_path)` plus `await k.start()` is one line in a pytest fixture.
The full kernel lifecycle becomes testable in-process at unit-test
speed.

### Pro 2 — The MCP/LLM gateway fusion becomes embeddable

The thing that makes this project distinctive — capture-by-default,
MCP-mediated agents, failure-mode-named-and-tested supervision — can
now be embedded inside other Python services. A FastAPI app, a CLI
tool, an evaluation harness, a benchmark runner, another notebook
host: any of them can `from llm_kernel import Kernel` and host
agents with the full capture story intact, without spinning up a
subprocess.

### Pro 3 — Notebook users gain a self-hosting story

Today the notebook host (VS Code extension) and the kernel are
separate processes connected by a PTY+socket. The extension owns
spawning the kernel. A Python notebook user — someone running
Jupyter or `pixi run jupyter` — has no path to drive the kernel
without booting the extension. With the facade, a notebook cell does
`from llm_kernel import Kernel; k = await Kernel(workdir='.')` and
gets a fully-wired kernel bound to the notebook's IPython shell.
That unlocks notebook-first workflows that don't depend on the VS
Code extension being present.

### Pro 4 — The capture inversion property

The conversation surfaced a striking property: when Claude Code (or
any LLM agent) acts as an *MCP client* of the kernel, every action
it takes flows through the kernel's `_call_tool_handler` and becomes
a Family-A span in the persistent event log. The kernel was
designed to capture *spawned* agents; embedding makes it capture
*peer* agents too. Library use generalizes this further: any Python
caller's actions on the kernel become captured runs with a
`transport: "library"` tag, building an audit trail that's
identical in shape to agent activity. The substrate covers more
ground without changing what makes it the substrate.

### Pro 5 — Composes with all the other deployment shapes

The facade is orthogonal to:
- **MCP server deployment** — bind `MCPHTTPTransport` after `start()`;
  the kernel now serves external clients.
- **VS Code extension** — bind `PTYTransport`; existing behavior
  preserved.
- **TCP/headless** — bind `TCPTransport`; existing serve-mode behavior
  preserved.
- **Multi-transport** — bind several at once; the kernel speaks to all
  of them simultaneously.

No deployment shape becomes harder. Every deployment shape becomes
expressible as facade-plus-transport rather than its own bespoke
entry-point file.

### Pro 6 — Minimal new code

The audit shows the existing subsystems are sound and the wiring
helper at `_kernel_hooks.py` already encodes the canonical
construction order. The facade is essentially "hoist the
`_kernel_hooks.attach_*` sequence into a class that owns the
subsystem references." Estimated diff: ~250 LOC for the facade,
~100 LOC of changes across entry-point files, ~150 LOC of new
tests. Documentation is the larger artifact (`embedding.md`,
`architecture.md`).

### Pro 7 — Reversible if requirements drift

If the facade turns out to be over-engineered or the public API
needs reshaping, it can be re-folded back into the entry points
without losing any subsystem code. The risk is contained to ~250
LOC and the public API surface; everything below the facade stays
exactly as today.

### Pro 8 — Documentation surface becomes natural

`docs/kernel/embedding.md` and `docs/kernel/architecture.md` are
already slotted in the existing trajectory and listed in the
`docs/kernel/README.md` that shipped in commit 1. The work is
already framed for documentation; this plan delivers the artifact
the framing was anticipating.

## Cons

### Con 1 — Public API stability commitment

Making `Kernel` a public, documented class means breaking it
becomes a wire change for library users. Today the supervisor's
public methods are internal to the kernel package; refactoring
them is a within-package concern. Once `Kernel` is published,
renaming a parameter or changing return shape is a backward-incompat
change for anyone embedding. Mitigation: stamp the class
`Stability: unstable` in docstrings until the substrate trajectory
finishes (post-slice 4); document specific guarantees later. Avoid
exposing subsystems as attributes — only the facade itself is
public; subsystems stay private under `_supervisor` / `_dispatcher`
naming.

### Con 2 — Async-first means sync footguns

The kernel is async internally — asyncio loop, FastAPI lifespan
precedent, async event subscription. The cleanest public API is
async-only. But many Python users instinctively reach for sync
APIs. Tempting to ship `k.spawn_agent_sync(...)` wrappers that
call `asyncio.run` internally — those break under nested event
loops (Jupyter, FastAPI, any host that already has a loop). The
honest call: async-only, documented loudly. Users who need sync
write their own `asyncio.run(...)` boilerplate or use a sync
helper they themselves own. Risk: users will complain. Mitigation:
the embedding.md doc opens with "async-only, here's why."

### Con 3 — Event loop ownership is fiddly

Embeddable libraries that use asyncio need to be careful about
loop ownership:
- If the user has a running loop, the facade must use it.
- If the user has no loop, the facade must not create one (let the
  user `asyncio.run(main())` themselves).
- If the user runs inside Jupyter (which has its own loop), the
  facade must coexist with it.

The pattern: `Kernel.start()` uses `asyncio.get_running_loop()`;
the constructor takes optional `loop=None` and only honors it if
the user explicitly passes one. Documented threadsafety contract:
"public methods are threadsafe; event subscription is async-only;
the facade does not call `asyncio.run` for you."

### Con 4 — Threading contract has to be explicit

Library users may call `k.spawn_agent(...)` from multiple threads.
The supervisor's `self._lock` covers most paths but doesn't cover
all of them; the PBX skim surfaced one (stdin write race) that
slice 1 is already fixing. Need to ensure all public facade
methods take `self._lock` before calling into subsystems, or
that the subsystems' own locking covers the call site. Risk:
subtle races slip through; mitigation: a specific test file
`test_kernel_facade_threadsafety.py` exercising concurrent calls
on every public method.

### Con 5 — FastAPI lifespan entanglement requires careful refactor

[`app.py:29-73`](../../vendor/LLMKernel/llm_kernel/app.py) today
wires subsystems inside the `@asynccontextmanager` lifespan and
relies on a module-level `_state` dict. The facade refactor has
two paths:
- (a) Replace `app.py`'s lifespan body with
  `async with Kernel(...) as k: app.state.kernel = k; yield`.
- (b) Keep `app.py` largely as-is and have it call into the facade
  for subsystem construction only.

Option (a) is cleaner long-term but touches BSP-004's documented
boot sequence; option (b) is safer short-term but defers the
cleanup. The plan recommends (a) with the BSP-004 amendment as
part of the same commit. Risk: the legacy `pty_mode.boot_kernel()`
has subtleties (e.g., the `os._exit(rc)` on boot failure at L45)
that need preservation in the facade's `start()`. Mitigation:
read `pty_mode.boot_kernel` carefully; mirror its failure-handling
semantics in `Kernel.start()`.

### Con 6 — Capture asymmetry surfaces more sharply

When the kernel runs as a subprocess driven by the VS Code
extension, the *operator's* actions get captured as `operator.action`
envelopes (Family A via the extension). When the kernel is embedded
and the Python caller invokes `k.spawn_agent(...)`, who is the
"operator" for capture purposes? The transport tag
(`"library"` vs. `"pty-socket"` vs. `"external-http"`) covers this,
but it requires the facade to know to set it. Risk: forgotten
on some code path. Mitigation: a single mandatory `transport` tag
on every Family-A span the facade emits; a test asserting the tag
is present on every call to every public method.

### Con 7 — Premature abstraction risk

The plan introduces `Kernel` as a class. If a year from now the
right shape turns out to be something different (e.g., a module-level
function `boot_kernel(workdir) -> KernelState` that returns a dict,
or a free-function API), the class abstraction would have been
mis-spent design budget. Mitigation: the class is thin — it owns
subsystem references and exposes thin delegators. It's not a
deep abstraction with custom behavior; it's a *holder*. The cost
of restructuring later is bounded to the holder itself; subsystems
stay reusable in any structure.

### Con 8 — Adds a public-API documentation burden

`embedding.md` is one new doc; the public-API surface (10-15
methods) needs reference documentation; threadsafety and event-loop
contracts need to be documented explicitly. The doc surface roughly
doubles the planned `docs/kernel/` size. Mitigation: this is partly
why `docs/kernel/` was created — to give these docs a clear home.
The doc work is part of the slice; it ships with the code.

## Concrete implementation outline

### New module: `vendor/LLMKernel/llm_kernel/kernel_facade.py`

~250 LOC. Single public class plus its dependencies.

```python
class Kernel:
    """Embeddable LLMKernel facade.

    Stability: unstable. Public API may change before substrate
    trajectory slice 4 lands. After that, semantic versioning applies.

    Threadsafety: all public methods threadsafe. Event subscription
    is async-only.

    Event loop: uses asyncio.get_running_loop() by default. Pass an
    explicit loop= to override. Does not call asyncio.run() for you.
    """

    def __init__(
        self, *,
        workdir: Path,
        config: Optional[Dict[str, Any]] = None,
        event_log_path: Optional[Path] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None: ...

    async def start(self) -> None:
        """Wire subsystems in canonical order (dispatcher →
        run-tracker → metadata-writer → supervisor → mcp_manager).
        Idempotent. No transports bound."""

    async def shutdown(self) -> None:
        """Reverse: drain transports → terminate agents → flush event
        log → snapshot metadata. Idempotent."""

    async def __aenter__(self) -> "Kernel": ...
    async def __aexit__(self, *exc) -> None: ...

    # Public delegators — thin wrappers over self._supervisor
    def spawn_agent(
        self, *, zone_id: str, agent_id: str, task: str,
        work_dir: Path, **kwargs,
    ) -> str: ...
    def send_user_turn(
        self, agent_id: str, text: str, *,
        cell_id: Optional[str] = None,
        inject_notebook_prefix: bool = True,
    ) -> Dict[str, Any]: ...
    def revert(self, agent_id: str, target_turn_id: str) -> None: ...
    def stop(self, agent_id: str) -> None: ...
    def list_agents(self) -> List[Dict[str, Any]]: ...
    def list_zones(self) -> List[Dict[str, Any]]: ...

    # Event log access
    async def subscribe_events(
        self, *, since: int = 0,
    ) -> AsyncIterator[Dict[str, Any]]: ...
    def read_event_log(
        self, *, since: int = 0, until: Optional[int] = None,
    ) -> List[Dict[str, Any]]: ...

    # Optional transport binding (no Transport protocol required for
    # embedding; this is a thin hook for the trajectory's slice 2.2)
    async def bind_transport(self, transport: Any) -> None:
        """Bind any object with async bind(kernel) / stop() methods."""

    async def run_forever(self) -> None:
        """Sleep until SIGTERM / cancellation. Convenience wrapper."""
```

Wiring inside `start()`:
1. Construct `CustomMessageDispatcher` (same as
   `_kernel_hooks.attach_dispatcher`).
2. Construct `RunTracker` with a fresh trace_id (same as
   `_kernel_hooks.attach_run_tracker`).
3. Construct `MetadataWriter` pointed at `event_log_path` (default:
   `workdir / ".llmnb" / "events.jsonl"`).
4. Construct `AgentSupervisor` with run_tracker, dispatcher, metadata
   writer (same as `_kernel_hooks.attach_agent_supervisor`).
5. Construct `MCPManager` (outbound client).
6. Mark `self._started = True`.

`shutdown()` reverses: cancel any bound transports → call
`supervisor.terminate_all()` (existing) → call `metadata_writer.flush()`
and `metadata_writer.snapshot()` → close dispatcher.

### Public-API surface decisions

Public (documented, stable-by-policy after slice 4):
- `spawn_agent`, `send_user_turn`, `revert`, `stop`
- `list_agents`, `list_zones`
- `read_event_log`, `subscribe_events`
- `bind_transport`, `run_forever`
- Class lifecycle: `__init__`, `start`, `shutdown`, async context manager

Private (underscore-prefixed):
- `_supervisor`, `_dispatcher`, `_run_tracker`, `_metadata_writer`,
  `_mcp_manager`
- `_transports: List[Any]`
- `_started: bool`, `_loop: asyncio.AbstractEventLoop`

Anti-public: no direct access to subsystems via attribute. If users
need behavior not exposed on the facade, that's a signal to extend
the facade, not to reach inside. (Exception: extensions go through
the slice-2 Extension protocol, deferred from this plan.)

### Entry-point refactor

[`__main__.py`](../../vendor/LLMKernel/llm_kernel/__main__.py)
subcommands and [`app.py`](../../vendor/LLMKernel/llm_kernel/app.py)
become facade consumers.

`pty-mode` subcommand becomes:
```python
async def pty_mode_main():
    async with Kernel(workdir=...) as k:
        await k.bind_transport(PTYTransportShim(...))
        await k.run_forever()
```

Where `PTYTransportShim` is a thin adapter wrapping the existing
`pty_mode._async_serve_socket(state)` and `pty_mode.boot_kernel()`
internals — NOT a new Transport protocol implementation. (The full
Transport protocol formalization is slice 2.2 of the trajectory,
which this plan does not deliver.)

`serve --transport tcp` becomes analogous with a `TCPTransportShim`.

`app.py`'s FastAPI lifespan body becomes:
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with Kernel(workdir=...) as k:
        app.state.kernel = k
        await k.bind_transport(PTYTransportShim(...))
        yield
```

The `_kernel_hooks.attach_kernel_subsystems` helper stays as-is for
the legacy IPython-kernel mode (`python -m llm_kernel` without
subcommands) — it attaches to an `IPythonKernel` instance which is a
different ownership model than the facade. Migration of that path
can wait.

### Tests

New file `vendor/LLMKernel/tests/test_kernel_facade.py`:
- `test_kernel_lifecycle_start_shutdown` — basic round trip.
- `test_kernel_lifecycle_idempotent` — double-start, double-shutdown.
- `test_kernel_context_manager` — `async with` happy path.
- `test_kernel_context_manager_shutdown_on_exception` — exception
  during body still triggers shutdown.
- `test_kernel_public_surface_delegates_to_supervisor` — for each
  public delegator, assert it calls through to the wrapped
  supervisor method with matching args.
- `test_kernel_event_log_accessor` — `read_event_log` returns
  expected shape.
- `test_kernel_subscribe_events_async_generator` — yields envelopes
  on activity, stops on shutdown.
- `test_kernel_bind_transport_calls_bind_then_stops_on_shutdown` —
  uses a stub transport with a `bind`/`stop` pair.

New file `vendor/LLMKernel/tests/test_kernel_facade_threadsafety.py`:
- `test_concurrent_spawn_calls_serialize_via_lock`
- `test_concurrent_send_user_turn_calls_no_interleave` (this
  intersects with slice-1 commit 4's stdin lock — verify the lock
  composes across facade and supervisor).

Existing tests must stay green: 60 supervisor tests, 7 round-trip
tests, the smoke tests via subprocess entry points. The refactor is
behavior-preserving for all entry points; if any of those tests
fail, the refactor is wrong.

### Documentation

`docs/kernel/architecture.md` (slice-2 deliverable per trajectory):
- The Kernel facade — purpose, lifecycle, public surface.
- Wiring sequence diagram (boot → start → bind transports → ready;
  shutdown is reverse).
- The Transport protocol — sketched here, formalized in slice 2.2
  of the trajectory.
- The Extension protocol — sketched here, formalized in slice 4 of
  the trajectory.

`docs/kernel/embedding.md` (slice-2 deliverable per trajectory):
- Library-embedding guide. `from llm_kernel import Kernel`, async
  context manager usage.
- Event-loop ownership rules.
- Threadsafety contract.
- A worked example: small Python script that spawns an agent, sends a
  turn, prints the event log, shuts down.
- Common patterns: testing fixtures, multi-transport binding,
  integration into a FastAPI app.

Update `docs/kernel/README.md` to mark `architecture.md` and
`embedding.md` as **Present** instead of **Planned — slice 2**.

## Commit decomposition

Each commit compiles and keeps existing tests green.

1. **`docs(kernel): wiring audit — current subsystem construction map`** —
   pre-implementation audit doc at `docs/kernel/_wiring-audit.md`
   (underscored to mark it as preparatory, not user-facing
   reference). Documents what exists today across `_kernel_hooks.py`,
   `app.py`, `pty_mode.py`, `serve_mode.py` so the facade can be
   verified against it. Delete or absorb this doc into
   `architecture.md` once the refactor lands.

2. **`feat(kernel): introduce Kernel facade — start/shutdown lifecycle`** —
   new `kernel_facade.py`, the class skeleton, `start()` /
   `shutdown()` / async context manager. No public delegators yet.
   Tests: lifecycle, idempotency, context manager.

3. **`feat(kernel): public API delegators on Kernel facade`** —
   `spawn_agent`, `send_user_turn`, `revert`, `stop`, `list_agents`,
   `list_zones`. Each is a thin delegator. Tests: delegation
   semantics.

4. **`feat(kernel): event log accessors on Kernel facade`** —
   `read_event_log`, `subscribe_events`. Tests: accessor shape,
   async iteration.

5. **`feat(kernel): bind_transport hook + run_forever convenience`** —
   thin transport hook (no formal Transport protocol yet). Tests:
   stub transport bind/stop, run_forever cancellation.

6. **`refactor(pty-mode): pty-mode subcommand consumes Kernel facade`** —
   `PTYTransportShim` adapts existing `pty_mode._async_serve_socket`.
   Smoke test stays green.

7. **`refactor(serve-mode): serve subcommand consumes Kernel facade`** —
   `TCPTransportShim`. Smoke test stays green.

8. **`refactor(app): FastAPI lifespan wraps Kernel facade`** —
   `app.py`'s lifespan body becomes
   `async with Kernel(...) as k: app.state.kernel = k; yield`. The
   `_state` module-level dict deprecated in favor of `app.state.kernel`.
   Health endpoint reads from `app.state.kernel` via `request.app.state`.
   BSP-004 amendment in the same commit.

9. **`test(kernel): threadsafety — concurrent public-method invocations`** —
   `test_kernel_facade_threadsafety.py`.

10. **`docs(kernel): architecture.md + embedding.md; mark Present in README`** —
    the two trajectory-planned docs. Update the README's file table.
    Delete `_wiring-audit.md` (absorbed into `architecture.md`).

## Verification

After each commit:
```powershell
pixi run -e kernel python -m pytest vendor/LLMKernel/tests/ -x -q
```

Smoke tests must keep passing throughout the refactor:
```powershell
pixi run -e kernel python -m llm_kernel pty-mode-smoke
pixi run -e kernel python -m llm_kernel agent-supervisor-smoke
pixi run -e kernel python -m llm_kernel metadata-writer-smoke
pixi run -e kernel python -m llm_kernel paper-telephone-smoke
```

Library-embedding smoke (new, after commit 5):
```powershell
pixi run -e kernel python -c "
import asyncio
from pathlib import Path
from llm_kernel import Kernel

async def main():
    async with Kernel(workdir=Path('./scratch')) as k:
        assert k.list_agents() == []
        # Don't actually spawn — that needs ANTHROPIC_API_KEY
        # Just verify the facade is usable as a library.
    print('facade smoke OK')

asyncio.run(main())
"
```

End-of-slice verification (after commit 10): full test suite + all
four subprocess smoke tests + the library-embedding smoke. All
must pass with no regressions.

## Next steps

Recommended ordering for the implementation phase:

1. **Resume slice 1 first.** The substrate trajectory's slice 1 has
   six commits left: `identity-model.md`, `capture-invariants.md`,
   three supervisor refactors, the metadata heartbeat change. Land
   those first — they're gateway hardening that benefits every
   subsequent slice (including this Python-object work).
2. **Then start this plan's commit 1** (the wiring audit doc).
   That's a read-only artifact; doesn't touch code; lets you see
   the planned facade against the current state in one document.
3. **Review the audit** before starting commit 2 (the facade class
   itself). The audit might surface things this plan didn't
   anticipate — entry-point quirks, BSP-004 subtleties, the
   `os._exit(rc)` semantics in `pty_mode.boot_kernel`. Better to
   find them in the audit than mid-refactor.
4. **Commit 2 onwards** proceed in the order above. Each commit is
   reviewable in isolation; commits 2-5 add new code without
   touching existing entry points; commits 6-8 refactor existing
   entry points to use the new code. The order matters: subsystem-
   side changes ship first; consumer-side changes ship second.
5. **Commit 10 (docs)** lands last. Documentation must reflect the
   *as-shipped* code; writing it earlier risks doc drift if the
   API shifts during implementation.
6. **After slice 2 facade lands**, the trajectory's slice 3 (external
   MCP transport) and slice 4 (PBX extension) become natural
   follow-ups. Slice 2.2 (formal Transport protocol) and the
   Extension protocol can be slotted in between if PBX is wanted
   sooner than slice 3.

## Relation to the approved substrate trajectory

This plan is the implementation detail for **the facade-extraction
half** of slice 2 in the substrate trajectory plan
(`~/.claude/plans/let-s-sketch-this-out-deep-peacock.md`).
The trajectory's slice 2 listed three things:

1. Kernel facade — **this plan delivers it.**
2. Transport protocol formalization — deferred from this plan;
   thin `bind_transport(Any)` hook is sufficient for embedding.
3. Extension protocol — deferred from this plan; not needed for
   embedding (only needed when PBX or other extensions are
   loaded).

When the facade lands, slice 2 of the trajectory is two-thirds
complete. Slice 2.2 (Transport protocol formalization) becomes a
small follow-up commit pair (define `Transport` Protocol class,
convert the shims into protocol implementations). Slice 2.3
(Extension protocol) lands when slice 4 (PBX) starts.

## What's deferred / out of scope

This plan does NOT cover:

- **Transport protocol formalization.** `bind_transport(transport)`
  accepts any object with async `bind(kernel)` and `stop()` methods;
  no formal `Transport(Protocol)` class is introduced. That happens
  in a follow-up.
- **Extension protocol.** Deferred until PBX (slice 4 of trajectory)
  needs it. The facade does not expose
  `register_extension(...)` until then.
- **External MCP transport (`MCPHTTPTransport`).** Slice 3 of the
  trajectory; depends on this facade landing first.
- **Sync API facade.** Async-only. If users need sync, they wrap
  their own `asyncio.run(...)` at call sites.
- **Executor abstraction (`Executor` protocol, polymorphic
  executors).** Deferred per the trajectory; only landing when
  polyglot pressure exists.
- **PBX itself.** Slice 4 of the trajectory; depends on this facade
  + the Extension protocol.
- **`_kernel_hooks.attach_kernel_subsystems` migration.** The legacy
  IPython-kernel entry point keeps the existing hooks helper; only
  the subcommand entry points and FastAPI lifespan migrate to the
  facade.
- **Migration of existing tests away from manual subsystem wiring.**
  Existing tests that instantiate `AgentSupervisor` etc. directly
  in fixtures keep doing so. The facade is an *additional* path,
  not a forced migration. Test fixtures may opportunistically
  switch to `Kernel(...)` over time.

---

This plan is approximately ~250 LOC of new code (the facade),
~100 LOC of entry-point refactors, ~150 LOC of new tests, and ~2-3
pages of documentation. It is reversible, behavior-preserving for
all existing entry points, and unblocks library-embedded use of the
kernel — which is the foundation the rest of the substrate
trajectory (external MCP transport, PBX extension) builds on.
