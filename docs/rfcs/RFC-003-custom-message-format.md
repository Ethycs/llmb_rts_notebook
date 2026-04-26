# RFC-003 — Custom Jupyter message format

## Status

- **Status:** Draft
- **Date:** 2026-04-25
- **Version:** 1.0.0
- **Source ADRs:** [DR-0009](../decisions/0009-notebook-controller-no-jupyter-kernel.md), [DR-0014](../decisions/0014-three-storage-structures-embedded.md), [DR-0015](../decisions/0015-kernel-extension-bidirectional-mcp.md)

## Context

Per [DR-0009](../decisions/0009-notebook-controller-no-jupyter-kernel.md), V1 keeps the Jupyter messaging vocabulary as the wire format between LLMKernel and the VS Code extension even though there is no Python kernel underneath. Per [DR-0015](../decisions/0015-kernel-extension-bidirectional-mcp.md), MCP carries tool-call traffic in both directions, but a residual class of cross-component messages does not fit the MCP tool-call shape: run-lifecycle records emitted by the run-tracker, layout-state mutations against the layout tree, agent-graph queries against the agent state graph, operator-action notifications about UI events that are not themselves tool calls, and bidirectional liveness heartbeats. These messages travel as Jupyter custom messages (`comm_msg` / `display_data` / `update_display_data`) rather than as MCP tool calls.

The kernel-extension boundary is the load-bearing interface for the entire paper-telephone topology. Two implementations (Python kernel, TypeScript extension) must share one wire vocabulary or every renderer drifts on inconsistent assumptions. The Bell-System discipline locked by [DR-0016](../decisions/0016-rfc-standards-discipline.md) requires that this vocabulary be specified normatively, version-numbered, and reviewed against an explicit backward-compatibility class system *before* either side implements it.

JSON-RPC over Jupyter messaging is the chosen carrier. Jupyter `display_data` and `update_display_data` already provide stable `display_id` semantics that the LangSmith POST/event/PATCH streaming model from [chapter 06](../dev-guide/06-vscode-notebook-substrate.md) maps onto cleanly: a `run.start` opens a display whose id is the `run_id`, subsequent `run.event` messages update that display, and a final `run.complete` closes it. The Jupyter `comm` machinery covers the non-cell-bound traffic (layout, agent graph, operator action, heartbeat) by carrying a typed JSON envelope.

Three storage structures from [DR-0014](../decisions/0014-three-storage-structures-embedded.md) — layout tree, agent graph, chat flow — each contribute one message family to this catalog. The chat flow contributes the run-lifecycle family; the layout tree contributes the layout family; the agent graph contributes the agent-graph query/response family. Operator action and heartbeat are runtime concerns that fall outside the persisted structures.

A typed catalog with one universal envelope is therefore mandatory: it gives both implementations a single dispatch point, enables additive evolution without breaking existing receivers, and makes the replay harness from [RFC-004](RFC-004-failure-mode-analysis.md) a JSON walker rather than a per-message-type parser.

## Specification

Every custom message that crosses the kernel-extension boundary, beyond standard MCP-shaped tool calls, MUST be wrapped in the **universal envelope** defined below. Receivers MUST validate the envelope before dispatching to a per-`message_type` handler.

