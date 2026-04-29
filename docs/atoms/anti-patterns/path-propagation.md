# Anti-pattern: PATH does not propagate from extension host to spawned kernel

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: [RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md), [RFC-009 §11](../../rfcs/RFC-009-zone-control-and-config.md)
**Related atoms**: [anti-patterns/workspace-shadows-global](workspace-shadows-global.md), [anti-patterns/mitmdump-discovery](mitmdump-discovery.md), [anti-patterns/secret-redaction](secret-redaction.md)

## The trap

`node-pty` captures the Extension Host's `process.env.PATH` **at spawn time**. Mutations to `process.env.PATH` after the spawn don't propagate to the spawned kernel. Code that does:

```typescript
process.env.PATH = `${pixiBinDir};${process.env.PATH}`;   // too late
const kernel = pty.spawn(pythonBin, args, { ...opts });   // already captured the old PATH
```

… spawns a kernel that does NOT see `pixiBinDir` on its PATH. The kernel's `shutil.which("claude")` returns `None`; the supervisor's spawn fails with K83-class "binary not found"; the operator sees a cryptic K23 "agent runtime died" instead of the actual `FileNotFoundError`.

The same trap applies any time the extension activates BEFORE the discovery code runs. Even careful PATH mutation in extension activation is racing the first kernel spawn.

## Why the trap is silent

- Extension dev machines have claude on `process.env.PATH` already (installed system-wide), so the bug is invisible during local dev.
- CI machines rely on pixi-env claude, which is exactly the case the trap breaks.
- The kernel-side error message (`FileNotFoundError`) doesn't surface in the extension UI; the operator sees a K23 about an agent dying with no obvious cause.
- POSIX vs Windows differ: POSIX has a unified PATH; Windows additionally has `PATHEXT` quirks where `claude.cmd` resolves but `claude` does not.

## The fix — discovery as a contract

[RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md) specifies the discovery contract for any binary the kernel spawns. Per-setting precedence for file paths:

| Priority | Source |
|---|---|
| 1 | env var override (`LLMNB_CLAUDE_BIN`, `LLMNB_PYTHON_BIN`) |
| 2 | VS Code workspace setting (`llmnb.kernel.claudePath`, `llmnb.kernel.pythonPath`) |
| 3 | VS Code user setting |
| 4 | `package.json` default (often `null` / unset) |
| 5 | PATH lookup via `shutil.which` (kernel) / `where`/`which` (extension) |
| 6 | Pixi env discovery probe — walk up from cwd looking for `<repoRoot>/.pixi/envs/kernel/<bin>` |

The kernel uses `zone_control.locate_*_bin()` (per RFC-009 §6) so PATH can be undefined and binaries still resolve via the pixi probe (priority 6). The extension mirrors §4.2 in its preflight and exports the resolved path via env var so the kernel inherits it before any spawn.

The probe rules (kernel side):
- Walk up from `os.getcwd()` for at most 6 levels looking for `.pixi/envs/kernel/`.
- On Windows, look for `<binname>.cmd` then `<binname>.exe` then `<binname>` inside that dir.
- On POSIX, look for `<binname>` inside `.pixi/envs/kernel/bin/`.
- On match, return the absolute path AND set the corresponding env var (`LLMNB_CLAUDE_BIN`, etc.) so subsequent subprocess spawns inherit it.

## The diagnostic rule

> **Don't trust PATH across the extension/kernel boundary.** The extension MUST resolve binary paths and pass them to the kernel via env var or CLI arg before the spawn. The kernel MUST go through `zone_control.locate_*_bin()`, never `shutil.which` directly.

Generalization: **any process boundary is a config boundary**. PATH is the obvious case but the same applies to:
- `LD_LIBRARY_PATH` (POSIX) / `PATH` extensions for DLLs (Windows)
- Locale (`LANG`, `LC_ALL`) — affects subprocess argument parsing
- Working directory (`cwd`) — node-pty captures Extension Host's cwd, not the workspace folder
- Environment variables generally — anything mutated post-spawn doesn't propagate

## Where this is enforced

- `vendor/LLMKernel/llm_kernel/zone_control.py` (RFC-009 §6) — every kernel-side binary lookup goes through `locate_*_bin()`.
- Extension preflight (per [RFC-009 §10 step 6](../../rfcs/RFC-009-zone-control-and-config.md)) — mirrors §4.2, exports `LLMNB_CLAUDE_BIN` to `process.env` before any kernel spawn.
- Existing call sites migrated:
  - `agent_supervisor.py`'s `shutil.which("claude")` → `zone_control.locate_claude_bin()`
  - `_provisioning.py`'s discovery → reads `zone_control.effective_use_bare()`
  - `pty_mode.py`'s env reads → resolved through `zone_control` at boot

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (cross-machine reproduction, marker file forensics) | several across multiple sessions |
| Avoiding (using zone_control everywhere, never bare `shutil.which`) | 0 |

## See also

- [RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md) — the discovery contract.
- [RFC-009 §11](../../rfcs/RFC-009-zone-control-and-config.md) — "Every config-class anti-pattern this project has hit could be re-cast as 'a setting was read from a source the operator didn't expect to win.'"
- [anti-patterns/mitmdump-discovery](mitmdump-discovery.md) — sibling: same discovery contract applies to `mitmdump`.
- [anti-patterns/workspace-shadows-global](workspace-shadows-global.md) — sibling: another silent config-priority bug.
- [anti-patterns/secret-redaction](secret-redaction.md) — sibling: same RFC-009 §4.4 zone-control discipline.
