# Anti-pattern: logging inside a lock the log handler may re-enter

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: [Engineering Guide §11.7](../../../Engineering_Guide.md#117-logging-inside-a-lock-the-log-handler-may-re-enter)
**Related atoms**: [discipline/save-is-git-style](../discipline/save-is-git-style.md), [anti-patterns/stub-kernel-race](stub-kernel-race.md)

## The trap

A module holds a `threading.Lock` around its critical section. Inside that section it calls `logger.warning(...)`. The logger's handler routes log records back through the *same module's* surface. The non-reentrant lock deadlocks on the second acquire by the same thread.

## What happened to SocketWriter

The exact sequence that cost ~50 minutes of test hang:

1. `SocketWriter.write_frame` acquires `self._lock` and calls `sock.sendall(...)`.
2. `sendall` raises (broken socket).
3. The error path calls `logger.warning("write failed: ...")`.
4. The root logger has an `OtlpDataPlaneHandler` whose backing writer is the same `SocketWriter` instance.
5. `OtlpDataPlaneHandler.emit(record)` calls `self._writer.write_frame(<log_record>)`.
6. `write_frame` tries to acquire `self._lock` — **already held by step 1 → deadlock**.

The fix was one line: `threading.Lock` → `threading.RLock`. Re-entrance from the same thread is now allowed.

## Why the trap is silent

- Tests pass in isolation: the handler isn't wired to the writer in unit tests.
- Failure surfaces only when the log handler is wired live (kernel pty mode where `OtlpDataPlaneHandler` is installed on the root logger).
- The handler doesn't fail or warn — it just blocks. Ctrl-C eventually unsticks the test runner; the operator sees a hung process, not a stack trace.
- Static analysis won't catch it; the cycle is dynamic (handler → writer → lock).

## The diagnostic rule

> **If your log path goes through your data path, those paths must be re-entrant.**

Anywhere you have:
- A module-level lock (data plane), AND
- That logs from inside the critical section, AND
- A logging handler that invokes the same module's surface

… apply ONE of the three fixes:
1. Switch to `threading.RLock` so the same thread may re-acquire.
2. Move the logging call outside the `with` block (release the lock first).
3. Use a dedicated lock for the log path.

## Generalization

Any callback path that logs MUST be re-entrant against the locks it transitively holds. Applies broadly:

- Socket writers (the SocketWriter case)
- File writers (a stream handler that flushes back to the same file)
- Queue producers (a queue's full-warning that re-enters the queue's enqueue)

Anywhere a producer's error path emits a log record AND the log handler is consumed by the same producer.

## Where this is enforced

- `kernel/.../socket_writer.py` uses `threading.RLock`.
- New module-level locks in the kernel that may log from inside their critical section MUST be `RLock` by default. Use `Lock` only when you've proven (a) no logging inside the section, and (b) no re-entrance possible from any handler.

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (debug cycle, monitor watching, hypothesis testing) | ~1 |
| Avoiding (knowing the rule) | 0 |

## See also

- [Engineering Guide §11.7](../../../Engineering_Guide.md#117-logging-inside-a-lock-the-log-handler-may-re-enter) — the canonical narrative source.
- [anti-patterns/stub-kernel-race](stub-kernel-race.md) — sibling silent-bug class (synchronous fallback racing async commit).
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — durable-state discipline; relates to making concurrent paths explicit.
- [anti-patterns/workspace-shadows-global](workspace-shadows-global.md) — sibling: silent VS Code config priority bug.