### Envelope schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/envelope.json",
  "title": "RFC-003 Universal envelope",
  "type": "object",
  "required": ["message_type", "direction", "correlation_id", "timestamp", "rfc_version", "payload"],
  "additionalProperties": false,
  "properties": {
    "message_type": {
      "type": "string",
      "enum": [
        "run.start",
        "run.event",
        "run.complete",
        "layout.update",
        "layout.edit",
        "agent_graph.query",
        "agent_graph.response",
        "operator.action",
        "heartbeat.kernel",
        "heartbeat.extension"
      ]
    },
    "direction": {
      "type": "string",
      "enum": ["kernel→extension", "extension→kernel"]
    },
    "correlation_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUIDv4. Ties responses to requests and run events to their run.start."
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 with millisecond precision, e.g. 2026-04-25T14:32:18.412Z"
    },
    "rfc_version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semver. Receivers MUST reject envelopes whose major version differs from their own."
    },
    "payload": {
      "type": "object",
      "description": "Schema depends on message_type."
    }
  }
}
```

The envelope is the only stable shape every receiver MUST recognize. Per-`message_type` payload schemas follow.

### Family A — Run lifecycle

The run-lifecycle family implements the LangSmith POST/event/PATCH model on top of Jupyter `display_data` + `update_display_data`. The display id used at the Jupyter layer MUST equal the `run_id` so updates land in the correct display in the cell output. All three message types in this family travel kernel→extension; the operator's responses to a run come through MCP tool calls (RFC-001), not through this family.

A single run produces exactly one `run.start`, zero or more `run.event` messages with the same `correlation_id` as the `run.start`, and exactly one `run.complete`. Receivers MUST treat a duplicate `run.start` for the same `correlation_id` as a protocol error.

#### run.start

- **Direction:** kernel→extension
- **Semantics:** Opens a new run record. The kernel emits this when an agent action begins (LLM call, tool call, chain step). The extension MUST allocate a Jupyter display with `display_id == payload.id` and render the run record's initial state.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/run.start.json",
  "title": "run.start payload",
  "type": "object",
  "required": ["id", "trace_id", "parent_run_id", "name", "run_type", "start_time", "inputs"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "trace_id": { "type": "string", "format": "uuid" },
    "parent_run_id": { "type": ["string", "null"], "format": "uuid" },
    "name": { "type": "string" },
    "run_type": {
      "type": "string",
      "enum": ["llm", "tool", "chain", "retriever", "agent", "embedding"]
    },
    "start_time": { "type": "string", "format": "date-time" },
    "inputs": { "type": "object" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "metadata": { "type": "object" }
  }
}
```

Example payload:

```json
{
  "id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "trace_id": "5d27f5dd-26ce-4d61-9dbb-9fbf36d2fe2b",
  "parent_run_id": null,
  "name": "notify",
  "run_type": "tool",
  "start_time": "2026-04-25T14:32:18.412Z",
  "inputs": {
    "observation": "Extracted JWT validator into src/auth/jwt_validator.rs",
    "importance": "info"
  },
  "tags": ["agent:alpha", "zone:refactor", "tool:notify"],
  "metadata": { "agent_id": "alpha", "zone_id": "refactor" }
}
```

#### run.event

- **Direction:** kernel→extension
- **Semantics:** Streams an incremental update for an open run. The `correlation_id` MUST equal the originating `run.start`'s `correlation_id`. Receivers MUST emit a Jupyter `update_display_data` against the run's display id.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/run.event.json",
  "title": "run.event payload",
  "type": "object",
  "required": ["run_id", "event_type", "data", "timestamp"],
  "additionalProperties": false,
  "properties": {
    "run_id": { "type": "string", "format": "uuid" },
    "event_type": {
      "type": "string",
      "enum": ["token", "tool_call", "tool_result", "log", "error"]
    },
    "data": { "type": "object" },
    "timestamp": { "type": "string", "format": "date-time" }
  }
}
```

Example payload:

```json
{
  "run_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "event_type": "tool_call",
  "data": {
    "tool": "notify",
    "arguments": {
      "observation": "Extracted JWT validator into src/auth/jwt_validator.rs",
      "importance": "info"
    }
  },
  "timestamp": "2026-04-25T14:32:18.503Z"
}
```

#### run.complete

- **Direction:** kernel→extension
- **Semantics:** Closes the run record. The extension MUST finalize the run's display, attaching `outputs`, `error` (if present), and `status`. Subsequent `run.event` messages with the same `correlation_id` MUST be discarded.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/run.complete.json",
  "title": "run.complete payload",
  "type": "object",
  "required": ["run_id", "end_time", "outputs", "status"],
  "additionalProperties": false,
  "properties": {
    "run_id": { "type": "string", "format": "uuid" },
    "end_time": { "type": "string", "format": "date-time" },
    "outputs": { "type": "object" },
    "error": {
      "type": ["object", "null"],
      "properties": {
        "kind": { "type": "string" },
        "message": { "type": "string" },
        "traceback": { "type": "string" }
      }
    },
    "status": {
      "type": "string",
      "enum": ["success", "error", "timeout"]
    }
  }
}
```

