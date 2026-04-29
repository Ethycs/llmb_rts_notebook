# Anti-pattern: stub-kernel race in onRunComplete inflight delete

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: stub-kernel controller, commit `b4ec3e3` (2026-04-26 V1 hero loop)
**Related atoms**: [anti-patterns/rlock-logging](rlock-logging.md), [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md), [anti-patterns/workspace-shadows-global](workspace-shadows-global.md)

## The trap

The original notebook controller deleted from its `inflight: Map<cellKey, exec>` AFTER awaiting `appendOutput(...)`. The synchronous fallback in `runOne()` checked `inflight.has(cellKey)` and called `exec.end(false)` whenever the entry was still present.

Sequence that broke:

1. Stub kernel completes a cell run.
2. Controller's `onRunComplete(cellKey)` starts: schedules `await exec.appendOutput(...)`.
3. Before the await resolves, `runOne()` (a sync fallback path) re-checks `inflight.has(cellKey)`. It's still `true` because the delete is *after* the await.
4. `runOne()` interprets "in flight but no resolution" as a stuck run and calls `exec.end(false)` — failing the cell.
5. The async commit then completes; `appendOutput` succeeds; but `exec` is already `end(false)`-ed. The output is silently discarded; the cell shows red.

## Why the trap is silent

- The async commit *does* succeed at the data layer; `metadata.rts` records the run normally.
- The cell ends in `end(false)` state, which renders identically to genuine failure — no operator-visible difference.
- The race window is tens of milliseconds; intermittent failures look like flakiness rather than a deterministic bug.
- Live kernel doesn't hit this path because `PtyKernelClient.executeCell` awaits the terminal span before the controller releases — so the race only surfaces in stub-kernel tests.
- Tests that exercise only the live kernel pass; tests that exercise only the stub pass; the only failing tests are the ones that live in between (controller + stub fallback).

## The fix

```typescript
// before — buggy
async onRunComplete(cellKey: string) {
  const exec = this.inflight.get(cellKey);
  await exec.appendOutput(...);   // race window opens here
  this.inflight.delete(cellKey);  // too late
  exec.end(true);
}

// after — synchronous delete at top
async onRunComplete(cellKey: string) {
  const exec = this.inflight.get(cellKey);
  this.inflight.delete(cellKey);  // closed before any await
  await exec.appendOutput(...);
  exec.end(true);
}
```

The principle: **mutate the synchronous lookup table BEFORE any await that another sync path could observe**. The `inflight` map is the synchronization primitive between the async commit and the sync fallback; it must reflect the true state at every microtask boundary.

## The diagnostic rule

> **Synchronous fallbacks racing async commits is a class.** If a sync path makes decisions based on the presence/absence of a key in a shared map, the async path that mutates that key MUST do the mutation BEFORE its first await — not after the work completes.

Generalization: anywhere you have:
- A shared mutable container (Map, Set, list)
- An async path that mutates the container after its work
- A sync path that reads the container to make a control-flow decision

… the sync path will sometimes read stale state. Cure: mutate first, then await.

This is a sibling pattern to [rlock-logging](rlock-logging.md): both are "a callback path observes intermediate state of a critical section." rlock-logging deadlocks on lock re-acquisition; this races on async/sync boundaries.

## Why live kernel is immune

`PtyKernelClient.executeCell` awaits the terminal span emitted by the kernel. By the time the extension-side controller fires `onRunComplete`, the kernel has already finished and the terminal span has propagated through the wire. There is no concurrent sync fallback — the live path has only one observer of completion.

The race exists ONLY in the stub kernel's inline-run-and-resolve path, which doesn't have the wire round-trip to serialize observers.

## Where this is enforced

- `extension/src/.../controller.ts` (the notebook controller registered with VS Code) — `onRunComplete` deletes from `inflight` synchronously at the top.
- Code review check: any `await` between `inflight.get(...)` and `inflight.delete(...)` is a regression.

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (intermittent failure investigation, log dive across stub paths) | hours |
| Avoiding (knowing the rule: mutate-before-await) | 0 |

## See also

- [anti-patterns/rlock-logging](rlock-logging.md) — sibling: callback path observes intermediate critical-section state, deadlocks instead of racing.
- [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md) — sibling: another async/thread interaction trap.
- [anti-patterns/workspace-shadows-global](workspace-shadows-global.md) — sibling silent-bug class (config-priority shadow rather than async race).
