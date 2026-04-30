# Protocol: operator.action envelope

**Status**: `protocol` (V1 shipped; envelopes now sourced from cell-magic parser dispatch, S5.0 commit `336a6c7` / submodule `e6620db`)
**Family**: RFC-006 Family D outer envelope
**Direction**: extension → kernel
**Source specs**: [BSP-002 §9](../../notebook/BSP-002-conversation-graph.md#9-implementation-slices) (action_type registry), [RFC-006 §6](../../rfcs/RFC-006-kernel-extension-wire-format.md#6--family-d-operator-action), [BSP-003 §3](../../notebook/BSP-003-writer-registry.md#3-the-intent-envelope) (intent envelope rides this shape), [PLAN-S5.0-cell-magic-vocabulary.md §3.6](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#36-extension-cell-directive-parser--extensionsrcnotebookcell-directivets-modest) (extension cell-magic dispatcher)
**Related atoms**: [protocols/family-d-event-log](family-d-event-log.md), [protocols/submit-intent-envelope](submit-intent-envelope.md), [concepts/magic](../concepts/magic.md), [operations/spawn-agent](../operations/spawn-agent.md), [contracts/intent-dispatcher](../contracts/intent-dispatcher.md)

## Definition

The `operator.action` envelope is the **outer wire shape** every operator-originated event uses to reach the kernel. It is the only Family D message type — the family is functionally one channel with `action_type` as the discriminator. BSP-002 §9 originally defined the action types for cell directives (`agent_continue`, `agent_branch`, `agent_revert`, `agent_stop`); BSP-003 §3 added `zone_mutate` to carry intent envelopes; v2.0.0 onward added drift/approval/notification action types; v2.0.3 added `agent_spawn`.

## Source: cell-magic parser dispatch (S5.0)

Per [PLAN-S5.0 §3.6](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#36-extension-cell-directive-parser--extensionsrcnotebookcell-directivets-modest), the extension's `cell-directive.ts` produces these envelopes by dispatching the [magic](../concepts/magic.md) vocabulary:

| Cell text shape | Resulting `action_type` |
|---|---|
| `@@spawn <id> [args]` (or legacy `/spawn …`) | `agent_spawn` |
| `@@agent <id>` body (or legacy `@<id>: …`, or plain prose continuing the binding) | `agent_continue` (with inner `intent_kind: "send_user_turn"`) |
| `@<line_magic>` line (e.g. `@pin`, `@exclude`, `@mark scratch`) | `cell_edit` carrying the new canonical text |
| `@@endpoint <name> …` | `set_notebook_setting` for the endpoint registration |
| `@@break` line | NOT an envelope — consumed by [split-at-breaks](../operations/split-at-breaks.md) |

The wire shape itself is unchanged from BSP-002 §9 / RFC-006 §6 — magics map to existing `intent_kind`s where they exist, and to additive ones for new cell magics. The parser is the producer of the envelopes; the kernel-side `intent_kind` discriminator is the consumer.

## Schema

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type":         "agent_spawn | agent_continue | agent_branch | agent_revert | agent_stop | cell_edit | branch_switch | zone_select | approval_response | dismiss_notification | drift_acknowledged | zone_mutate",
    "intent_kind":         "<see submit-intent-envelope>",   // optional; ONLY when action_type == "zone_mutate"
    "parameters":          { /* per action_type */ },
    "originating_cell_id": "vscode-notebook-cell:.../#abc"
  }
}
```

## Action-type catalogue (V1)

| `action_type`             | `parameters` shape                                      | Source spec |
|---|---|---|
| `agent_spawn`             | `{agent_id, task, cell_id, provider?, model?}`          | BSP-002 §3, RFC-006 v2.0.3 |
| `agent_continue`          | `{agent_id, text, cell_id}` (with inner `intent_kind: "send_user_turn"`; S3 / commit `ac2bb4d`) | BSP-002 §3 |
| `agent_branch`            | `{source_agent, at_turn_id?, new_agent_id, cell_id}`    | BSP-002 §3 (V2 ship; data-model V1) |
| `agent_revert`            | `{agent_id, target_turn_id, cell_id}`                   | BSP-002 §3 (V2 ship; data-model V1) |
| `agent_stop`              | `{agent_id, cell_id}`                                   | BSP-002 §3 |
| `cell_edit`               | `{cell_id, text}`                                       | RFC-006 §6 v2.0.0 |
| `branch_switch`           | `{branch_ref, cell_id?}`                                | RFC-006 §6 v2.0.0 |
| `zone_select`             | `{zone_id}`                                             | RFC-006 §6 v2.0.0 |
| `approval_response`       | `{run_id, decision, modification?}`                     | RFC-001 §"Worked example" |
| `dismiss_notification`    | `{notification_id}`                                     | RFC-006 §6 v2.0.0 |
| `drift_acknowledged`      | `{field_path, detected_at}`                             | RFC-005 drift_log |
| `zone_mutate`             | `{intent_kind, parameters, intent_id, expected_snapshot_version?}` | BSP-003 §3 |

## Invariants

- **No synchronous response.** Family D is fire-and-forget; downstream effects (Family A spans, Family F snapshots) are the acknowledgment.
- **`intent_kind` is mutually exclusive with non-`zone_mutate` action types.** A producer MUST NOT mix the two.
- **`originating_cell_id` is operator-surface metadata** for routing UI feedback back to the right cell decoration; it is NOT a kernel-side keying field.
- **Unknown `action_type` values are W4** — log + discard. New values arrive via additive minor RFC-006 bumps; consumers MUST tolerate forward-version values.

## Schema-version handshake

Comm target name `llmnb.rts.v2`. Within v2.x, new `action_type` values are minor-bump additive (RFC-006 §"Backward-compatibility analysis"). The optional `_rfc_version` field on inner envelopes (e.g., RFC-001 tools) is independent and not present at this layer.

## Error envelope

No in-band error reply at this layer. Validation failure on `parameters`:

- For `zone_mutate`: BSP-003 K40 / K41 / K42 / K43 surfaces over the data plane (RFC-008) as a structured response keyed by `intent_id`.
- For other action types: kernel-side `wire-failure` LogRecord; for `agent_spawn` duplicate-id, the kernel's `AgentSupervisor.spawn(...)` is idempotent (returns the existing handle) — no failure visible to the operator.

## See also

- [protocols/family-d-event-log](family-d-event-log.md) — the family this envelope rides.
- [protocols/submit-intent-envelope](submit-intent-envelope.md) — the inner shape inside `action_type: "zone_mutate"`.
- [operations/spawn-agent](../operations/spawn-agent.md) — `action_type: "agent_spawn"`.
- [operations/continue-turn](../operations/continue-turn.md) — `action_type: "agent_continue"`.
- [contracts/intent-dispatcher](../contracts/intent-dispatcher.md) — kernel side that decodes `zone_mutate` payloads.