Example payload:

```json
{
  "run_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "end_time": "2026-04-25T14:32:18.611Z",
  "outputs": { "acknowledged": true },
  "error": null,
  "status": "success"
}
```

### Family B — Layout

The layout family carries mutations against the layout-tree storage structure from [DR-0014](../decisions/0014-three-storage-structures-embedded.md). The kernel is the single logical writer of `metadata.rts.layout`; the extension proposes edits, the kernel applies them, the kernel echoes the new state.

V1 transmits a full snapshot in `layout.update`. JSON Patch (RFC 6902) operation lists are deferred to V2 for bandwidth optimization; the V1 envelope reserves the `patch` field as a forward-compatible marker but receivers MUST reject envelopes that carry `patch` while declaring `rfc_version` `1.x.x`.

#### layout.update

- **Direction:** kernel→extension
- **Semantics:** Authoritative full snapshot of the layout tree. Receivers MUST replace their in-memory copy atomically.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/layout.update.json",
  "title": "layout.update payload",
  "type": "object",
  "required": ["snapshot_version", "tree"],
  "additionalProperties": false,
  "properties": {
    "snapshot_version": { "type": "integer", "minimum": 0 },
    "tree": {
      "type": "object",
      "required": ["id", "type", "children"],
      "properties": {
        "id": { "type": "string" },
        "type": {
          "type": "string",
          "enum": ["workspace", "zone", "file", "agent", "viewpoint", "annotation"]
        },
        "render_hints": { "type": "object" },
        "children": {
          "type": "array",
          "items": { "$ref": "#/properties/tree" }
        }
      }
    }
  }
}
```

Example payload:

```json
{
  "snapshot_version": 17,
  "tree": {
    "id": "root",
    "type": "workspace",
    "render_hints": { "label": "monorepo" },
    "children": [
      {
        "id": "zone-refactor",
        "type": "zone",
        "render_hints": { "color": "#4a90e2", "hull": "convex" },
        "children": [
          {
            "id": "src/auth/tokens.rs",
            "type": "file",
            "render_hints": { "position": [120, 80] },
            "children": []
          }
        ]
      }
    ]
  }
}
```

#### layout.edit

- **Direction:** extension→kernel
- **Semantics:** Operator-driven UI mutation. The kernel MUST apply the edit to its in-memory layout tree and respond with a `layout.update` carrying the new authoritative snapshot. The kernel MAY reject an edit by emitting a `layout.update` that does not reflect the edit; the extension MUST treat the kernel's response as authoritative.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/layout.edit.json",
  "title": "layout.edit payload",
  "type": "object",
  "required": ["operation", "parameters"],
  "additionalProperties": false,
  "properties": {
    "operation": {
      "type": "string",
      "enum": ["add_zone", "remove_node", "move_node", "rename_node", "update_render_hints"]
    },
    "parameters": {
      "type": "object",
      "properties": {
        "node_id": { "type": "string" },
        "new_parent_id": { "type": "string" },
        "new_name": { "type": "string" },
        "render_hints": { "type": "object" },
        "node_spec": { "type": "object" }
      }
    }
  }
}
```

Example payload:

```json
{
  "operation": "move_node",
  "parameters": {
    "node_id": "src/auth/tokens.rs",
    "new_parent_id": "zone-review"
  }
}
```

### Family C — Agent graph

The agent-graph family carries queries against the agent state graph storage structure from [DR-0014](../decisions/0014-three-storage-structures-embedded.md). The extension issues queries; the kernel responds. Each `agent_graph.response` MUST carry the `correlation_id` of its originating `agent_graph.query`.

#### agent_graph.query

