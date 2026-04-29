# Anti-pattern: subprocess.Popen("mitmdump", ...) directly

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: [RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md), [BSP-006 §2 (line 31 mitmdump table)](../../notebook/BSP-006-embedded-asgi.md), [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md)
**Related atoms**: [anti-patterns/path-propagation](path-propagation.md), [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md), [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md)

## The trap

`subprocess.Popen("mitmdump", [...])` directly relies on the spawning process's PATH containing the `mitmdump` binary. When the spawning process is a uvicorn lifespan handler (per [BSP-004 V2 attempt](../../notebook/BSP-004-kernel-runtime.md)), its thread context has a PATH inherited from a different ancestor than the Extension Host that "knows" where `mitmdump` is.

Result: `FileNotFoundError: 'mitmdump'` inside lifespan startup. The kernel doesn't boot. Tier 4 fails. The operator sees a kernel crash with no obvious cause — the Extension Host *can* find `mitmdump` (the test scaffolding verified it before launching the kernel), but the process the kernel actually spawned (uvicorn lifespan thread) cannot.

This is one specific instance of a wider class: **any binary the kernel spawns** by name rather than by absolute path is one PATH-context shift away from `FileNotFoundError`.

## Why the trap is silent

- Local dev: `mitmdump` is installed via pixi and on the developer's PATH globally; the bug never reproduces.
- CI: pixi-env binaries are at `<repo>/.pixi/envs/kernel/mitmdump.cmd` (Windows) or `.../bin/mitmdump` (POSIX); only on PATH if pixi shell-hook ran for the right env.
- Tier 4 is the only tier that exercises mitmdump's lifecycle inside a real kernel boot, so the regression doesn't surface until the highest tier runs.
- The error message points at a missing binary, not at "PATH is different than you think it is."

## The fix — discovery contract

[RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md) specifies the discovery contract for any binary the kernel spawns. Per [BSP-006 §2 line 31](../../notebook/BSP-006-embedded-asgi.md): *"Subprocess.Popen during lifespan startup ... mitmdump's subprocess EOF'd parent socket on Windows (V1); mitmdump not on PATH inside lifespan (V2)."* The cure is the same module that resolves [path-propagation](path-propagation.md):

```python
# BAD
proxy = subprocess.Popen(["mitmdump", "-p", str(port), ...])

# GOOD
mitmdump_bin = zone_control.locate_mitmdump_bin()
if mitmdump_bin is None:
    raise RuntimeError("mitmdump unresolvable; install via pixi or set LLMNB_MITMDUMP_BIN")
proxy = subprocess.Popen([mitmdump_bin, "-p", str(port), ...])
```

`locate_mitmdump_bin()` follows the same precedence as `locate_claude_bin()` per [RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md):

| Priority | Source |
|---|---|
| 1 | env var `LLMNB_MITMDUMP_BIN` |
| 2 | VS Code workspace setting |
| 3 | VS Code user setting |
| 4 | `package.json` default (typically null) |
| 5 | PATH lookup via `shutil.which("mitmdump")` |
| 6 | Pixi env probe — walk up from `cwd` for `.pixi/envs/kernel/mitmdump[.cmd|.exe]` |

When the probe (priority 6) hits, it sets the env var so subsequent subprocess spawns inherit the resolved path.

## The diagnostic rule

> **Don't spawn binaries by name from the kernel.** Always go through `zone_control.locate_*_bin()`. Bare-name `subprocess.Popen` is one PATH-context shift away from regression.

The rule applies to every binary the kernel ever spawns:
- `claude` (claude-code subprocess) — `zone_control.locate_claude_bin()`
- `mitmdump` (test proxy) — `zone_control.locate_mitmdump_bin()`
- `python` (only when re-launching kernel children) — `zone_control.locate_python_bin()`
- Any future MCP server binary — gets a new `locate_*_bin()` helper

Generalization: **every binary spawn is a discovery contract**. Either the contract is explicit (locate-then-spawn with the resolved absolute path) or it's implicit (rely on PATH at spawn time and pray). Implicit contracts are the source of [path-propagation](path-propagation.md) and this anti-pattern.

## What surfaced this

Per [BSP-004 V1.x retrospective](../../notebook/BSP-004-kernel-runtime.md): the BSP-004 V2 attempt to host the kernel under uvicorn's lifespan failed because lifespan-time `subprocess.Popen("mitmdump", ...)` couldn't find the binary. Reverting to legacy `main()` ([legacy-main-dispatch](../decisions/legacy-main-dispatch.md)) and migrating to `zone_control.locate_mitmdump_bin()` fixed it.

The fix landed regardless of runtime path. Whether V1 ships on legacy `main()` (current) or V3 ships on embedded ASGI (per [BSP-006](../../notebook/BSP-006-embedded-asgi.md)), the discovery contract is the same.

## Where this is enforced

- `vendor/LLMKernel/llm_kernel/zone_control.py` (RFC-009 §6) — `locate_mitmdump_bin()` and the per-binary helpers.
- Code review check: `grep -rn 'Popen\(\["mitmdump"\|Popen\("mitmdump"' vendor/LLMKernel/` should return zero hits. Same check for `claude`, etc.
- Test: `vendor/LLMKernel/tests/test_zone_control.py` includes `test_locate_claude_path_first_then_pixi` and `test_locate_claude_pixi_probe_walks_up`; analogous tests for `mitmdump` follow the same shape (RFC-009 §9).

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (BSP-004 V2 cycle, lifespan-context narrowing) | hours |
| Avoiding (always use zone_control.locate_*_bin) | 0 |

## See also

- [RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md) — the discovery contract specification.
- [RFC-009 §6](../../rfcs/RFC-009-zone-control-and-config.md) — the `zone_control` module.
- [BSP-006 §2](../../notebook/BSP-006-embedded-asgi.md) — the table that pins this case (line 31).
- [anti-patterns/path-propagation](path-propagation.md) — sibling: same root cause class.
- [anti-patterns/bsp-004-retrospective](bsp-004-retrospective.md) — sibling: where this surfaced.
- [decisions/legacy-main-dispatch](../decisions/legacy-main-dispatch.md) — V1 ships on legacy `main()`; this fix lands regardless.
