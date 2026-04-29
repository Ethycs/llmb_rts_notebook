# Decision: V1 ships with legacy synchronous main() kernel boot

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md), [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [decisions/asgi-deferred](asgi-deferred.md), [anti-patterns/bsp-004-retrospective](../anti-patterns/bsp-004-retrospective.md), [anti-patterns/windows-fd-inheritance](../anti-patterns/windows-fd-inheritance.md)

## The decision

**V1 ships the kernel using the legacy synchronous `main()` boot path.** The BSP-004 V1 attempt (`_run_read_loop` on a thread-pool executor under uvicorn) and the V2 attempt (dedicated `threading.Thread` driven by uvicorn lifespan) BOTH regressed Tier 4 e2e. Both attempts were reverted; the kernel ships on the pre-BSP-004 boot path.

Concretely: `python -m llm_kernel pty-mode` invokes the synchronous `_pty_main` directly. No uvicorn. No FastAPI. No asyncio event loop in the boot path. The read loop runs on a kernel-owned `threading.Thread`. Signal handlers use the standard `signal.signal(SIGTERM, ...)` / `SIGINT` dance.

The `app.py` / `boot_kernel` / `shutdown_kernel` scaffolding from BSP-004 stays in tree because it is reusable by the eventually-embedded ASGI runtime ([asgi-deferred](asgi-deferred.md), [BSP-006](../../notebook/BSP-006-embedded-asgi.md)).

## Rationale

1. **Tier 4 green is the V1 ship gate.** Per [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md): the V1 attempt ran 1.4s before `async_serve_socket_exited`, after which the operator's `notify` span never reached the cell — Tier 4 timed out at 180s where the prior session ran in 8.7s. The V2 attempt regressed differently (proxy startup `FileNotFoundError` inside lifespan). Legacy `main()` ran 4/4 green on 2026-04-28.

2. **The bugs are Windows subprocess + handle interactions, not "uvicorn vs hypercorn."** Per [BSP-006 §2](../../notebook/BSP-006-embedded-asgi.md): switching ASGI servers doesn't fix the underlying `subprocess.Popen` issues on Windows. The cure was twofold:
   - `set_inheritable(False)` on the data-plane socket immediately after creation (commit 51cc7a4; see [windows-fd-inheritance](../anti-patterns/windows-fd-inheritance.md)).
   - Reverting to legacy `main()` so subprocess.Popen runs from the main thread, the same context it ran in pre-BSP-004.

3. **Legacy `main()` is the known-good control sample.** The same boot path is what produced 4/4 Tier 4 green sessions before BSP-004 was attempted. Reverting was the lowest-risk path to V1 ship.

4. **Per [Engineering Guide §11.6](../../../Engineering_Guide.md#116-abandoning-specs-under-time-pressure)**: V1 ship-readiness beats runtime elegance. The runtime swap is an architectural improvement; it is not a V1 requirement. BSP-004 stays as the spec; V1 ships on the legacy path; V3 reopens the question per [asgi-deferred](asgi-deferred.md).

## Operational consequences

| V1 behavior | Where enforced |
|---|---|
| `python -m llm_kernel pty-mode` calls `_pty_main` synchronously | `vendor/LLMKernel/llm_kernel/__main__.py` |
| Read loop runs on a kernel-owned `threading.Thread`, not asyncio | `vendor/LLMKernel/llm_kernel/pty_mode.py` |
| Signal handlers use `signal.signal(SIGTERM, ...)` / `SIGINT` directly | pre-BSP-004 boot path |
| `subprocess.Popen` for claude-code subprocess runs from the main thread | [windows-fd-inheritance](../anti-patterns/windows-fd-inheritance.md) |
| Data-plane socket carries `set_inheritable(False)` post-creation | [windows-fd-inheritance](../anti-patterns/windows-fd-inheritance.md) (commit 51cc7a4) |
| BSP-004 `app.py` / `boot_kernel` / `shutdown_kernel` stays in tree, untouched, awaiting V3 | [asgi-deferred](asgi-deferred.md) |
| No `/health` endpoint, no FastAPI, no uvicorn import on kernel boot | [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md) |

## V1 vs V2+ vs V3+

- **V1**: legacy `main()`. Synchronous. Threaded read loop. Tier 4 green.
- **V2+**: legacy `main()` keeps shipping unless a wire migration to HTTP-routed intents triggers the embedded ASGI per [asgi-deferred](asgi-deferred.md).
- **V3+**: fleet kernels (one per zone) trigger the embedded ASGI per [BSP-006](../../notebook/BSP-006-embedded-asgi.md). Legacy `main()` MAY remain for non-fleet dev paths.

## See also

- [decisions/asgi-deferred](asgi-deferred.md) — the embedded-ASGI deferral.
- [anti-patterns/bsp-004-retrospective](../anti-patterns/bsp-004-retrospective.md) — what BSP-004 V1/V2 broke.
- [anti-patterns/windows-fd-inheritance](../anti-patterns/windows-fd-inheritance.md) — the parallel fix that lands regardless of runtime path.
- [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md) — the source narrative.
- [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md) — "Stay with legacy main() for V1 ship."
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
