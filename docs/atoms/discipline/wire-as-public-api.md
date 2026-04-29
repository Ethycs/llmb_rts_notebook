# Discipline: Wire as public API

**Status**: V1.5 reserved (concept locked; slice queued as PLAN-S5.0.3, not yet dispatched)
**Source specs**: [PLAN-S5.0.3 §4](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#4-wire-interface-contract) (public surface + version constants + handshake), [PLAN-S5.0.3 §3.2](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#32-what-moves-where) (`_rfc_schemas` → `wire/tools.py`), [PLAN-S5.0.3 §7.1](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#71-round-0-operator-30min) (RFC-006 amendment), [RFC-006 §"Backward-compatibility analysis"](../../rfcs/RFC-006-kernel-extension-wire-format.md)
**Related atoms**: [text-as-canonical](text-as-canonical.md), [concepts/driver](../concepts/driver.md), [protocols/wire-handshake](../protocols/wire-handshake.md), [concepts/transport-mode](../concepts/transport-mode.md)

## The rule

**The wire envelope is the contract surface.** Internal kernel implementations (`agent_supervisor`, `metadata_writer`, `run_tracker`, `_provisioning`, `custom_messages` dispatcher) may change shape and signature at will between releases. The wire envelope shapes (`llm_kernel.wire.families`) and tool schemas (`llm_kernel.wire.tools`) are versioned, semver-stable, and the only thing external clients depend on. Public means published to `llm_kernel.wire`; everything else is private regardless of underscore prefix or lack thereof.

## What "public" means in this codebase

| Surface | Public? | Stability guarantee |
|---|---|---|
| `llm_kernel.wire.families.*` (Family A/B/C/F/G envelope shapes) | yes | semver; major bump = breaking |
| `llm_kernel.wire.tools.TOOL_CATALOG` (RFC-001 tool schemas) | yes | semver; minor = additive |
| `llm_kernel.wire.version.WIRE_VERSION` | yes | the version itself |
| `llm_kernel.wire.schemas/*.json` (build-time JSON Schema export) | yes | mirrors Python validators |
| `llm_kernel.agent_supervisor`, `metadata_writer`, etc. | no | may change any release |
| `llm_kernel._rfc_schemas`, `_provisioning`, `_*` | no (and underscore signals it) | may change any release |
| `llm_kernel.custom_messages` | no (dispatcher is internal; the *envelope shapes* it dispatches live in `wire/families.py`) | may change any release |

## How versioning works

Per [PLAN-S5.0.3 §4.2](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#42-version-constants-locked):

```python
# llm_kernel/wire/version.py — single source of truth
WIRE_VERSION = "1.0.0"   # semver; bumped by RFC-006 amendments
WIRE_MAJOR = 1
WIRE_MINOR = 0
WIRE_PATCH = 0
```

Both PEP-517 distributions (server `llmnb-kernel`, driver `llmnb`) import from this module. The wire version is independent of either package's release version: a kernel `1.4.7` and a driver `0.9.2` can interoperate iff their `WIRE_MAJOR` matches and the kernel's `WIRE_MINOR` ≥ the driver's.

The [`kernel.handshake` envelope](../protocols/wire-handshake.md) is the runtime mechanism that enforces this:

- Major mismatch → kernel closes the transport with `auth_failed`-shaped error.
- Minor skew → warning in the response payload's `warnings` array; both sides proceed.
- Patch differences → ignored.

## Why the wire (not Python imports)

Three motivating pressures from PLAN-S5.0.3 §1:

1. **Drivers other than the extension exist now.** Headless `llmnb execute` CLI; future Rust/Go orchestrators. None of them can or should import Python.
2. **Driver-as-internals causes drift.** Smokes that imported `agent_supervisor`, `metadata_writer` directly diverged from the wire-only path the extension uses. The fix is not "discipline" — it's making the wire the only path available to drivers.
3. **External clients have no contract today.** Underscore-prefixed `_rfc_schemas.py` and kernel-internal `custom_messages.py` are reverse-engineered by the TypeScript side. Promotion to `llm_kernel.wire` makes the contract grep-discoverable from any consumer.

## Authoring vs runtime — pairs with text-as-canonical

The wire-as-public-API discipline is the **runtime** layer counterpart to [text-as-canonical](text-as-canonical.md)'s **authoring** layer rule. The operator authors in cell text; the [driver](../concepts/driver.md) translates the parsed text to wire envelopes; the kernel speaks only wire. Both are "single source of truth" disciplines applied at different layers — text is canonical at storage/edit time; the wire is canonical at runtime/dispatch time.

## What this rules out

| Anti-shape | Why wrong |
|---|---|
| Driver imports `llm_kernel.custom_messages.dispatch(...)` directly | Dispatcher is internal; ship the envelope through the transport instead. |
| Adding a new envelope shape to `wire/families.py` without an RFC-006 minor bump | Public surface changes are RFC-tracked; otherwise consumers can't reason about compatibility. |
| Bumping `WIRE_MAJOR` without an RFC-006 v3.0.0 amendment | Major bumps break every existing driver; require a deliberate, documented break. |
| Cross-package access to `llm_kernel._rfc_schemas` from `llm_client/**` | Underscore-prefixed modules are private. Lint rejects this per [PLAN-S5.0.3 §3.3](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#33-lint-boundary). |
| Two competing definitions of an envelope shape (one in `wire/`, one in `custom_messages.py`) | One source of truth: `wire/families.py`. The dispatcher imports from there. |

## See also

- [text-as-canonical](text-as-canonical.md) — the authoring-layer counterpart.
- [concepts/driver](../concepts/driver.md) — what consumes the public surface.
- [protocols/wire-handshake](../protocols/wire-handshake.md) — runtime enforcement of version semantics.
- [concepts/transport-mode](../concepts/transport-mode.md) — same wire across PTY / Unix / TCP.
- [protocols/operator-action](../protocols/operator-action.md) — concrete envelope this rule governs.
