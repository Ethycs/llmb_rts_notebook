# Anti-pattern: BSP-004 V1 + V2 attempts both regressed Tier 4

**Status**: anti-pattern (already-hit; both attempts reverted; V1 ships on legacy)
**Source specs**: [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md), [BSP-006 §2](../../notebook/BSP-006-embedded-asgi.md)
**Related atoms**: [anti-patterns/windows-fd-inheritance](windows-fd-inheritance.md), [anti-patterns/mitmdump-discovery](mitmdump-discovery.md), [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md), [decisions/asgi-deferred](../decisions/asgi-deferred.md)

## The trap

Two consecutive attempts to swap the kernel runtime from synchronous `main()` to uvicorn-hosted asyncio BOTH regressed Tier 4 e2e:

- **V1 (commit 2264834)**: `_run_read_loop` invoked via `loop.run_in_executor(None, ...)` from a uvicorn lifespan task. The read loop EOF'd 1.4s after the first agent_spawn handler returned. Tier 4 timed out at 180s where the prior session ran in 8.7s.
- **V2 (commit 6316037)**: Replaced the executor with a dedicated `threading.Thread` driven by uvicorn lifespan. Different regression — proxy startup `FileNotFoundError` inside lifespan. The lifespan runs in uvicorn's signal-handler context; `mitmdump`'s `subprocess.Popen` couldn't find the binary even though it was on the Extension Host's PATH (see [path-propagation](path-propagation.md) and [mitmdump-discovery](mitmdump-discovery.md)).

Both fixes were reverted; V1 ships on legacy `main()` per [legacy-main-dispatch](../decisions/legacy-main-dispatch.md).

## Why the traps were silent

- Pre-BSP-004 Tier 4 was 4/4 green. The runtime swap looked like a no-op refactor that should preserve behavior.
- The V1 marker file (`agent_spawn_received → supervisor_spawn_popen_started → agent_spawn_returned [+1.4s] async_serve_socket_exited`) didn't immediately point at handle inheritance — the EOF looked like a clean shutdown.
- The V2 `FileNotFoundError` for `mitmdump` looked like a missing-binary problem rather than a context-mismatch problem; the real cause was that uvicorn's lifespan runs in a different thread/context than the Extension Host that had `mitmdump` on its PATH.
- Switching ASGI servers (hypercorn, granian, daphne) doesn't fix either bug — both are subprocess-and-handle issues, not HTTP-server issues.

## Root causes (likely; per BSP-004 retrospective)

**V1**: `subprocess.Popen` on Windows, called from a thread-pool executor worker, has different handle-inheritance behavior than from the main thread. The data-plane socket is inheritable by default on Windows; when claude's child process is spawned from the executor worker that's mid-`select()` on the socket, something in the OS-level handle dance EOFs the parent's `recv()`. Cure: `set_inheritable(False)` on the data-plane socket immediately after creation (see [windows-fd-inheritance](windows-fd-inheritance.md)).

**V2**: uvicorn's lifespan runs in a signal-handler context where the Extension Host's PATH may not be the resolved PATH. The right cure is the [RFC-009 §4.2 discovery contract](../../rfcs/RFC-009-zone-control-and-config.md) — `zone_control.locate_*_bin()` everywhere — see [mitmdump-discovery](mitmdump-discovery.md). Until those fixes propagated, lifespan-time `subprocess.Popen("mitmdump", ...)` failed.

## The diagnostic rule

> **A "no-op" runtime swap can change the thread context of every subprocess.Popen and every socket allocation. On Windows, that changes everything.**

Generalizations:
- Test the runtime swap at the highest tier (Tier 4 e2e) before declaring victory; lower tiers don't exercise subprocess + socket simultaneously.
- When swapping runtimes, audit every `subprocess.Popen(...)` call site for "does this still run in the thread context I think it does?" — particularly around lifespan handlers.
- When a "no-op" refactor regresses an integration test, suspect handle/context interactions before suspecting the test.
- Per [BSP-006 §2](../../notebook/BSP-006-embedded-asgi.md): switching ASGI servers doesn't fix subprocess bugs. The cure is to control the lifecycle yourself (embedded ASGI per [asgi-deferred](../decisions/asgi-deferred.md)) OR to revert and ship on the known-good runtime.

## What landed regardless

The two strict improvements that landed independent of runtime path:

1. **`set_inheritable(False)` on the data-plane socket** (commit 51cc7a4). See [windows-fd-inheritance](windows-fd-inheritance.md). This neutralizes the V1 EOF mode regardless of whether the read loop runs on a worker thread or the main thread.
2. **`zone_control.locate_*_bin()` for binary discovery** (RFC-009 §4.2, §6). See [path-propagation](path-propagation.md), [mitmdump-discovery](mitmdump-discovery.md). This neutralizes the V2 `FileNotFoundError` regardless of which thread context invokes Popen.

V3 (sock_recv-based read loop, sketched in [BSP-004 §V3 plan](../../notebook/BSP-004-kernel-runtime.md) and [BSP-006 §4](../../notebook/BSP-006-embedded-asgi.md)) is queued behind V1 ship-readiness. The bet: those two fixes plus an embedded ASGI runtime per [BSP-006](../../notebook/BSP-006-embedded-asgi.md) makes V3 actually work.

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (V1 + V2 cycles, marker file forensics, hypothesis testing) | many hours across multiple sessions |
| Avoiding (set_inheritable + zone_control + ship on legacy main()) | 0 going forward |

## See also

- [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md) — the source narrative.
- [BSP-006](../../notebook/BSP-006-embedded-asgi.md) — the embedded ASGI design that closes this regression class.
- [anti-patterns/windows-fd-inheritance](windows-fd-inheritance.md) — the V1 root cause + fix.
- [anti-patterns/mitmdump-discovery](mitmdump-discovery.md) — the V2 root cause + fix.
- [anti-patterns/path-propagation](path-propagation.md) — sibling: same RFC-009 cure applies.
- [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md) — V1 ships on legacy `main()`.
- [decisions/asgi-deferred](../decisions/asgi-deferred.md) — embedded ASGI deferred until V3 trigger.
