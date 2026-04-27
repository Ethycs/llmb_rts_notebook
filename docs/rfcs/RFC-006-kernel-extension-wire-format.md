# RFC-006 — Kernel↔extension wire format (v2; supersedes RFC-003)

## Status

Draft. Date: 2026-04-26. Version: 2.0.0. Supersedes [RFC-003](RFC-003-custom-message-format.md) v1.0.0.

This RFC is the layer-6 (session) normative specification for every message that crosses the kernel↔extension boundary in V1, beyond the standard MCP-shaped tool calls. It supersedes RFC-003 v1.0.0 in full. RFC-003 remains in the docket marked Superseded for historical reference; conforming V1 implementations attach to **this** document.

## Source ADRs and prior RFCs

- [DR-0009 — VS Code NotebookController API; no Jupyter kernel](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- [DR-0014 — three storage structures embedded in one .llmnb file](../decisions/0014-three-storage-structures-embedded.md)
- [DR-0015 — bidirectional kernel-extension MCP](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- [DR-0016 — RFC-driven standards discipline](../decisions/0016-rfc-standards-discipline.md)
- [RFC-003](RFC-003-custom-message-format.md) — superseded; this RFC replaces it.
- [RFC-005](RFC-005-llmnb-file-format.md) — persistent counterpart; the wire ships what RFC-005 stores.

## Why supersede instead of amend

RFC-003 v1.0.0 designed a uniform envelope (`{message_type, direction, correlation_id, timestamp, rfc_version, payload}`) for every cross-boundary message, including run-lifecycle records (Family A). After adopting strict OTLP/JSON for run records (per RFC-005), Family A's envelope became redundant: every envelope field had a span-level equivalent (`spanId` ≡ `correlation_id`, `startTimeUnixNano` ≡ `timestamp`, the MIME type ≡ `message_type`, IOPub direction is implicit). Continuing to wrap OTLP spans in a custom envelope adds noise without information.

This RFC takes the V1 step the supersession allows:

1. **Run lifecycle uses OTel's own wire form** over Jupyter `display_data` + `update_display_data`. No envelope. The OTLP span is self-describing.
2. **Non-run families keep an envelope but a thinner one** (drops `direction`, `timestamp`, `rfc_version` — see §3).
3. **A new family — `notebook.metadata` (Family F)** — carries `metadata.rts` snapshots from kernel to extension per RFC-005 §"Persistence strategy."

The result is a smaller, cleaner spec with the same expressive power, plus the persistence channel that RFC-005 needs.

## Architecture: two carriers

| Carrier | Used for | Why this carrier |
|---|---|---|
| Jupyter `display_data` / `update_display_data` over IOPub | Run lifecycle (Family A) | Cells already host run records as outputs; `display_id` is the natural per-run routing key; OTel streaming maps onto it directly. |
| Jupyter `comm_msg` over Comm at target `llmnb.rts.v2` | Non-run families (B–F) | These messages are not naturally cell outputs (layout state, agent-graph queries, operator actions, heartbeats, persistence snapshots). The Comm channel is the standard Jupyter primitive for typed bidirectional infrastructure traffic. |

A receiver MUST dispatch on the carrier first, then on the message-specific identifier inside it (MIME type for the IOPub carrier, `type` field for the Comm carrier).

## Specification

### §1 — Family A: Run lifecycle (OTLP/JSON over IOPub)

#### Carrier

- Jupyter `display_data` (opens) and `update_display_data` (advances/closes) on the IOPub channel.
- The Jupyter `display_id` MUST equal the OTLP `spanId` (16 lowercase hex chars).

#### Payload

A `display_data` / `update_display_data` message carries one MIME-typed payload of type `application/vnd.rts.run+json` whose value is exactly one OTLP/JSON span as specified in [RFC-005 §`metadata.rts.event_log`](RFC-005-llmnb-file-format.md#metadatartsevent_log--chat-flow). The span is self-describing: `traceId`, `spanId`, `name`, `kind`, `startTimeUnixNano`, `endTimeUnixNano`, `status`, `attributes`, `events`, `links`. There is **no envelope** wrapping the span at this layer.

#### State machine

```
display_data         ──►  span open, endTimeUnixNano: null,
                          status.code: STATUS_CODE_UNSET
update_display_data  ──►  same span re-emitted, with new events appended
                          and/or attributes added
update_display_data  ──►  same span re-emitted, this time closed:
                          endTimeUnixNano set, status.code != STATUS_CODE_UNSET
```

The receiver MUST treat each emission as the authoritative current state of the span (last writer wins). Receivers MUST NOT attempt to merge events from successive emissions — the kernel emits the full `events[]` array each time.

#### Mandatory attributes

Every Family A span MUST carry the attributes specified in [RFC-005 §"Mandatory attributes per run"](RFC-005-llmnb-file-format.md#mandatory-attributes-per-run): `llmnb.run_type`, `llmnb.agent_id`, plus the situational `llmnb.zone_id`, `llmnb.cell_id`, `llmnb.tool_name`. LLM and tool runs SHOULD use OTel GenAI semconv and OpenInference attributes per RFC-005.

#### `agent_emit` over Family A

[RFC-005 §"`agent_emit` runs"](RFC-005-llmnb-file-format.md#agent_emit-runs--raw-agent-output) introduces a run type that captures raw agent output that did not route through a structured tool call. `agent_emit` spans use the Family A wire unchanged — same MIME type, same `display_id == spanId` routing, same state machine. The kernel MUST emit an `agent_emit` span for every byte of agent output that bypasses structured channels (prose, reasoning, system messages, stderr, malformed tool-use blocks) so the operator surface preserves end-to-end observability of agent activity. Receivers dispatch on `attributes["llmnb.run_type"] == "agent_emit"` and the further `llmnb.emit_kind` value to pick the correct renderer component. Renderers SHOULD visually de-emphasize `agent_emit` content relative to tool calls per RFC-005's guidance, preserving the forced-tool-use UX while keeping the underlying agent output observable.

#### Why no envelope

The fields a custom envelope would carry are all already in the span:

| RFC-003 v1 envelope field | OTLP/JSON equivalent |
|---|---|
| `message_type: "run.start" / "run.event" / "run.complete"` | Inferred from `endTimeUnixNano` (`null` ⇒ open) and `status.code` (`STATUS_CODE_UNSET` ⇒ in progress). |
| `direction: "kernel→extension"` | Implicit. IOPub is one-way kernel→extension. |
| `correlation_id` | `spanId` (which is also the `display_id`). |
| `timestamp` | `startTimeUnixNano` (open) or `endTimeUnixNano` (close). |
| `rfc_version` | Encoded in the Comm target name (`llmnb.rts.v2`) for non-IOPub families; for runs, the OTLP shape itself is the contract. |
| `payload` | The span itself. |

Re-emitting these as envelope fields adds bytes and one more parser without adding capability. The supersession drops them.

#### Conformance during transition

To allow a graceful upgrade, V1 producers MAY ALSO emit `application/vnd.rts.envelope+json` alongside `application/vnd.rts.run+json` within the same `display_data` message during the transition window (this RFC's `2.0.x` line). Consumers MUST dispatch on `application/vnd.rts.run+json` first and ignore the envelope MIME if both are present. The dual emission is **deprecated** at v2.0 and MUST be removed by v2.1; producers SHOULD migrate to single-MIME emission as soon as their consumers conform.

### §2 — Comm channel: target name and lifecycle

The non-run families share one Jupyter Comm target: **`llmnb.rts.v2`**. The major version is part of the target name so that a major-version bump is a clean, observable break: a v3 kernel and a v2 extension fail to open a Comm together, and the failure is the upgrade prompt.

- The extension opens the Comm at session start; the kernel responds.
- The Comm stays open for the kernel's lifetime.
- All Family B–F messages (and their responses, when applicable) flow through this single Comm.

A V2 receiver MUST refuse to open a Comm whose target name does not exactly match `llmnb.rts.v2`. A v2.x ↔ v2.y interaction (same major) is permitted; minor versioning is communicated via per-message fields where needed (none in v2.0).

### §3 — Comm envelope (thin)

```json
{
  "type": "<family-specific message type>",
  "payload": { ... },
  "correlation_id": "<UUIDv4>"
}
```

Field semantics:

- `type` (string, required) — the message type identifier from §4–§9 below. Receivers MUST reject envelopes with unknown `type` values per the failure-mode table.
- `payload` (object, required) — the per-`type` schema (see §4–§9).
- `correlation_id` (string, optional) — UUIDv4. Required only for request/response pairs (`agent_graph.query` / `.response`). Other messages MAY include one for tracing but receivers MUST NOT depend on it for non-paired messages.

Fields removed compared to RFC-003 v1 envelope and the rationale:

- `direction` — redundant. Comm sender identity (kernel side / extension side) determines direction.
- `timestamp` — runs carry it inside the OTLP span; non-run families either don't need it (heartbeat carries `uptime_seconds`) or carry their own time fields in `payload`.
- `rfc_version` — encoded in the Comm target name. A target name mismatch IS the version-rejection mechanism.

The thinning saves bytes and parsing on every message and removes three sources of redundant validation logic.

### §4 — Family B: Layout

Two messages, identical payload schemas to RFC-003 v1 §Family B (the substance of the layout protocol did not change; only the envelope did). Both travel over the Comm.

#### `layout.update`

- *Direction:* kernel→extension.
- *Semantics:* authoritative full snapshot of the layout tree per [RFC-005 §`metadata.rts.layout`](RFC-005-llmnb-file-format.md#metadatartslayout--layout-tree).

```json
{
  "type": "layout.update",
  "payload": {
    "snapshot_version": 17,
    "tree": { /* same shape as metadata.rts.layout.tree */ }
  }
}
```

Receivers MUST replace their in-memory copy atomically.

#### `layout.edit`

- *Direction:* extension→kernel.
- *Semantics:* operator-driven UI mutation. Kernel applies, then echoes the new state via `layout.update`. Kernel MAY reject by emitting an unchanged `layout.update`.

```json
{
  "type": "layout.edit",
  "payload": {
    "operation": "add_zone | remove_node | move_node | rename_node | update_render_hints",
    "parameters": {
      "node_id": "...",
      "new_parent_id": "...",
      "new_name": "...",
      "render_hints": { ... },
      "node_spec": { ... }
    }
  }
}
```

V1 ships full snapshots; JSON-Patch wire encoding is reserved for V1.5 (per RFC-005 §"Open issues queued for amendment").

### §5 — Family C: Agent graph

Two messages forming a request/response pair via `correlation_id`. Payloads identical to RFC-003 v1 §Family C.

#### `agent_graph.query`

- *Direction:* extension→kernel.

```json
{
  "type": "agent_graph.query",
  "correlation_id": "<UUIDv4>",
  "payload": {
    "query_type": "neighbors | paths | subgraph | full_snapshot",
    "node_id": "...",
    "target_node_id": "...",
    "hops": 1-16,
    "edge_filters": ["spawned", "in_zone", "..."]
  }
}
```

#### `agent_graph.response`

- *Direction:* kernel→extension.
- *Semantics:* `correlation_id` MUST equal the originating query's.

```json
{
  "type": "agent_graph.response",
  "correlation_id": "<same as query>",
  "payload": {
    "nodes": [ ... ],
    "edges": [ ... ],
    "truncated": false
  }
}
```

Node and edge schemas are exactly the ones in [RFC-005 §`metadata.rts.agents`](RFC-005-llmnb-file-format.md#metadatartsagents--agent-state-graph).

### §6 — Family D: Operator action

One message, payload identical to RFC-003 v1 §Family D.

#### `operator.action`

- *Direction:* extension→kernel.
- *Semantics:* notify the kernel of an operator UI event. Kernel applies effects (mutate state, resume paused tool calls, dispatch re-execution) and emits downstream messages as needed. No direct acknowledgment; downstream effects ARE the acknowledgment.

```json
{
  "type": "operator.action",
  "payload": {
    "action_type": "cell_edit | branch_switch | zone_select | approval_response | dismiss_notification | drift_acknowledged",
    "parameters": { ... },
    "originating_cell_id": "..."
  }
}
```

`action_type` adds **`drift_acknowledged`** in v2 (the operator confirmed a drift event from RFC-005's drift log). Other values are unchanged from RFC-003 v1 §Family D.

### §7 — Family E: Heartbeat / liveness

Two messages, payloads identical to RFC-003 v1 §Family E.

#### `heartbeat.kernel`

- *Direction:* kernel→extension.
- *Cadence:* every 5 seconds.

```json
{
  "type": "heartbeat.kernel",
  "payload": {
    "kernel_state": "ok | degraded | starting | shutting_down",
    "uptime_seconds": 1834.21,
    "last_run_timestamp": "2026-04-26T14:32:18.611Z"
  }
}
```

#### `heartbeat.extension`

- *Direction:* extension→kernel.
- *Cadence:* every 5 seconds.

```json
{
  "type": "heartbeat.extension",
  "payload": {
    "extension_state": "ok | degraded | starting | shutting_down",
    "active_notebook_id": "session-2026-04-26.llmnb",
    "focused_cell_id": "cell-12"
  }
}
```

Receivers MUST surface a liveness warning when no heartbeat has been received from the peer for >30 seconds.

### §8 — Family F: Notebook metadata (NEW)

Family F is the persistence channel that [RFC-005 §"Persistence strategy"](RFC-005-llmnb-file-format.md#persistence-strategy-who-writes-the-file) requires. The kernel is the single logical writer of `metadata.rts`; this family is how the kernel ships its writes to the extension, which then applies them via `vscode.NotebookEdit.updateNotebookMetadata` and lets VS Code's normal save flow persist.

#### `notebook.metadata`

- *Direction:* kernel→extension.
- *Semantics:* deliver a snapshot or patch of the `metadata.rts` namespace. The extension applies it to the open notebook document; the next save flushes it to disk.

```json
{
  "type": "notebook.metadata",
  "payload": {
    "mode": "snapshot | patch",
    "snapshot_version": 42,
    "snapshot": { /* full metadata.rts contents per RFC-005 */ },
    "patch": [ /* JSON Patch operations (RFC 6902) — V1.5+ only */ ],
    "trigger": "save | shutdown | timer | end_of_run"
  }
}
```

Field semantics:

- `mode` (required) — `"snapshot"` carries `snapshot` and omits `patch`; `"patch"` carries `patch` and omits `snapshot`. V1 implementations MUST emit `"snapshot"` only. V1.5 introduces `"patch"`.
- `snapshot_version` (required) — monotonically increasing integer that survives across kernel restarts (persisted in `metadata.rts` and incremented on every emission). The extension uses it to detect missed updates and to refuse out-of-order applies.
- `snapshot` (object, required when `mode == "snapshot"`) — the full `metadata.rts` contents per RFC-005 v1.0.0. The schema is governed by RFC-005, not this RFC; this RFC only specifies that the field carries that schema verbatim.
- `patch` (array, required when `mode == "patch"`, V1.5+) — RFC 6902 operation list applied against the receiver's current `metadata.rts`.
- `trigger` (required) — what caused this emission, per RFC-005 §"Snapshot triggers." Receivers MUST tolerate unknown trigger values.

#### Cadence and triggers

The kernel emits `notebook.metadata` on the four triggers specified in RFC-005:

1. **operator save** — extension reports save event (over a future operator.action subtype, or via a synchronous request/response handshake — see §"Open issues" below).
2. **clean shutdown** — kernel pre-shutdown hook.
3. **periodic timer** — every 30 seconds while the file is dirty.
4. **end_of_run** — `event_log` gains a closed span.

#### Queue-overflow direct-write fallback

If no extension is attached when the kernel would otherwise emit `notebook.metadata`, the kernel queues per RFC-005's bounded queue policy (10 000 cap on event-log entries, last-writer-wins for layout/agents). On overflow, the kernel writes a checkpoint marker and direct-writes once. The direct-write path is OUT OF SCOPE for this RFC (it's a kernel-internal disk operation, not a wire message); RFC-005 §F13 is authoritative.

#### Schema governance split

This RFC governs the *transport* of `metadata.rts` (the envelope and Family F semantics). RFC-005 governs the *content* (the schema of `metadata.rts` itself). A V1 reader MUST validate the envelope per this RFC, then validate the inner snapshot per RFC-005's `schema_version`. Mismatched majors between the wire and the snapshot are a kernel bug; receivers MUST log and discard.

### §9 — Cross-family invariants

- **Run-record integrity.** Every span emitted via Family A IOPub MUST also appear in the `metadata.rts.event_log` snapshot delivered via Family F when that span first closes. Cell-output spans and event-log spans MUST be byte-identical to within JSON serialization noise.
- **Heartbeat-driven liveness gates Family F.** If the extension hasn't been seen for >30 seconds, the kernel pauses Family F emissions and switches to the queue. On extension reconnect, the kernel emits a single replay snapshot before resuming normal cadence.
- **Comm target version is the major-version handshake.** A v3 kernel SHALL register `llmnb.rts.v3`; a v2 extension SHALL NOT open a v3 Comm. Receivers MUST refuse to open Comms with mismatched major target names.

## Backward-compatibility analysis

RFC-006 is the **major-version successor** to RFC-003. The supersession is a hard break: a v2 implementation does NOT interoperate with a v1 implementation, and is not expected to.

Within v2.x, the same compatibility classes from RFC-003 §"Backward-compatibility analysis" apply:

- **Additive (v2 minor bump):** new optional fields in any payload schema; new `type` values; new `action_type` / `query_type` / etc. enum values; new attribute keys on Family A spans. Old receivers MUST ignore unknown fields and tolerate unknown enum values.
- **Deprecating (v2 minor bump):** mark obsolete with a `deprecated_in_version` note in this RFC. Producers continue to emit both the deprecated form and its replacement for at least one minor version. The dual emission of `application/vnd.rts.envelope+json` for runs (during the v1→v2 transition) is the first deprecation tracked under v2 and MUST be removed by v2.1.0.
- **Breaking (v3 major bump):** rename or remove a required field, type change, semantic redefinition, change to the Comm target name. Major bumps require a fresh RFC-NNN supersession (this RFC will then be the superseded one).

The supersession of RFC-003 by this RFC is itself a worked example of the major-bump class. RFC-003 stays in the docket marked Superseded. Loaders that encounter a v1 RFC-003 envelope on a v2 wire MUST log and discard.

## Failure modes

Each row describes a wire-level failure. RFC-005 covers persistence-level failures; RFC-004 covers cross-component fault injection that exercises both.

| # | Trigger | Recipient response | Recovery surface |
|---|---|---|---|
| W1 | Comm open fails (target name mismatch) | Receiver refuses, logs the observed name. | Operator-facing version-mismatch banner; upgrade prompt. |
| W2 | `display_data` arrives carrying a span with malformed OTLP/JSON (non-conformant attribute encoding, non-string nanos, etc.) | Discard the message. Log the malformed body's `display_id` (if extractable) for replay. | Producer bug; investigate via the failed-replay path in RFC-004. |
| W3 | `update_display_data` arrives for a `display_id` the receiver has never seen (no prior `display_data`) | Treat as opening a new span. Render in cell output if the cell context is recoverable. Log "synthesized open from update." | Common during reconnect after a brief disconnect; should self-heal. |
| W4 | Comm message has unknown `type` value | Log and discard. Future-message diagnostic captures the raw envelope. | Producer is ahead of receiver; receiver MAY surface an upgrade hint. |
| W5 | Comm message missing required field (`type` or `payload`) | Log and discard. If `correlation_id` is parseable, emit no response (request/response pairs will time out at the requester). | Sender bug; investigate. |
| W6 | `agent_graph.response` arrives with no matching `agent_graph.query` correlation_id | Log and discard. | Could indicate kernel reissued a stale response after extension cycled; benign. |
| W7 | `notebook.metadata` snapshot's `schema_version` major differs from receiver's RFC-005 implementation | Reject the snapshot, log the version pair, surface an upgrade banner. Kernel MUST stop emitting Family F until the operator resolves the mismatch. | Same surface as F1 from RFC-005. |
| W8 | `notebook.metadata` `snapshot_version` is non-monotonic (lower than the receiver's last-seen) | Log and discard. The receiver retains its current state. | Kernel bug; may indicate a clock-skew restart that didn't preserve the counter. |
| W9 | Heartbeat timeout (no peer heartbeat for >30s) | Per RFC-003 v1 §F7/F8 (semantics unchanged): surface a liveness warning to the operator; kernel switches to queueing for Family F; extension marks the kernel-state indicator as degraded. | Operator-facing surface. |
| W10 | Producer emits both v1 envelope MIME and v2 OTLP MIME on a `display_data` message but they describe different spans | Dispatch on the OTLP MIME (v2 takes precedence). Log the divergence for the producer to fix. | Producer bug during transition; fix before v2.1. |
| W11 | Comm message body exceeds receiver-side size limit (V1 default: 4 MiB) | Log and discard. Sender will time out for request/response pairs. | Indicates content that should have been blob-stored per RFC-005 (`config.kernel.blob_threshold_bytes` undertuned). |

## Worked example

A single tool call from the kernel's perspective, end-to-end through the wire.

**Step 1.** Agent invokes the `notify` MCP tool. Kernel allocates `traceId = "5d27f5dd26ce4d619dbb9fbf36d2fe2b"`, `spanId = "8a3c1a2e9d774f0a"`, opens the run.

Kernel emits `display_data` over IOPub:

```json
{
  "msg_type": "display_data",
  "content": {
    "data": {
      "application/vnd.rts.run+json": {
        "traceId": "5d27f5dd26ce4d619dbb9fbf36d2fe2b",
        "spanId":  "8a3c1a2e9d774f0a",
        "parentSpanId": null,
        "name": "notify",
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1745588938412000000",
        "endTimeUnixNano": null,
        "status": { "code": "STATUS_CODE_UNSET", "message": "" },
        "attributes": [
          { "key": "llmnb.run_type", "value": { "stringValue": "tool" } },
          { "key": "tool.name",      "value": { "stringValue": "notify" } },
          { "key": "llmnb.agent_id", "value": { "stringValue": "alpha" } },
          { "key": "input.value",    "value": { "stringValue": "{\"observation\":\"Extracted JWT validator\",\"importance\":\"info\"}" } },
          { "key": "input.mime_type", "value": { "stringValue": "application/json" } }
        ],
        "events": [],
        "links": []
      }
    },
    "metadata": {},
    "transient": { "display_id": "8a3c1a2e9d774f0a" }
  }
}
```

Extension renders the span in cell output via the run renderer; status indicator shows `running`.

**Step 2.** Tool result arrives. Kernel emits `update_display_data` with the closed span:

```json
{
  "msg_type": "update_display_data",
  "content": {
    "data": {
      "application/vnd.rts.run+json": {
        "traceId": "5d27f5dd26ce4d619dbb9fbf36d2fe2b",
        "spanId":  "8a3c1a2e9d774f0a",
        "parentSpanId": null,
        "name": "notify",
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1745588938412000000",
        "endTimeUnixNano":   "1745588938611000000",
        "status": { "code": "STATUS_CODE_OK", "message": "" },
        "attributes": [
          { "key": "llmnb.run_type", "value": { "stringValue": "tool" } },
          { "key": "tool.name",      "value": { "stringValue": "notify" } },
          { "key": "llmnb.agent_id", "value": { "stringValue": "alpha" } },
          { "key": "input.value",    "value": { "stringValue": "{\"observation\":\"Extracted JWT validator\",\"importance\":\"info\"}" } },
          { "key": "input.mime_type",  "value": { "stringValue": "application/json" } },
          { "key": "output.value",     "value": { "stringValue": "{\"acknowledged\":true}" } },
          { "key": "output.mime_type", "value": { "stringValue": "application/json" } }
        ],
        "events": [
          { "timeUnixNano": "1745588938503000000", "name": "tool_call",
            "attributes": [ { "key": "tool.name", "value": { "stringValue": "notify" } } ] },
          { "timeUnixNano": "1745588938567000000", "name": "tool_result",
            "attributes": [ { "key": "auto_completed", "value": { "boolValue": true } } ] }
        ],
        "links": []
      }
    },
    "metadata": {},
    "transient": { "display_id": "8a3c1a2e9d774f0a" }
  }
}
```

The MIME type, the `display_id`, and the span's `spanId` agree. The extension updates the cell's output in place; status indicator flips to `success`.

**Step 3.** Kernel's end-of-run trigger fires Family F. Over the Comm at `llmnb.rts.v2`:

```json
{
  "type": "notebook.metadata",
  "payload": {
    "mode": "snapshot",
    "snapshot_version": 42,
    "snapshot": {
      "schema_version": "1.0.0",
      "session_id": "9c1a3b2d-4e5f-4061-a072-8d9e3f4a5b6c",
      "event_log": {
        "version": 1,
        "runs": [
          { /* the closed notify span from Step 2, byte-identical */ }
        ]
      },
      "layout": { /* unchanged */ },
      "agents": { /* unchanged */ },
      "config": { /* unchanged */ },
      "blobs":  { /* unchanged */ },
      "drift_log": []
    },
    "trigger": "end_of_run"
  }
}
```

Extension applies the snapshot via `vscode.NotebookEdit.updateNotebookMetadata`. On the next save (operator save / 30s timer), VS Code persists the new `metadata.rts` to disk. The cell output already shows the closed run from Step 2; the persisted file now has the same span in `event_log.runs[]` for replay.

## Consumers

- **Kernel `custom_messages` dispatcher** — emits Family A on IOPub; emits Families B, F kernel→extension on the Comm; consumes Families B (edits), C (queries), D (actions), E (heartbeat) extension→kernel.
- **Kernel `metadata_writer` (new in V1)** — emits Family F per RFC-005's snapshot triggers.
- **Extension `messaging/router.ts`** — opens the `llmnb.rts.v2` Comm; dispatches inbound Comm messages on `type`; dispatches inbound IOPub `display_data` / `update_display_data` on MIME type; emits Families B (edits), C (queries), D (actions), E (heartbeat) over the Comm.
- **Extension `metadata-applier.ts` (new in V1)** — receives Family F and applies snapshots via `vscode.NotebookEdit.updateNotebookMetadata`.
- **Extension `notebook/jupyter-kernel-client.ts`** — receives IOPub `display_data` / `update_display_data` for Family A; routes to the run renderer.
- **Replay harness (RFC-004)** — replays IOPub `display_data` streams and Comm messages from a recorded transcript; the simpler v2 envelope reduces parser code.

## Open issues queued for amendment

| Issue | Surfaced by | Disposition |
|---|---|---|
| Family F `notebook.metadata` is fire-and-forget. Save events are not acknowledged. The kernel cannot tell whether the extension has received and applied a given `snapshot_version`. | Anticipated reliability work. | v2.1: introduce `notebook.metadata.ack` (extension→kernel) carrying the last applied `snapshot_version`. Kernel uses it to bound the queue more aggressively when the extension is keeping up. |
| The "operator save" trigger from RFC-005 needs a wire path. Currently Family D (`operator.action`) carries it via an `action_type: "save"` value. That conflates persistence intent with operator UI events. | RFC-005 §"Snapshot triggers." | v2.1 may add a dedicated `notebook.save_request` / `.save_complete` pair if the conflation produces ambiguity in practice. V2.0 ships with `operator.action.save` to keep the spec small. |
| Comm message size limit (V1: 4 MiB) is configuration, not protocol. Implementations could disagree on the cap. | F W11. | v2.1 may codify the cap and require receivers to advertise their limit on Comm open. |
| JSON Patch wire encoding for `notebook.metadata` (mode `"patch"`). | RFC-005 §"Open issues." | V1.5: ship the patch mode with a v2.1 minor bump and a `patch_format_version` field. |

## Source

- ADR: [DR-0009 — VS Code NotebookController API](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- ADR: [DR-0014 — three storage structures embedded](../decisions/0014-three-storage-structures-embedded.md)
- ADR: [DR-0015 — paper-telephone bidirectional MCP](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- ADR: [DR-0016 — RFC standards discipline](../decisions/0016-rfc-standards-discipline.md)
- Superseded RFC: [RFC-003 v1.0.0](RFC-003-custom-message-format.md)
- Sibling: [RFC-005 — `.llmnb` file format](RFC-005-llmnb-file-format.md) (the persistent counterpart of this wire)
- External: [opentelemetry-proto OTLP/JSON encoding](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md), [Jupyter messaging — display_data and update_display_data](https://jupyter-client.readthedocs.io/en/latest/messaging.html#display-data), [Jupyter messaging — comm messages](https://jupyter-client.readthedocs.io/en/latest/messaging.html#opening-a-comm)
