# Protocol: Jupyter kernel architecture — mapping to LLMKernel

**Status**: `protocol` (V1 — descriptive; documents an existing structural correspondence, no new wire)
**Family**: meta — describes how RFC-006 Families A-F relate to Jupyter's 5-socket kernel protocol
**Direction**: bidirectional analysis
**Source specs**: [Jupyter messaging spec v5.4](https://jupyter-client.readthedocs.io/en/stable/messaging.html) (external), [RFC-006](../../rfcs/RFC-006-kernel-extension-wire-format.md), [BSP-003](../../notebook/BSP-003-writer-registry.md), [DR-0009](../../decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0011](../../decisions/0011-subtractive-fork-vscode-jupyter.md), [DR-0012](../../decisions/0012-llmkernel-sole-kernel.md)
**Related atoms**: [family-a-otlp-spans](family-a-otlp-spans.md), [family-b-layout](family-b-layout.md), [family-c-agent-graph](family-c-agent-graph.md), [family-d-event-log](family-d-event-log.md), [family-e-heartbeat](family-e-heartbeat.md), [family-f-notebook-metadata](family-f-notebook-metadata.md), [submit-intent-envelope](submit-intent-envelope.md), [operator-action](operator-action.md)

## Definition

LLMKernel's wire format ([RFC-006](../../rfcs/RFC-006-kernel-extension-wire-format.md) Families A-F) is **structurally isomorphic** to Jupyter's kernel messaging protocol. We didn't reject Jupyter's architecture; we shipped a cousin protocol that lives at a different layer of abstraction (multi-agent semantic evaluator instead of single-language code evaluator) but rides on the same socket shape and inherits the same MIME-typed display channel. [Family A](family-a-otlp-spans.md) explicitly carries OTLP spans inside Jupyter `display_data` / `update_display_data` messages on IOPub. The other families ride on the Comm extension channel (`comm_open` / `comm_msg` / `comm_close`), which Jupyter provides specifically for kernel-defined protocols outside the core lifecycle.

This atom makes the mapping explicit so future bridging decisions (transcoder shim, ZMQ co-resident transport, picker re-enable) can be reasoned about against a single reference.

## Socket-level mapping

Jupyter ships 5 ZMQ sockets defined by a connection file:

| Jupyter socket | ZMQ pattern | Direction | Role | LLMKernel equivalent |
|---|---|---|---|---|
| **Shell** | REQ/REP | client → kernel | Commands, one reply per request | [submit-intent-envelope](submit-intent-envelope.md) (BSP-003) — every state mutation queues here; `intent_id` is the request key, `applied/already_applied` is the reply |
| **IOPub** | PUB/SUB | kernel → all clients (broadcast) | Streaming output + status | [family-a-otlp-spans](family-a-otlp-spans.md) literally rides this. [family-b-layout](family-b-layout.md), [family-d-event-log](family-d-event-log.md) ride IOPub via `comm_msg` |
| **Stdin** | REQ/REP | kernel → originating client | Kernel asks operator a question mid-execution | [operator-action](operator-action.md) approval flow — RFC-001 `propose_edit` / `present.artifact` are kernel-initiated questions |
| **Control** | REQ/REP | client → kernel | Out-of-band, processed even when busy | S9 interrupt envelope; lifecycle envelopes (`shutdown`, `interrupt`) ride RFC-006 Family D as `action_type: "kernel_control"` |
| **Heartbeat** | REQ/REP | client ↔ kernel | Liveness echo, bare bytes | [family-e-heartbeat](family-e-heartbeat.md) — same shape verbatim |

## Message-type mapping

| Jupyter message | LLMKernel equivalent | Notes |
|---|---|---|
| `execute_request` (Shell) | `submit_intent` with `intent_kind: <verb>` | Jupyter says "execute this code"; we say "execute this typed mutation" |
| `execute_reply` (Shell) | `intent_applied` response with `applied`, `snapshot_version`, optional `error_code` | Same request/reply shape |
| `execute_input` (IOPub) | Family A span with `name: "operator_input"` (when shipped) | Echoes the executing input to all clients |
| `execute_result` (IOPub) | Family A span with `endTimeUnixNano` set, `status.code: STATUS_CODE_OK` | Terminal-success output |
| `error` (IOPub) | Family A span with `status.code: STATUS_CODE_ERROR`, `status.message: <K-class code>` | K-codes from RFC-006 §"Failure modes" |
| `stream` (IOPub) | Family A span with `name: "agent_emit"`, `events[]` carrying chunks | We use OTLP events for streaming chunks rather than separate stream messages |
| `display_data` / `update_display_data` (IOPub) | **Same Jupyter messages** — Family A directly rides them | `display_id` MUST equal OTLP `spanId` per [family-a-otlp-spans](family-a-otlp-spans.md) |
| `status` (IOPub) | Family A span attribute `llmnb.kernel_status` (when shipped) | Jupyter's busy/idle/starting; we add `agent_status` per agent |
| `kernel_info_request/reply` (Shell) | **Missing** — would return `{language: "llmnb", language_version: "1.0", agents: [{id, provider, model}]}` |
| `is_complete_request/reply` (Shell) | **Missing** — directives are single-line in V1 so this is a no-op-able stub |
| `complete_request/reply` (Shell) | **Missing** — would back operator-side autocomplete on directive grammar (`/spawn`, `@<agent>`) |
| `inspect_request/reply` (Shell) | **Missing** — would back hover-info on cells/agents |
| `history_request/reply` (Shell) | superseded by [turn](../concepts/turn.md) DAG + [run-frame](../concepts/run-frame.md) records | Our model is richer than Jupyter's flat exec history |
| `comm_open` / `comm_msg` / `comm_close` (Shell + IOPub) | RFC-006 Family B–F all ride `comm_msg` with target name `llmnb.rts.v2` | Comm IS the extension hook; we use it as designed |
| `shutdown_request/reply` (Control) | Lifecycle envelope (`action_type: "kernel_shutdown"`) | Same shape |
| `interrupt_request` (Control) | S9 interrupt envelope (`action_type: "agent_interrupt"`) | Per-agent rather than whole-kernel |
| `debug_request` (Control) | **Out of scope** — V2+ Inspect mode is the closest analog | |

## Connection-file / launch ceremony

| Jupyter | LLMKernel |
|---|---|
| Client writes `connection_file.json` with 5 ports + transport + signature key | [contracts/kernel-client](../contracts/kernel-client.md) launches via PTY+socket per [RFC-008](../../rfcs/RFC-008-kernel-host-integration.md); our "connection file" is the PTY pair + the data-plane socket pair |
| HMAC signing on every message | [PLAN-S5.0.1](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md) HMAC for cell-magic dispatch (commit `88ffb15`); broader message HMAC is **not** in the wire today |
| Kernel binary launched with `-f <connection_file>` | LLMKernel launched via `python -m llmkernel` per pixi env discovery ([RFC-009 §4.2](../../rfcs/RFC-009-zone-control-and-config.md)) |

## What LLMKernel adds that Jupyter doesn't have

Documented as [concepts](../concepts/) atoms; collected here for the cross-protocol view:

- **Multi-agent in one kernel** — [agent](../concepts/agent.md), [contracts/agent-supervisor](../contracts/agent-supervisor.md). Jupyter is one-language-process; we multiplex N stateful Claude processes.
- **Conversation graph as first-class state** — [turn](../concepts/turn.md) DAG + agent refs. Jupyter sessions are flat exec logs.
- **Overlay graph for operator edits** — [overlay-commit](../concepts/overlay-commit.md). Jupyter has no concept of "edit a previous output without re-running."
- **Structured execution records** — [run-frame](../concepts/run-frame.md) + [context-manifest](../concepts/context-manifest.md). Inspect mode answers "what did the agent see + what changed." Jupyter has cell stdout/stderr only.
- **Intent-typed mutation registry** — [submit-intent-envelope](submit-intent-envelope.md). Every state change goes through a typed verb; Jupyter mutates state by side effect of code execution.
- **Section-status interruptibility lock** — [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md). Group-level execution gate; Jupyter has cell-level only.

## What Jupyter has that LLMKernel doesn't

- **Multi-client attach** — JupyterLab + classic notebook + jupyter console can all attach to one kernel simultaneously, sharing IOPub. Our wire is single-extension-attached.
- **`comm` extensibility used by third parties** — IPyWidgets, ipydatagrid, etc. all ride `comm_msg`. We use the same channel for our internal Family B–F but no third-party extension hook.
- **Standard introspection** — `is_complete_request`, `complete_request`, `inspect_request`. Useful for in-cell autocomplete on directive grammar; we don't have it yet.
- **Battle-tested ZMQ transport** — ROUTER/DEALER, signature verification, message framing. Our PTY+socket transport reinvents these primitives.
- **Cross-language polyglot via kernelspec** — explicitly cut by [DR-0012](../../decisions/0012-llmkernel-sole-kernel.md).

## Bridging options (no decision yet)

The mapping above means a Jupyter↔LLMKernel bridge is mostly transcoding, not new behavior. Four concrete shapes (revised wall-clock estimates per current velocity):

| Option | What | Wall-clock | Reverses |
|---|---|---|---|
| **L1 — kernelspec descriptor only** | Write `kernel.json` at standard path. External tools see LLMKernel exists. | ~30 min | Nothing |
| **L2 — `metadata.kernelspec` in `.llmnb`** | Files self-declare; tools route correctly. | ~1h | Nothing (additive) |
| **L3 — transcoder shim** (separate process) | `llmnb-jupyter-adapter` daemon bridges ZMQ ↔ our wire. | ~3-5h | Nothing in core |
| **L3-co-resident — dual transport in LLMKernel** | LLMKernel binds both ours AND ZMQ. | ~5-7h | DR-0009 (two protocols in core) |
| **L4 — replace our wire with ZMQ + JSON** | Drop Family A-F as concepts; map all to Jupyter's 5 sockets. | ~13-19h | RFC-006 supersession; large unwind |
| **L5 — re-enable picker UI in fork** | Restore kernel-discovery + picker. | ~2-3h | DR-0012 |

L1 + L2 are pure additive metadata moves and don't reverse any LOCK-IN ADR. L3 / L4 / L5 each require their own decision atom before landing.

## V1 vs V2+

- **V1**: structural isomorphism is documented (this atom); Family A actively uses Jupyter `display_data`; B-F use `comm_msg`. No external Jupyter clients can attach. No kernelspec on disk.
- **V2+**: candidate path is **L3 transcoder shim** — keeps RFC-006 normative for our editor, lets external Jupyter clients attach via the adapter. Decision deferred until V1 ships.

## See also

- [DR-0009](../../decisions/0009-notebook-controller-no-jupyter-kernel.md) — the lock-in that this atom documents the boundary of.
- [DR-0011](../../decisions/0011-subtractive-fork-vscode-jupyter.md) — what was cut from vscode-jupyter; informs L5 cost.
- [DR-0012](../../decisions/0012-llmkernel-sole-kernel.md) — single-kernel hardcode; reversed by L5.
- [family-a-otlp-spans](family-a-otlp-spans.md) — the one family that already explicitly rides Jupyter IOPub.
- [submit-intent-envelope](submit-intent-envelope.md) — Shell-equivalent request/reply.
- [family-e-heartbeat](family-e-heartbeat.md) — the one family that's identical to Jupyter's.
