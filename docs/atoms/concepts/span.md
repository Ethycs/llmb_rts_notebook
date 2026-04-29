# Span

**Status**: V1 shipped (OTLP/JSON over Family A; `llmnb.output.kind` situational attribute is V1 tag, V2 lens)
**Source specs**: [BSP-002 §2.1](../../notebook/BSP-002-conversation-graph.md#21-turn) (turns carry spans[]), [BSP-002 §13.4.1](../../notebook/BSP-002-conversation-graph.md#1341-rule--agent-initiated-tool-calls), [RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md) (Family A wire)
**Related atoms**: [turn](turn.md), [tool-call](tool-call.md), [output-kind](output-kind.md), [cell](cell.md)

## Definition

A **span** is one OTLP/JSON span living inside a [turn's](turn.md) `spans[]` array. Spans are the granular execution unit: per-kind (`text`, `agent_emit`, `tool_use`, `tool_result`, `system_message`, `result`), self-describing (`traceId`, `spanId`, `name`, `kind`, `startTimeUnixNano`, `endTimeUnixNano`, `status`, `attributes`, `events`, `links`), and addressable for operations like [split-cell](../operations/split-cell.md) and [promote-span](../operations/promote-span.md). The span is what crosses the kernel↔extension wire on Family A — Jupyter `display_data` / `update_display_data` over IOPub, MIME `application/vnd.rts.run+json`, with `display_id == spanId`.

## Span kinds (carried inside one turn)

| Span name | Role |
|---|---|
| `text` / `agent_emit` | Raw agent prose / reasoning that did not route through a structured tool call. Emitted for every byte of agent output that bypasses structured channels. |
| `tool_use` | The agent invoking a registered tool/device. The tool method name appears as `attributes["llmnb.tool_name"]`. |
| `tool_result` | The tool's response to a `tool_use` span; linked to the use via OTLP `links[]`. |
| `system_message` | Kernel- or system-injected context (e.g., cross-agent handoff content per [BSP-002 §4.6](../../notebook/BSP-002-conversation-graph.md#46-cross-agent-context-handoff)). |
| `result` | Terminal span for the agent turn (formerly `report_completion`). |

These kinds are not a closed enum at the wire level — they are span `name` values. They drive split-boundary rules (decision S1: split allowed between spans, allowed inside text/prose at character offset, FORBIDDEN inside `tool_use`/`tool_result`/`system_message`/`result`).

## Schema (subset — see RFC-006 §1 for the full OTLP)

```jsonc
{
  "name": "agent_emit | tool_use | tool_result | system_message | result | ...",
  "spanId": "16-hex",                          // doubles as Jupyter display_id
  "traceId": "32-hex",
  "kind": "SPAN_KIND_INTERNAL",
  "startTimeUnixNano": "...",
  "endTimeUnixNano":   "...",
  "status": { "code": "STATUS_CODE_OK | STATUS_CODE_ERROR | STATUS_CODE_UNSET" },
  "attributes": {
    // Mandatory per RFC-006 §1
    "llmnb.run_type":  "tool_call | agent_emit | ...",
    "llmnb.agent_id":  "alpha",
    // Situational
    "llmnb.zone_id":   "...",
    "llmnb.cell_id":   "vscode-notebook-cell:.../#def",
    "llmnb.tool_name": "read_file",
    // Issue 2 additive
    "llmnb.section_id":  "sec_...",
    "llmnb.output.kind": "prose | code | diff | ..."   // see output-kind atom
  },
  "events": [...],
  "links":  [...]
}
```

## Invariants

- **Spans are owned by their parent [turn](turn.md).** They live at `turns[N].spans[]`. They are NOT separate turns and NOT separate cells in V1.
- **Self-describing on the wire.** No envelope. The OTLP shape IS the contract ([RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md)). `display_id == spanId` is the routing key.
- **Last-writer-wins state machine.** Each `update_display_data` re-emission is the authoritative current state of the span. Receivers MUST NOT merge events across emissions; the kernel emits the full `events[]` each time.
- **Atomic at the kind level for split.** [split-cell](../operations/split-cell.md) is span-aware (decision S1): split between spans is allowed; split inside `text` / `agent_emit` at a character offset is allowed (the overlay records the offset); split inside `tool_use` / `tool_result` / `system_message` / `result` is FORBIDDEN. K94.
- **`output.kind` is V1 tag, V2 lens.** Output spans SHOULD carry [`llmnb.output.kind`](output-kind.md) so V2 lenses ("show decisions only") can filter; V1 ships only the tag.
- **Promotable.** [promote-span](../operations/promote-span.md) lifts a span into an addressable cell (decision D7: kind inferred from span type).

## V1 vs V2+

- **V1**: span shape on the wire, `llmnb.output.kind` and `llmnb.section_id` as additive optional attributes; no lens UI; promotion target cell-kind inferred per decision D7.
- **V2+**: lens UI filters spans by `llmnb.output.kind`; promotion may take an explicit kind override; rich span-level provenance UI in Inspect mode.

## See also

- [turn](turn.md) — the owner of `spans[]`.
- [tool-call](tool-call.md) — what `tool_use` / `tool_result` spans represent.
- [output-kind](output-kind.md) — the typed-output enum carried as a span attribute.
- [operations/split-cell](../operations/split-cell.md) — uses span boundaries (decision S1).
- [operations/promote-span](../operations/promote-span.md) — lifts a span into a cell (decision D7).