- **Direction:** extension→kernel
- **Semantics:** Request a view over the agent state graph. The query types cover the four operations listed in [chapter 07](../dev-guide/07-subtractive-fork-and-storage.md): neighbors of a node, paths between two nodes, subgraph within N hops of a node, full snapshot.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/agent_graph.query.json",
  "title": "agent_graph.query payload",
  "type": "object",
  "required": ["query_type"],
  "additionalProperties": false,
  "properties": {
    "query_type": {
      "type": "string",
      "enum": ["neighbors", "paths", "subgraph", "full_snapshot"]
    },
    "node_id": { "type": "string" },
    "target_node_id": { "type": "string" },
    "hops": { "type": "integer", "minimum": 1, "maximum": 16 },
    "edge_filters": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "spawned",
          "in_zone",
          "has_tool",
          "connects_to",
          "supervises",
          "collaborates_with",
          "has_capability",
          "configured_with"
        ]
      }
    }
  }
}
```

Example payload:

```json
{
  "query_type": "subgraph",
  "node_id": "agent:alpha",
  "hops": 2,
  "edge_filters": ["spawned", "in_zone", "has_tool"]
}
```

#### agent_graph.response

- **Direction:** kernel→extension
- **Semantics:** Reply to a prior `agent_graph.query`. The `correlation_id` MUST match the query's `correlation_id`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/agent_graph.response.json",
  "title": "agent_graph.response payload",
  "type": "object",
  "required": ["nodes", "edges"],
  "additionalProperties": false,
  "properties": {
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "type"],
        "properties": {
          "id": { "type": "string" },
          "type": {
            "type": "string",
            "enum": ["agent", "zone", "mcp_server", "tool", "operator", "file"]
          },
          "properties": { "type": "object" }
        }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["source", "target", "kind"],
        "properties": {
          "source": { "type": "string" },
          "target": { "type": "string" },
          "kind": {
            "type": "string",
            "enum": [
              "spawned",
              "in_zone",
              "has_tool",
              "connects_to",
              "supervises",
              "collaborates_with",
              "has_capability",
              "configured_with"
            ]
          },
          "properties": { "type": "object" }
        }
      }
    },
    "truncated": { "type": "boolean", "default": false }
  }
}
```

Example payload:

```json
{
  "nodes": [
    { "id": "agent:alpha", "type": "agent", "properties": { "status": "busy" } },
    { "id": "zone-refactor", "type": "zone", "properties": {} },
    { "id": "tool:notify", "type": "tool", "properties": {} }
  ],
  "edges": [
    { "source": "agent:alpha", "target": "zone-refactor", "kind": "in_zone", "properties": {} },
    { "source": "agent:alpha", "target": "tool:notify", "kind": "has_tool", "properties": {} }
  ],
  "truncated": false
}
```

### Family D — Operator action

The operator-action family carries extension→kernel notifications about UI events that are not themselves MCP tool calls. Cell edits, branch switches, zone selections, approval responses to operator-prompt round-trips, and notification dismissals are all surfaced through this single message type, dispatched on `action_type`.

#### operator.action

