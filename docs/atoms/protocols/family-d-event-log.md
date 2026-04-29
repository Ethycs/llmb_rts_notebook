# Protocol: Family D — Operator action

**Status**: `protocol` (V1 shipped, RFC-006 v2.0.3)
**Family**: RFC-006 Family D (operator event stream)
**Direction**: extension → kernel (one-way; kernel emits downstream effects as Families A / B / F)
**Source specs**: [RFC-006 §6](../../rfcs/RFC-006-kernel-extension-wire-format.md#6--family-d-operator-action), [BSP-002 §9](../../notebook/BSP-002-conversation-graph.md#9-implementation-slices) (action_types), [BSP-003 §3](../../notebook/BSP-003-writer-registry.md#3-the-intent-envelope) (intent envelope rides this family)
**Related atoms**: [protocols/operator-action](operator-action.md), [protocols/submit-intent-envelope](submit-intent-envelope.md), [contracts/messaging-router](../contracts/messaging-router.md), [operations/spawn-agent](../operations/spawn-agent.md)

## Definition

Family D is the **operator-action wire**: every UI-originated event the kernel needs to react to (cell directives parsed in the extension, branch switches, zone selects, approval responses, drift acknowledgments, intent envelopes) ships as one `operator.action` Comm message from the extension to the kernel. The kernel applies effects (mutate state, resume paused tool calls, dispatch re-execution) and emits downstream messages as needed; **there is no direct acknowledgment** — the downstream effects ARE the acknowledgment.

## Wire shape

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type":           "cell_edit | branch_switch | zone_select | approval_response | dismiss_notification | drift_acknowledged | agent_spawn | zone_mutate",
    "parameters":            { /* per action_type */ },
    "originating_cell_id":   "vscode-notebook-cell:.../#abc"
  }
}
```

`action_type` values (RFC-006 §6 + amendments):

| `action_type`           | Added in | Purpose |
|---|---|---|
| `cell_edit`             | v2.0.0   | Cell content edited; kernel updates render-time cache. |
| `branch_switch`         | v2.0.0   | Operator switched the rendered branch (V2+ UX). |
| `zone_select`           | v2.0.0   | Active zone changed in the workspace. |
| `approval_response`     | v2.0.0   | Operator clicked Approve/Deny on a `request_approval` card. |
| `dismiss_notification`  | v2.0.0   | Operator dismissed a kernel-side notification. |
| `drift_acknowledged`    | v2.0.0   | Operator confirmed a `drift_log` event from RFC-005. |
| `agent_spawn`           | v2.0.3   | Parsed `/spawn <agent_id> task:"..."` cell directive. |
| `zone_mutate`           | v2.0.0   | BSP-003 [intent envelope](submit-intent-envelope.md) carrier. |

## Schema-version handshake

Comm target name `llmnb.rts.v2`. New `action_type` values are minor-bump additive (RFC-006 §"Backward-compatibility analysis"). Receivers MUST tolerate unknown values from forward-version producers (W4 log + discard).

## Error envelope

There is no in-band response on Family D. Failure modes:

- **Unknown `action_type`** — W4 log + discard.
- **Validation failure on `parameters`** — kernel logs a `wire-failure` LogRecord; for `zone_mutate` (intent envelope), the writer returns a structured K40/K41/K42/K43 result over RFC-008's data plane (per BSP-003 §8), but Family D itself is fire-and-forget at the wire level.
- **Operator surface** — kernel-detected failures (e.g., `agent_spawn` for a duplicate id) may ship back as RFC-006 LogRecord events or as a follow-up Family F snapshot showing the unchanged state.

## V1 vs V2+

- **V1**: thirteen action types (table above); wire-side fire-and-forget.
- **V2+**: typed `action_response` envelope for cases where the operator-facing UI needs synchronous confirmation (approval cards already handle this via `approval_response`; the V2 extension may unify this).

## See also

- [protocols/operator-action](operator-action.md) — the outer envelope schema atom (this atom describes the family / channel; the operator-action atom describes the envelope shape detail).
- [protocols/submit-intent-envelope](submit-intent-envelope.md) — the BSP-003 intent shape inside `action_type: "zone_mutate"`.
- [operations/spawn-agent](../operations/spawn-agent.md) — `action_type: "agent_spawn"` is its wire form.
- [contracts/messaging-router](../contracts/messaging-router.md) — extension-side enqueue path for outbound operator actions.
- [contracts/intent-dispatcher](../contracts/intent-dispatcher.md) — kernel side that applies `zone_mutate` actions.
