# Anti-pattern: Windows socket handles are inheritable by default

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md), [BSP-006 §4](../../notebook/BSP-006-embedded-asgi.md)
**Related atoms**: [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md), [anti-patterns/path-propagation](path-propagation.md), [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md)

## The trap

`socket.socket()` on Windows returns handles that are **inheritable by default**. When the kernel calls `subprocess.Popen(...)` to spawn claude, the child process inherits ALL inheritable handles in the parent's handle table — including the kernel's own data-plane socket.

The child doesn't *use* the inherited socket. But its presence in the child's handle table means the kernel cannot cleanly close the socket: the OS keeps the underlying connection open until every handle (parent's AND child's) is released. Worse, on the child's exit (or sometimes mid-run on Windows specifically), the OS-level handle dance can EOF the parent's `recv()`.

## What happened to the BSP-004 V1 attempt

Per [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md): the V1 runtime swap (uvicorn lifespan running `_run_read_loop` in a thread-pool executor) regressed Tier 4 e2e. Marker file showed:

```
agent_spawn_received → supervisor_spawn_popen_started (pid=53016) → agent_spawn_returned
[+1.4s]
async_serve_socket_exited
```

The kernel's read loop EOF'd 1.4s after Popen spawned claude. **The data-plane socket was inheritable by default**; the executor-worker thread that ran `subprocess.Popen` was mid-`select()` on the parent's socket; the OS-level handle inheritance interaction EOF'd the parent's `recv()` on Windows.

The fix landed regardless of runtime path:

```python
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.set_inheritable(False)   # commit 51cc7a4 — strictly prevent leak into children
```

Calling `set_inheritable(False)` immediately after creation removes the handle from any subsequent `subprocess.Popen`'s inheritance set. Already shipped in `vendor/LLMKernel/llm_kernel/socket_writer.py`.

## Why the trap is silent

- The default behavior is documented but easily missed: POSIX `socket.socket()` returns non-inheritable handles by default since Python 3.4 (PEP 446); **Windows is the exception that flips the default back to inheritable for sockets**.
- Code that runs fine on POSIX CI/dev machines breaks only on Windows.
- The failure mode (parent socket EOFs) doesn't point at the spawned subprocess as the cause — the subprocess and the socket appear unrelated.
- Tier 4 is the only test that exercises both real `subprocess.Popen` AND real socket I/O simultaneously, so unit and integration tiers don't catch it.

## The diagnostic rule

> **On Windows, every fresh socket is a handle leak waiting to happen.** Call `set_inheritable(False)` immediately after `socket.socket(...)` and BEFORE any subprocess in the same process tree could spawn.

The rule generalizes to any OS resource that subprocesses inherit:
- File descriptors (POSIX `os.set_inheritable(fd, False)` or open with `O_CLOEXEC`)
- Pipe ends (close in the parent after fork; mark non-inheritable on Windows)
- Socket handles (this case)
- Named handles / mutexes / events on Windows

The contract: **if a child process doesn't need a parent resource, the parent must suppress inheritance before any spawn**.

## Where this is enforced

- `vendor/LLMKernel/llm_kernel/socket_writer.py` — the data-plane socket calls `set_inheritable(False)` immediately after `socket.socket(...)` (commit 51cc7a4).
- New socket allocations in the kernel MUST follow the same pattern. Code review check: any `socket.socket(` without an immediate `set_inheritable(False)` on the next line is a regression.

## Why this fix lands regardless of runtime

Per [BSP-006 §4](../../notebook/BSP-006-embedded-asgi.md): the V3 read-loop design puts dispatcher work back on a worker thread, which is exactly the BSP-004 V1 condition that broke us. **The bet is that the inheritability fix neutralizes the original failure mode regardless of which thread runs Popen.** The fix is a strict improvement whether V1 ships on legacy `main()` ([legacy-main-dispatch](../decisions/legacy-main-dispatch.md)) or V3 ships on embedded ASGI.

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (cycle of marker files, hypothesis, narrowing to "happens after Popen") | several |
| Avoiding (knowing the Windows default) | 0 |

## See also

- [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md) — the failure narrative.
- [BSP-006 §4](../../notebook/BSP-006-embedded-asgi.md) — the V3 design that depends on this fix being in place.
- [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md) — sibling: the runtime-swap regressions that this fix partially addresses.
- [anti-patterns/path-propagation](path-propagation.md) — sibling: another extension/kernel boundary subprocess-environment bug.
- [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md) — V1 ships on legacy `main()`; this fix lands regardless.
