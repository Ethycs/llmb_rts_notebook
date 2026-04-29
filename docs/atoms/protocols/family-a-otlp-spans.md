# Protocol: Family A — OTLP spans on cell outputs

**Status**: `protocol` (V1 shipped, RFC-006 v2.0.4)
**Family**: RFC-006 Family A (run lifecycle)
**Direction**: kernel → extension (one-way; IOPub is one-way)
**Source specs**: [RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md#1--family-a-run-lifecycle-otlpjson-over-iopub), [RFC-005 §`metadata.rts.event_log`](../../rfcs/RFC-005-llmnb-file-format.md#metadatartsevent_log--chat-flow), [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses)
**Related atoms**: [span](../concepts/span.md), [run-frame](../concepts/run-frame.md), [output-kind](../concepts/output-kind.md), [contracts/agent-supervisor](../contracts/agent-supervisor.md), [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md)

## Definition

Family A is the run-lifecycle wire: every cell run, tool call, LLM call, and `agent_emit` is a single OTLP/JSON [span](../concepts/span.md) carried as a Jupyter `display_data` (open) and `update_display_data` (advance/close) message on the IOPub channel. **There is no envelope** — the span is self-describing. The `display_id` MUST equal the OTLP `spanId` (16 lowercase hex chars), so every emission for one run resolves to the same cell output region.

## Carrier and shape

Carrier: Jupyter `display_data` / `update_display_data` over IOPub. MIME type: `application/vnd.rts.run+json`. Payload is exactly one OTLP/JSON span (RFC-005 §`event_log`).

```jsonc
// display_data.content.data["application/vnd.rts.run+json"]
{
  "traceId":            "5d27f5dd26ce4d619dbb9fbf36d2fe2b",  // 32 hex
  "spanId":             "8a3c1a2e9d774f0a",                  // 16 hex; == display_id
  "parentSpanId":       null,
  "name":               "notify",
  "kind":               "SPAN_KIND_INTERNAL",
  "startTimeUnixNano":  "1745588938412000000",
  "endTimeUnixNano":    null,                                  // null while open
  "status": { "code": "STATUS_CODE_UNSET", "message": "" },
  "attributes": [
    { "key": "llmnb.run_type", "value": { "stringValue": "tool" } },
    { "key": "llmnb.agent_id", "value": { "stringValue": "alpha" } },
    { "key": "llmnb.zone_id",  "value": { "stringValue": "..." } },
    // Situational (v2.0.4):
    { "key": "llmnb.section_id",   "value": { "stringValue": "sec_..." } },
    { "key": "llmnb.output.kind",  "value": { "stringValue": "prose" } }
  ],
  "events": [],
  "links":  []
}
```

## State machine

```
display_data        → span open: endTimeUnixNano=null, status=UNSET
update_display_data → same span re-emitted, events appended, attributes added
update_display_data → terminal: endTimeUnixNano set, status != UNSET
```

Receivers MUST treat each emission as the authoritative current state (last writer wins). Receivers MUST NOT merge events across emissions — the kernel emits the full `events[]` each time.

## Mandatory attributes

`llmnb.run_type`, `llmnb.agent_id`. Situational: `llmnb.zone_id`, `llmnb.cell_id`, `llmnb.tool_name`, `llmnb.section_id` (v2.0.4), `llmnb.output.kind` (v2.0.4 — see [output-kind](../concepts/output-kind.md)). LLM and tool runs SHOULD use OTel GenAI / OpenInference attributes per RFC-005.

## Schema-version handshake

The OTLP shape itself is the contract for Family A. There is no per-message version field. Major-version handshake happens via the Comm target name (`llmnb.rts.v2`) for Families B–F; Family A inherits major version from the same channel pair.

## Error envelope

There is no error envelope on Family A — wire failures surface as RFC-006 §"Failure modes" rows W2 (malformed OTLP), W3 (update with no opening), W10 (dual-MIME divergence). Each is "log + discard." Span-level errors are encoded inside `status.code = STATUS_CODE_ERROR` with `status.message`.

## Round-trip with persistence

Every closed Family A span MUST appear byte-identical (modulo JSON serialization noise) in the [Family F](family-f-notebook-metadata.md) `metadata.rts.event_log.runs[]` snapshot when the span first closes. This is RFC-006 §9 cross-family invariant "Run-record integrity" and is the seam between wire and disk.

## V1 vs V2+

- **V1** (v2.0.0–v2.0.4): single MIME `application/vnd.rts.run+json`; producers MAY also emit the deprecated `application/vnd.rts.envelope+json` during the transition window (consumers dispatch on the OTLP MIME first per W10). The dual emission MUST be removed by v2.1.
- **V2+**: dual emission removed; new optional attributes added additively (RFC-006 §"Backward-compatibility analysis" minor-bump rules).

## See also

- [span](../concepts/span.md) — the data shape this protocol carries.
- [output-kind](../concepts/output-kind.md) — V1 ships the `llmnb.output.kind` attribute; V2 ships the lens UI.
- [contracts/agent-supervisor](../contracts/agent-supervisor.md) — emits `agent_emit` Family A spans for any agent output bypassing structured channels.
- [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md) — paired persistence path; closed spans round-trip to `event_log.runs[]`.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — tool calls live as Family A spans on the parent turn, not as separate cells.
