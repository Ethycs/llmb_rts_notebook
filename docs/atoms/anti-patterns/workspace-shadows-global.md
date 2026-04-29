# Anti-pattern: workspace settings.json silently shadows Global config update

**Status**: anti-pattern (already-hit; fixed)
**Source specs**: [Engineering Guide §11.8](../../../Engineering_Guide.md#118-vs-code-configuration-priority--workspace-beats-global), [RFC-009 §11](../../rfcs/RFC-009-zone-control-and-config.md)
**Related atoms**: [anti-patterns/path-propagation](path-propagation.md), [anti-patterns/secret-redaction](secret-redaction.md), [anti-patterns/rlock-logging](rlock-logging.md)

## The trap

`vscode.workspace.getConfiguration(section).update(key, value, ConfigurationTarget.Global)` only takes effect if no higher-priority scope already sets `key`. The VS Code config priority is **Workspace > Global > Default**. A test fixture's `.vscode/settings.json` is `Workspace` scope. If that file pins `"llmnb.kernel.useStub": false` and a test then does `update("kernel.useStub", true, Global)`, the read at activation time still returns `false` — the workspace value wins.

**The trap is silent**: `update(...).then(...)` resolves successfully. No warning, no error. The test thinks it set up a stub kernel; the extension activates with the live kernel; downstream typed waits time out.

## What happened

This anti-pattern surfaced as **3 simultaneous extension-test failures** with the same root cause:
- K71 ready-handshake never observed
- K72 terminal span never observed
- `lastAcceptedVersion === undefined` assertion in `metadata-applier.test.ts`

A hydrate-emitting live kernel raced `applyEdit` calls in unrelated metadata tests because the test fixture's `.vscode/settings.json` pinned `useStub: false` and tests trying to override at `Global` scope had no effect.

All three failures were fixed by **deleting one line** from `extension/test/fixtures/workspace/.vscode/settings.json`.

## Why the trap is silent

- The `update()` API doesn't fail or warn — it resolves cleanly even when its value gets shadowed on read.
- Tests pass in isolation if they don't share the workspace fixture.
- Failure surfaces only at the read site, where the test sees the wrong value but has no way to know it was overridden.
- The priority order isn't visible in error messages — you have to know `Workspace > Global > Default` to even suspect the problem.

## The diagnostic rule

> **A `settings.json` under a test fixture's `.vscode/` is part of the test contract.** Any setting pinned there is something the tests in that fixture cannot override at the Global scope, period.

When in doubt, **leave the setting unpinned and rely on the package.json default** — defaults yield to all `update()` calls regardless of target.

The full priority order (highest first):
1. `WorkspaceFolder`
2. `Workspace` (`.vscode/settings.json`)
3. `Global` (a.k.a. user)
4. Default (from `package.json` `contributes.configuration`)

## Fixes (pick one)

| Fix | When to use |
|---|---|
| **Don't pin the value in the workspace fixture** | First choice. Rely on the `package.json` default (lowest priority, yields to any `update`). |
| **Have the test use `ConfigurationTarget.Workspace`** | Mutates the on-disk fixture between runs — messy. Avoid unless the test is single-shot. |
| **Use a dedicated fixture per tier** | Best when stub-tier and live-tier need different defaults. One workspace folder per tier; each has the pinned value. |

## Generalization

This is one instance of a wider class: **a higher-priority config source silently shadowing a lower-priority update**. The same shape applies to:

- env vars (process-level) shadowing settings.json (workspace-level) reads after-the-fact via `process.env.LLMNB_*`
- `metadata.rts.config` (per-notebook) shadowing settings.json reads when the kernel resolves a per-notebook setting

[RFC-009](../../rfcs/RFC-009-zone-control-and-config.md) was drafted in part to pin the precedence order so this whole class becomes a question we never have to answer ad-hoc again. See [RFC-009 §11](../../rfcs/RFC-009-zone-control-and-config.md): *"Every config-class anti-pattern this project has hit could be re-cast as 'a setting was read from a source the operator didn't expect to win.'"*

## Cost of finding it vs cost of avoiding it

| Cost | Hours |
|---|---|
| Finding (most of an hour speculating it was the bug we'd already fixed twice) | ~1 |
| Avoiding (knowing the priority order) | 0 |

## See also

- [Engineering Guide §11.8](../../../Engineering_Guide.md#118-vs-code-configuration-priority--workspace-beats-global) — canonical narrative source.
- [RFC-009 §11](../../rfcs/RFC-009-zone-control-and-config.md) — the broader zone-control precedence framework that prevents this whole class.
- [anti-patterns/path-propagation](path-propagation.md) — sibling: silent extension-host PATH bug, also a config-priority shadow.
- [anti-patterns/secret-redaction](secret-redaction.md) — sibling: secrets must come from env-only, never settings.
- [anti-patterns/rlock-logging](rlock-logging.md) — sibling silent-bug class.