- **Direction:** extension→kernel
- **Semantics:** Notifies the kernel of an operator-initiated UI event. The kernel MUST apply the action's effect (mutate state, resume a paused tool call, dispatch a re-execution) and MAY emit downstream messages (`run.event`, `layout.update`, etc.) as a result. The kernel MUST NOT acknowledge `operator.action` directly; downstream effects are the acknowledgement.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/operator.action.json",
  "title": "operator.action payload",
  "type": "object",
  "required": ["action_type", "parameters"],
  "additionalProperties": false,
  "properties": {
    "action_type": {
      "type": "string",
      "enum": [
        "cell_edit",
        "branch_switch",
        "zone_select",
        "approval_response",
        "dismiss_notification"
      ]
    },
    "parameters": { "type": "object" },
    "originating_cell_id": { "type": "string" }
  }
}
```

Example payload:

```json
{
  "action_type": "approval_response",
  "parameters": {
    "request_id": "f08c2715-3f2b-4d44-9f5c-7c9a4e4a4b88",
    "decision": "approved",
    "operator_note": "looks correct"
  },
  "originating_cell_id": "cell-12"
}
```

### Family E — Heartbeat / liveness

Heartbeats are periodic markers used by the kernel/notebook failure split locked by [RFC-004](RFC-004-failure-mode-analysis.md). Each side MUST emit its heartbeat on a fixed cadence (recommended: every 5 seconds). Receivers MUST track the last-seen timestamp per direction and surface a liveness warning when no heartbeat has been received for more than 30 seconds.

#### heartbeat.kernel

- **Direction:** kernel→extension
- **Semantics:** Kernel-side liveness marker. The extension MUST update its kernel-state indicator on receipt and reset the kernel-liveness timer.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/heartbeat.kernel.json",
  "title": "heartbeat.kernel payload",
  "type": "object",
  "required": ["kernel_state", "uptime_seconds"],
  "additionalProperties": false,
  "properties": {
    "kernel_state": {
      "type": "string",
      "enum": ["ok", "degraded", "starting", "shutting_down"]
    },
    "uptime_seconds": { "type": "number", "minimum": 0 },
    "last_run_timestamp": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

Example payload:

```json
{
  "kernel_state": "ok",
  "uptime_seconds": 1834.21,
  "last_run_timestamp": "2026-04-25T14:32:18.611Z"
}
```

#### heartbeat.extension

- **Direction:** extension→kernel
- **Semantics:** Extension-side liveness marker. The kernel MUST update its extension-state indicator and reset the extension-liveness timer.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://llmnb.dev/rfc-003/heartbeat.extension.json",
  "title": "heartbeat.extension payload",
  "type": "object",
  "required": ["extension_state"],
  "additionalProperties": false,
  "properties": {
    "extension_state": {
      "type": "string",
      "enum": ["ok", "degraded", "starting", "shutting_down"]
    },
    "active_notebook_id": { "type": ["string", "null"] },
    "focused_cell_id": { "type": ["string", "null"] }
  }
}
```

Example payload:

```json
{
  "extension_state": "ok",
  "active_notebook_id": "session-2026-04-25.llmnb",
  "focused_cell_id": "cell-12"
}
```

## Backward-compatibility analysis

The `rfc_version` field on every envelope is mandatory. Receivers MUST reject any envelope whose major version differs from their own (a `2.x.x` envelope arriving at a `1.x` receiver MUST be discarded with a logged protocol error). Within a major version, the following classes apply.

**Additive (minor-version bump):**

- New `message_type` values appended to the envelope enum. Old receivers MUST treat unknown `message_type` values per the failure-mode table below.
- New optional fields in any payload schema. Old receivers MUST ignore unknown fields (the standard JSON-Schema "additional properties tolerated" stance), even where the per-message schema declares `additionalProperties: false` — the schemas in this RFC declare strictness for *senders*, not receivers, and the V2-and-later schemas will relax `additionalProperties` for receivers explicitly.
- New `event_type` values inside `run.event`. Old receivers MUST render unknown event types as opaque log entries rather than discarding them.
- New `query_type` values inside `agent_graph.query`. Receivers that do not implement a query type MUST respond with an empty `agent_graph.response` carrying `truncated: true`.
- New `action_type` values inside `operator.action`. Kernels that do not implement an action type MUST log and ignore.

**Deprecating (minor-version bump with deprecation note):**

- A `message_type`, field, or enum value marked obsolete but still honored. Senders MUST continue to emit the deprecated form alongside its replacement for at least one minor version, giving receivers a window to migrate. The RFC document MUST list every deprecation against the version it was introduced and the version in which removal is permitted.

**Breaking (major-version bump):**

- Renaming or removing a `message_type` enum value.
- Renaming or removing a required field in any payload schema.
- Changing the type of an existing field (e.g., `string` to `object`).
- Changing the semantic contract of an existing message (e.g., redefining what `run.complete` with `status: "timeout"` means).
- Changing the envelope's required-field set.

The RFC follows semver: minor bumps for additive changes, major for breaking, patch for clarifications that change neither shape nor semantics. The current version is `1.0.0`. V2 work tracked against this RFC MUST land its breaking changes against an explicit `2.0.0` proposal that supersedes this document.

## Failure modes

The table below enumerates every failure class a receiver MUST handle. Each row gives the trigger, the required response, and the recovery surface. RFC-004's fault-injection harness exercises each row.

