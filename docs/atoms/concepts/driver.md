# Driver

**Status**: V1.5 reserved (concept locked; slice queued as PLAN-S5.0.3, not yet dispatched)
**Source specs**: [PLAN-S5.0.3 §3](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#3-reorg-shape) (package layout), [PLAN-S5.0.3 §6](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#6-cli-surface) (executor CLI), [PLAN-S5.0.3 §9](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#9-interface-contracts-locked-before-dispatch) (driver interface contracts), [RFC-008 §"Transport boundary"](../../rfcs/RFC-008-pty-transport.md)
**Related atoms**: [agent](agent.md), [transport-mode](transport-mode.md), [discipline/wire-as-public-api](../discipline/wire-as-public-api.md), [contracts/kernel-client](../contracts/kernel-client.md), [protocols/wire-handshake](../protocols/wire-handshake.md)

## Definition

A **driver** is a peer-of-extension client that consumes the [wire](../discipline/wire-as-public-api.md) (Family A/B/C/F/G envelopes + tool schemas) and reaches the kernel only through `llm_kernel.wire`. It is NOT a kernel internal — drivers cannot import `llm_kernel.agent_supervisor`, `llm_kernel.metadata_writer`, `llm_kernel.run_tracker`, or any other non-`wire` submodule. The VS Code extension is one driver. The headless `llmnb execute` CLI is another. Future Rust/Go orchestrators are drivers too. Drivers are clients of the wire; they are not extensions of the kernel.

## What makes something a driver

| Trait | Driver | Kernel internal |
|---|---|---|
| Imports `llm_kernel.wire.*` | yes | yes |
| Imports `llm_kernel.<other>` | **forbidden** (lint K-class) | yes |
| Speaks Family A/B/C/F/G envelopes | yes | yes (it produces them) |
| Owns `MetadataWriter`, `AgentSupervisor`, `DriftDetector` state | no | yes |
| Distributable independently | yes (separate PEP-517 dist) | no (server distribution) |
| Replaceable by another implementation language | yes (Rust/Go/TS) | no (Python authoritative) |

## The lint boundary (enforced)

Per [PLAN-S5.0.3 §3.3](../../notebook/PLAN-S5.0.3-driver-extraction-and-external-runnability.md#33-lint-boundary), CI rejects any import of the form `llm_kernel.<x>` where `<x> != "wire"` from any path under `llm_client/**`. A unit test (`tests/test_lint_boundary.py`) re-runs the same check so the rule is visible inside the repo, not only on CI.

This is the formal version of a discipline the VS Code extension already follows by virtue of being TypeScript: it cannot import Python kernel modules at all. The lint generalises that property to any future Python-side driver.

## V1 driver inventory

| Driver | Lives in | Transport | Role |
|---|---|---|---|
| **VS Code extension** | `extension/` | PTY (V1) → Unix/TCP (V1.5) | Operator-facing notebook UI |
| **`llmnb execute` CLI** | `llm_client/cli/` | PTY (default) or `--connect` over Unix/TCP | Headless run; tests-as-notebooks |
| **Smokes** (post-S5.0.3b) | `llm_client/cli/smoke.py` | PTY | Migration target for `python -m llm_kernel <name>-smoke` |

V2+ candidates: a Rust orchestrator over TCP; a Jupyter ZMQ shim driver wrapping `llm_client.driver`.

## Anti-shapes (forbidden)

| Anti-shape | Why wrong |
|---|---|
| Driver imports `llm_kernel.metadata_writer` to "just read the snapshot directly" | Bypasses the Family F wire; creates a second code path that drifts from the extension's wire-only path |
| Driver mutates `metadata.rts` by calling `MetadataWriter.set_field(...)` | Only the kernel writes `metadata.rts`. Drivers ship envelopes; kernel applies them. See [contracts/metadata-writer](../contracts/metadata-writer.md). |
| Driver reaches into `_provisioning.py` for spawn helpers | Kernel-internal. Drivers ship `agent_spawn` operator-action envelopes per [protocols/operator-action](../protocols/operator-action.md). |
| Smoke imports `_CommMgr` directly to fake a transport | Test scaffolding belongs under `llm_client/_test_helpers/` with the lint exemption documented per the same brief. |
| New driver speaks an underscore-prefixed import (`from llm_kernel._rfc_schemas import ...`) | Underscore prefix is the public API marker; only `llm_kernel.wire` is exported. See [discipline/wire-as-public-api](../discipline/wire-as-public-api.md). |

## Why this concept matters

Pre-S5.0.3, every smoke and one-off automation imported kernel internals because there was no other path. Each new driver path multiplied the "almost-the-wire-but-not-quite" surface, and changes to internals silently broke smokes that were supposed to be exercising the wire. Naming "driver" as a category — and locking the lint boundary — makes the contract surface visible. Anything that wants to drive the kernel either uses the wire or it isn't a driver.

<!-- S5.0.3b ship note: llm_client/ package created; boot_minimal_kernel + KernelConnection in llm_client/boot.py; ship_envelope + collect_snapshots in llm_client/driver.py; transport stubs in llm_client/transport/; _run_agent_supervisor_smoke refactored to consume boot_minimal_kernel; lint boundary enforced by tests/test_lint_boundary.py. Source commit: <TBD-after-commit>. Status NOT flipped — awaiting S5.0.3c/d/e. -->

## See also

- [discipline/wire-as-public-api](../discipline/wire-as-public-api.md) — the contract surface drivers consume.
- [protocols/wire-handshake](../protocols/wire-handshake.md) — first envelope every driver sends.
- [transport-mode](transport-mode.md) — drivers may use any transport behind the same envelope contract.
- [agent](agent.md) — distinct concept: an in-notebook executor, not a peer-of-extension client.
- [contracts/kernel-client](../contracts/kernel-client.md) — one driver implementation (the extension's TypeScript class).
