# Decision: Embedded ASGI runtime deferred

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md), [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [decisions/legacy-main-dispatch](legacy-main-dispatch.md), [anti-patterns/bsp-004-retrospective](../anti-patterns/bsp-004-retrospective.md)

## The decision

**The embedded ASGI runtime sketched in [BSP-006](../../notebook/BSP-006-embedded-asgi.md) is deferred.** V1 keeps the legacy synchronous `main()` dispatch path. Per [BSP-006 §7 Recommendation](../../notebook/BSP-006-embedded-asgi.md):

> Tactical: Stay with legacy `main()` for V1 ship. It works. Don't block the cell roadmap (BSP-005) on a runtime swap.
>
> Strategic: When V3 multi-kernel coordination forces us to revisit, do this BSP. The 12-hour cost is reasonable when [V3+ triggers fire].

Three concrete triggers will reopen this decision:
1. V3+ fleet kernels need `/health` and per-zone uvicorn workers.
2. V2+ wire migration to HTTP-routed intent submission.
3. A third uvicorn-Windows-specific bug after the first two cost 12+ hours.

Until one fires, V1 ships on legacy `main()`.

## Rationale

1. **Both BSP-004 attempts to swap the runtime regressed Tier 4 e2e** (see [bsp-004-retrospective](../anti-patterns/bsp-004-retrospective.md) and [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md)). V1 (`run_in_executor`) EOF'd the parent socket at +1.4s; V2 (dedicated `threading.Thread` driven by uvicorn lifespan) failed differently with `mitmdump` `FileNotFoundError` inside the lifespan. Both fixes traced to subprocess/lifecycle behavior under uvicorn's thread context on Windows.

2. **Switching ASGI servers (hypercorn, granian, daphne) doesn't fix the underlying issue.** The bugs are subprocess-and-handle issues, not HTTP-server issues. Any third-party ASGI server inherits the same Windows quirks.

3. **Writing our own ASGI runtime costs ~12h** ([BSP-006 §6](../../notebook/BSP-006-embedded-asgi.md)). That's the budget when we own every line of the lifecycle. But V1 doesn't need any uvicorn feature: no `/health` consumer (V3+ only), no `--workers N` (one worker per kernel anyway), no HTTP/2/WS (RFC-008 socket is the data plane), no hot reload, no OpenAPI.

4. **The legacy `main()` works.** Per [legacy-main-dispatch](legacy-main-dispatch.md): the synchronous boot path is what shipped Tier 4 green 4/4 on 2026-04-28. There is no operator pain that the runtime swap would relieve in V1.

5. **Per [Engineering Guide §11.6](../../../Engineering_Guide.md#116-abandoning-specs-under-time-pressure)**: discipline is most valuable under pressure. The path forward is documented (BSP-006 sketches the design, BSP-004 §V3 sketches the read-loop). Deferring is not abandoning — the spec stays in tree, ready when a trigger fires.

## Operational consequences

| V1 behavior | Where enforced |
|---|---|
| `python -m llm_kernel pty-mode` invokes legacy synchronous `main()` | [legacy-main-dispatch](legacy-main-dispatch.md) |
| No FastAPI app, no uvicorn dependency in the kernel boot path | [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md) |
| Read loop runs on a kernel-owned thread, NOT on an asyncio event loop | [legacy-main-dispatch](legacy-main-dispatch.md) |
| `app.py` / `boot_kernel` / `shutdown_kernel` scaffolding from BSP-004 stays in tree (reusable by an embedded runtime identically to uvicorn) | [BSP-006 §7](../../notebook/BSP-006-embedded-asgi.md) |
| No `/health` HTTP endpoint in V1 | [BSP-006 §8 Q1](../../notebook/BSP-006-embedded-asgi.md) |
| Signal handling: legacy `signal.signal(SIGTERM, ...)` and `SIGINT` handlers as before BSP-004 | [legacy-main-dispatch](legacy-main-dispatch.md) |

## V1 vs V2+ vs V3+

| | V1 | V2+ (if HTTP wire ships) | V3+ (fleet kernels) |
|---|---|---|---|
| Boot | Legacy `main()` | `kernel_asgi.main(app)` (this BSP) or uvicorn | `kernel_asgi` per kernel; one kernel per zone |
| `/health` | None | HTTP/1.1 endpoint | HTTP/1.1 endpoint (probed by fleet manager) |
| HTTP intent submission | Out of scope | Adds via Starlette under `kernel_asgi` | Same |
| WebSocket data plane | Out of scope (RFC-008 socket) | 50-line WS handshake added to `kernel_asgi` | Same |
| Worker scaling | One process | One process | Many processes (one per zone) |

## See also

- [decisions/legacy-main-dispatch](legacy-main-dispatch.md) — the synchronous boot path V1 keeps.
- [anti-patterns/bsp-004-retrospective](../anti-patterns/bsp-004-retrospective.md) — the V1/V2 attempts that motivated this deferral.
- [BSP-006](../../notebook/BSP-006-embedded-asgi.md) — the ~300-line embedded ASGI design, ready when a trigger fires.
- [BSP-004 §V3 plan](../../notebook/BSP-004-kernel-runtime.md) — the `sock_recv`-based read loop that pairs with embedded ASGI.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