| # | Trigger | Recipient response | Recovery surface |
|---|---|---|---|
| F1 | Malformed envelope (missing required field, wrong type) | Log and discard. If `correlation_id` is parseable, emit a `run.event` with `event_type: "error"` against it; otherwise log only. | Sender SHOULD detect the missing acknowledgement and retry with a corrected envelope. |
| F2 | Unknown `message_type` value | V1: fail closed — log and discard. V2: forward to a "future-message" diagnostic handler. | Receiver logs MUST capture the raw envelope for replay analysis. |
| F3 | Unknown payload field (additive compatibility) | Ignore the unknown field; process the rest of the payload. | None. This is the additive-compatibility happy path. |
| F4 | Out-of-order run events (`run.event` arrives before its `run.start`) | Buffer up to N=64 events keyed by `correlation_id` for at most 5 seconds. If the matching `run.start` arrives within the window, replay the buffered events in arrival order. Otherwise drop the buffer and log. | Replay harness MUST flag dropped buffers as protocol-ordering anomalies. |
| F5 | `run.event` arrives after `run.complete` for the same `run_id` | Discard the late event with a logged warning. | None. This indicates kernel-side run-tracker desync; surfaced to RFC-004's fault-tree. |
| F6 | Duplicate `run.start` for an existing `run_id` | Treat as protocol error. Discard the duplicate. Existing run state is unaffected. | Sender MUST be patched; receiver logs flag for investigation. |
| F7 | Heartbeat timeout (no `heartbeat.kernel` for >30s) | Extension surfaces "kernel may be hung" warning per RFC-004 kernel/notebook split. The extension MUST NOT auto-restart the kernel; that decision is operator-driven. | Operator-facing status bar; documented playbook entry. |
| F8 | Heartbeat timeout (no `heartbeat.extension` for >30s) | Kernel marks the extension as `degraded` and pauses non-essential frontend delivery (queues `run.event` messages up to 1024 entries; drops oldest beyond that). | Extension reconnect MUST trigger a `layout.update` and a buffered-runs replay. |
| F9 | `correlation_id` collision (two distinct messages share a UUID) | UUIDs MUST be UUIDv4. Receivers MUST treat the second occurrence as a duplicate and discard. | Sender MUST regenerate. Collision rate at UUIDv4's birthday bound is operationally negligible; any observed collision is a sender-side bug. |
| F10 | Major-version mismatch (`rfc_version` major differs from receiver's) | Reject the envelope. Emit a single log entry per session per peer. | Operator-facing upgrade prompt; documented in RFC-004 recovery paths. |
| F11 | `layout.edit` rejected by the kernel (invalid operation, conflicts with current state) | Kernel MUST emit a `layout.update` reflecting the current authoritative state without applying the edit. The extension MUST reconcile to the kernel's snapshot. | Extension SHOULD surface a transient "edit not applied" indicator. |
| F12 | `agent_graph.query` exceeds resource budget (e.g., subgraph hops too wide) | Kernel MUST respond with a truncated `agent_graph.response` carrying `truncated: true` and as many nodes/edges as fit. | Extension SHOULD render a "results truncated" notice. |

## Worked example

A single agent tool call traverses the full Family A lifecycle. The agent (`alpha`) emits a `notify` MCP tool call (from RFC-001's tool list) reporting that it has finished extracting a JWT validator. Because `notify` is fire-and-forget, the tool result is auto-completed; no operator round-trip occurs. All four envelopes share the same `correlation_id` (`8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0`), which equals the `run_id`.

Envelope 1 — `run.start`:

```json
{
  "message_type": "run.start",
  "direction": "kernel→extension",
  "correlation_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "timestamp": "2026-04-25T14:32:18.412Z",
  "rfc_version": "1.0.0",
  "payload": {
    "id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
    "trace_id": "5d27f5dd-26ce-4d61-9dbb-9fbf36d2fe2b",
    "parent_run_id": null,
    "name": "notify",
    "run_type": "tool",
    "start_time": "2026-04-25T14:32:18.412Z",
    "inputs": {
      "observation": "Extracted JWT validator into src/auth/jwt_validator.rs",
      "importance": "info"
    },
    "tags": ["agent:alpha", "zone:refactor", "tool:notify"],
    "metadata": { "agent_id": "alpha", "zone_id": "refactor" }
  }
}
```

Envelope 2 — `run.event` (tool_call):

```json
{
  "message_type": "run.event",
  "direction": "kernel→extension",
  "correlation_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "timestamp": "2026-04-25T14:32:18.503Z",
  "rfc_version": "1.0.0",
  "payload": {
    "run_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
    "event_type": "tool_call",
    "data": {
      "tool": "notify",
      "arguments": {
        "observation": "Extracted JWT validator into src/auth/jwt_validator.rs",
        "importance": "info"
      }
    },
    "timestamp": "2026-04-25T14:32:18.503Z"
  }
}
```

Envelope 3 — `run.event` (tool_result, auto-completion since `notify` is fire-and-forget):

```json
{
  "message_type": "run.event",
  "direction": "kernel→extension",
  "correlation_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "timestamp": "2026-04-25T14:32:18.567Z",
  "rfc_version": "1.0.0",
  "payload": {
    "run_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
    "event_type": "tool_result",
    "data": {
      "tool": "notify",
      "result": { "acknowledged": true, "auto_completed": true }
    },
    "timestamp": "2026-04-25T14:32:18.567Z"
  }
}
```

Envelope 4 — `run.complete`:

```json
{
  "message_type": "run.complete",
  "direction": "kernel→extension",
  "correlation_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
  "timestamp": "2026-04-25T14:32:18.611Z",
  "rfc_version": "1.0.0",
  "payload": {
    "run_id": "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0",
    "end_time": "2026-04-25T14:32:18.611Z",
    "outputs": { "acknowledged": true },
    "error": null,
    "status": "success"
  }
}
```

The extension renders this sequence as: open a Jupyter display with `display_id == "8a3c1a2e-9d77-4f0a-8a16-ce5d2b9d6aa0"` showing a "notify (running)" indicator on envelope 1; update it with the tool-call detail on envelope 2; mark the tool result as auto-completed on envelope 3; finalize the display with status "success" on envelope 4. Total latency from `run.start` to `run.complete` is 199ms; all four envelopes appear in the cell's MIME-typed output stream and persist in the `.llmnb` file's `metadata.rts.event_log` for replay.

## Consumers

- **Kernel `custom_messages` dispatcher (Stage 2 Track B3):** the Python module that serializes envelopes onto Jupyter messaging and validates incoming envelopes from the extension.
- **Extension message router (Stage 2 Track C R2):** the TypeScript module that deserializes envelopes, validates them against the schemas in this RFC, and dispatches per `message_type` to the appropriate UI handler.
- **Run-tracker (Stage 2 Track B2):** the kernel-side component that produces `run.start`, `run.event`, and `run.complete` envelopes from intercepted LLM calls and tool calls.
- **Replay harness (RFC-004):** the offline tool that reads the persisted event log, replays it through a mock extension, and asserts the property-based invariants from RFC-004.
- **LangSmith run-record renderer (Stage 5):** the cell-output renderer that consumes Family A envelopes, drives `display_data` / `update_display_data`, and produces the operator-visible run cards.

## Source

- ADR: [DR-0009 (NotebookController, no Jupyter kernel)](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- ADR: [DR-0014 (three storage structures embedded)](../decisions/0014-three-storage-structures-embedded.md)
- ADR: [DR-0015 (kernel-extension bidirectional MCP)](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- Dev-guide chapter: [06 — VS Code notebook substrate](../dev-guide/06-vscode-notebook-substrate.md) (streaming protocol with `display_id`)
- Dev-guide chapter: [07 — Subtractive fork and storage](../dev-guide/07-subtractive-fork-and-storage.md) (three storage structures)
- Dev-guide chapter: [08 — Blockers, mediator, standards](../dev-guide/08-blockers-mediator-standards.md) (RFC-003 brief)
- Sibling RFCs: [RFC-001](RFC-001-mcp-tool-taxonomy.md) (tool taxonomy referenced by Family A's `notify` example), [RFC-004](RFC-004-failure-mode-analysis.md) (failure-mode harness consuming this catalog)
