# RFC-005 — `.llmnb` file format

## Status

Draft. Date: 2026-04-27. Version: 1.0.1.

This RFC is the layer-1 (persistent storage) normative specification for the on-disk shape of an `.llmnb` notebook. It MUST be accepted before any code writes to the `metadata.rts` namespace. Conforming implementations attach to this exact version string; deviations require an RFC update, not a code workaround.

**Changelog**:
- v1.0.1 (additive):
  - `config.recoverable.agents[]` schema gains two required fields surfaced during V1 mega-round implementation: `task` (string, the agent's job description; required for `AgentSupervisor.respawn_from_config(...)` to know what to spawn) and `work_dir` (string, optional; defaults to workspace root). Without these, the kernel cannot deterministically respawn agents on file open.
  - §F13 queue-overflow disk fallback file format locked: marker at `<workspace_root>/.llmnb-overflow-marker.json` with `{"kernel_session_id", "overflow_at" (ISO 8601), "snapshot_version", "queue_size_at_overflow"}`; snapshot at `<workspace_root>/.llmnb-overflow-snapshot.json` containing the full `metadata.rts` body. Atomic write via `<file>.tmp` + `os.replace`. Operator/extension may merge or discard on next file open.
- v1.0.0: initial draft.

## Source ADRs and prior RFCs

- [DR-0009 — VS Code NotebookController API; no Jupyter kernel](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- [DR-0014 — three storage structures embedded in one file](../decisions/0014-three-storage-structures-embedded.md)
- [DR-0016 — RFC standards discipline](../decisions/0016-rfc-standards-discipline.md)
- [RFC-001 — V1 MCP tool taxonomy](RFC-001-mcp-tool-taxonomy.md) — referenced by `config.kernel.rfc_001_version`
- [RFC-002 — Claude Code provisioning procedure](RFC-002-claude-code-provisioning.md) — referenced by `config.agents[*].system_prompt_template_id`
- [RFC-003 — Custom Jupyter message format](RFC-003-custom-message-format.md) — wire form; this RFC is the persistent form. RFC-003 v2 is expected to switch payloads to OTLP/JSON; this RFC anticipates that and specifies OTLP/JSON on disk regardless of RFC-003's version.

## Context

[DR-0014](../decisions/0014-three-storage-structures-embedded.md) commits V1 to three storage structures (layout tree, agent state graph, chat flow) embedded in a single `.llmnb` file. [Chapter 07 §"One file"](../dev-guide/07-subtractive-fork-and-storage.md) names the namespace (`metadata.rts`) and lists its sub-keys (`layout`, `agents`, `config`, `event_log`) but does not lock schemas. Without a normative spec, the kernel and extension share no on-disk vocabulary; without it, `git diff` over `.llmnb` files surfaces semantic noise; without it, replay harnesses (RFC-004) cannot deserialize.

This RFC closes that gap. It specifies:

1. The top-level `metadata.rts` envelope and its versioning.
2. The four substructures (layout, agents, config, event_log) and the auxiliary blob table.
3. The cell-level `metadata.rts` namespace and the run-record cell-output MIME.
4. Persistence strategy (single logical writer, line-oriented serialization, content-addressed blobs).
5. Backward-compatibility classes and failure-mode taxonomy.

The .llmnb container is `.ipynb`-conformant (`nbformat`, `nbformat_minor`, `metadata`, `cells`); RTS state lives entirely in namespaced extensions per [DR-0014](../decisions/0014-three-storage-structures-embedded.md). Standard Jupyter tools that open the file MUST ignore unknown namespaces — this is the conventional `nbformat` extension model. The `.llmnb` extension is registered exclusively by the V1 VS Code extension to prevent JupyterLab from opening these files (per [chapter 07 §"Why ipynb-derived"](../dev-guide/07-subtractive-fork-and-storage.md)).

## Specification

### File extension and MIME type

- File extension: `.llmnb` (registered exclusively).
- File MIME type: `application/vnd.llmnb+json`.
- Cell-output MIME for run records: `application/vnd.rts.run+json` (one merged OTLP/JSON span per cell output).

### Top-level structure

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "rts": {
      "schema_version": "1.0.0",
      "schema_uri": "https://llmnb.dev/llmnb/v1/schema.json",
      "session_id": "<uuid>",
      "created_at": "<ISO 8601 with millisecond precision>",
      "layout":    { "version": 1, "tree":  { ... } },
      "agents":    { "version": 1, "nodes": [ ... ], "edges": [ ... ] },
      "config":    { "version": 1, "recoverable": { ... }, "volatile": { ... } },
      "event_log": { "version": 1, "runs":  [ ... ] },
      "blobs":     { ... },
      "drift_log": [ ... ]
    }
  },
  "cells": [ ... ]
}
```

`metadata.rts.schema_version` is the file format version (this RFC). Each substructure carries its own `version` integer for additive evolution within the file format major version. Receivers MUST reject any file whose `metadata.rts.schema_version` major differs from theirs.

`session_id` is a UUIDv4 generated when the file is first written and preserved verbatim across all subsequent writes. Reopening the same file in a new kernel attaches to the same `session_id`; creating a new file allocates a new `session_id`. Multiple sessions per file are not supported in V1.

`created_at` is the wall-clock timestamp at first write and is never updated after that. Last-modified time is recoverable from `git log -1 --format=%cI <file>`; this RFC deliberately omits an `updated_at` field to avoid one-line diff churn on every save.

`schema_uri` SHOULD point at the published schema for this RFC version. The path includes the major version explicitly (`/v1/`) following the OTel convention (`opentelemetry.io/schemas/1.32.0`).

### Recoverability semantics

Every persisted field in `metadata.rts` is one of two kinds:

- **Recoverable.** A reader of the file can reconstruct the same logical state on every load. The field describes pure data and does not depend on the runtime environment. Examples: layout-tree node IDs and structure, agent-graph nodes and edges (structure only — see below), closed run records (those with `endTimeUnixNano` set and `status.code != STATUS_CODE_UNSET`), blob contents (hash-verifiable), all `config.recoverable.*` fields.
- **Volatile.** A reader CANNOT guarantee the original state can be reconstructed because the field depends on external reality that may have changed since save: model availability, RFC version of the running kernel, prompt-template file contents, proxy reachability, agent-process aliveness. Examples: every `config.volatile.*` field, in-progress run records (`status.code: STATUS_CODE_UNSET`), `agents.nodes[*].properties.status` (point-in-time agent state).

Each substructure specifies which of its fields are recoverable vs volatile in its own section below. The general invariants:

1. **Structure is recoverable; runtime is volatile.** Layout-tree nodes, agent-graph nodes and edges, blob contents, cell IDs and contents, closed runs — recoverable. Anything that says "this was the case at save time" — volatile.
2. **Volatile fields are checked for drift on load.** The kernel computes the current value of each volatile field, compares with the persisted value, and emits a `drift_log` entry on mismatch.
3. **Volatile fields MUST NOT be relied on for resume behavior.** A kernel that resumes against a file MUST defer to the current environment, not the persisted volatile state, when they conflict — and MUST surface the conflict to the operator before resuming agent execution.

The split is explicit in the schema: `config` separates `recoverable` from `volatile`. For other substructures (`agents`, `event_log`) the recoverable/volatile boundary is documented in the substructure's section.

### `metadata.rts.drift_log`

The drift log is an append-only flat array of detected drift events between save and load. It is the operator's audit trail for "what changed underneath this session."

```json
[
  {
    "detected_at": "2026-04-26T13:22:45.000Z",
    "field_path": "config.volatile.agents[0].model",
    "previous_value": "claude-sonnet-4-5",
    "current_value": "claude-sonnet-4-6",
    "severity": "warn",
    "operator_acknowledged": false
  },
  {
    "detected_at": "2026-04-26T13:22:45.000Z",
    "field_path": "config.volatile.agents[0].system_prompt_hash",
    "previous_value": "sha256:c4f5e9...",
    "current_value": "sha256:91a2b3...",
    "severity": "warn",
    "operator_acknowledged": false
  },
  {
    "detected_at": "2026-04-26T13:22:45.000Z",
    "field_path": "event_log.runs[1].status",
    "previous_value": "STATUS_CODE_UNSET",
    "current_value": "STATUS_CODE_ERROR (kernel restart truncated)",
    "severity": "info",
    "operator_acknowledged": false
  }
]
```

Drift event schema:

- `detected_at` (ISO 8601, required) — when the drift was observed.
- `field_path` (string, required) — JSONPath-like path into `metadata.rts` identifying the field that drifted.
- `previous_value` (any, required) — the value as persisted in the file.
- `current_value` (any, required) — the value the kernel observed in the current environment. For "field no longer exists" cases, use `null`.
- `severity` (enum, required) — `info | warn | error`. `info` for benign drift (e.g., status of an in-progress span auto-truncated on restart). `warn` for changes that may affect behavior but resume can proceed (model version bump within the same major; system prompt hash differing). `error` for drift that blocks resume (RFC major mismatch, MCP server disappeared).
- `operator_acknowledged` (boolean, required) — set to `true` when the operator confirms the drift via the UI. Acknowledgments are persisted so reopening the file does not re-prompt.

Drift events are NEVER removed from the log. They form an audit trail. If a field drifts, then drifts back (e.g., model temporarily unavailable then restored), both events are recorded.

The kernel MUST emit a drift event on first observation per session. The kernel SHOULD NOT spam the log with duplicate events for the same field within a single session. Operator acknowledgment closes the prompt for that specific drift event but does not silence future drift on the same field.

### `metadata.rts.layout` — layout tree

```json
{
  "version": 1,
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

Tree node schema:

- `id` (string, required) — stable identifier. For files: workspace-relative POSIX path. For zones, agents, viewpoints, annotations: caller-assigned string (UUIDv4 recommended for non-path nodes).
- `type` (enum, required) — `workspace | zone | file | agent | viewpoint | annotation`.
- `render_hints` (object, optional) — UI-only metadata (position, color, hull style, label). Any unrecognized keys are tolerated and preserved on read.
- `children` (array, required even when empty) — child nodes recursively.

Node IDs MUST be unique within a single tree. Receivers MUST reject a tree containing duplicate IDs anywhere in the subtree.

The kernel is the single logical writer of `metadata.rts.layout`. Operator-initiated edits travel as RFC-003 `layout.edit` messages and are applied by the kernel before being echoed back as the new authoritative tree.

### `metadata.rts.agents` — agent state graph

```json
{
  "version": 1,
  "nodes": [
    { "id": "agent:alpha", "type": "agent", "properties": { "status": "idle" } },
    { "id": "zone-refactor", "type": "zone", "properties": {} },
    { "id": "tool:notify", "type": "tool", "properties": {} }
  ],
  "edges": [
    { "source": "agent:alpha", "target": "zone-refactor", "kind": "in_zone", "properties": {} },
    { "source": "agent:alpha", "target": "tool:notify", "kind": "has_tool", "properties": {} }
  ]
}
```

Node schema:
- `id` (string, required) — stable identifier. Agents: `agent:<agent_id>`. Zones: same id as in the layout tree (cross-structure reference). MCP servers: `mcp:<server_id>`. Tools: `tool:<tool_name>`. Operator: `operator`. Files: workspace-relative POSIX path (cross-structure reference).
- `type` (enum, required) — `agent | zone | mcp_server | tool | operator | file`.
- `properties` (object, optional) — node-type-specific attributes.

Edge schema:
- `source`, `target` (strings, required) — node IDs from `nodes[]`. Receivers MUST reject edges referencing nonexistent nodes.
- `kind` (enum, required) — `spawned | in_zone | has_tool | connects_to | supervises | collaborates_with | has_capability | configured_with`.
- `properties` (object, optional) — timestamp, permissions metadata, etc.

The agent graph represents *current* state. Historical state-at-time-of-run is recorded per-run in `event_log` via `attributes["llmnb.in_zone"]`, `attributes["llmnb.spawned_by_agent"]`, etc., giving temporal resolution that the agent graph itself does not.

#### Recoverability

- *Recoverable:* node IDs, node types, edge sources/targets, edge kinds. The graph structure is pure data.
- *Volatile:* `nodes[*].properties.status` (e.g., `"busy"`, `"idle"`, `"crashed"`) — point-in-time agent runtime state. On load, the kernel re-evaluates each agent's status against the current process state. Agents whose process is no longer running are marked with the new status and a drift event is emitted (`field_path: "agents.nodes[<id>].properties.status"`, `severity: "info"`). The agent graph itself is updated in place to reflect current reality; the previous status is preserved in the drift log.

### `metadata.rts.config` — resume state

`config` is split into `recoverable` and `volatile` subsections per the [Recoverability semantics](#recoverability-semantics) section below. Recoverable state is deterministic on resume; volatile state depends on the runtime environment and is checked for drift on every load.

```json
{
  "version": 1,
  "recoverable": {
    "kernel": {
      "blob_threshold_bytes": 65536
    },
    "agents": [
      {
        "agent_id": "alpha",
        "zone_id": "refactor",
        "tools_allowed": ["notify", "report_completion", "report_progress", "ask"]
      }
    ],
    "mcp_servers": [
      {
        "server_id": "operator-bridge",
        "tools": ["notify", "report_completion", "ask", "request_approval", "..."]
      }
    ]
  },
  "volatile": {
    "kernel": {
      "model_default": "claude-sonnet-4-5",
      "passthrough_mode": "litellm",
      "rfc_001_version": "1.0.0",
      "rfc_002_version": "1.0.1",
      "rfc_003_version": "2.0.0"
    },
    "agents": [
      {
        "agent_id": "alpha",
        "model": "claude-sonnet-4-5",
        "system_prompt_template_id": "rfc-002-default",
        "system_prompt_hash": "sha256:c4f5e9..."
      }
    ],
    "mcp_servers": [
      {
        "server_id": "operator-bridge",
        "transport": "stdio"
      }
    ]
  }
}
```

#### Recoverable subsection

Fields under `config.recoverable` are deterministic on resume — opening the file in any kernel that conforms to this RFC produces the same logical state. They describe pure data: agent identities, zone bindings, tool restrictions, file-format thresholds.

#### Volatile subsection

Fields under `config.volatile` depend on the runtime environment and MAY differ from save to load:

- `kernel.model_default` and `agents[*].model` — model identities can be deprecated, retired, or change behavior across versions.
- `kernel.passthrough_mode` — the proxy named here may not be running on resume.
- `kernel.rfc_001_version` / `rfc_002_version` / `rfc_003_version` — the kernel's RFC implementations may have advanced (or regressed) since save.
- `agents[*].system_prompt_template_id` + `system_prompt_hash` — the operator may have edited the template file, changing its hash.
- `mcp_servers[*].transport` — the MCP server may have moved from stdio to HTTP, etc.

The kernel MUST scan every `volatile` field on file load and compare against the current environment. Detected differences produce entries in `metadata.rts.drift_log` (see below) and SHOULD surface to the operator before resuming agent execution.

#### Forbidden fields (security)

Both `recoverable` and `volatile` subsections MUST NOT contain any fields whose name (case-insensitive) matches any of:
- `*_key` (except `*_public_key`)
- `*_token`
- `*_password`
- `*_secret`
- `authorization`, `bearer`, `cookie`, `api_key`

Loaders MUST reject a file containing any forbidden field with a security error and MUST NOT log the offending value. Secrets live in the operator's `.env` / OS keyring; `config` may hold a *reference* to a secret name (e.g., `"api_key_env_var": "ANTHROPIC_API_KEY"`) but never the value itself.

#### Resume-time RFC version check

On file open, the kernel compares `config.volatile.kernel.rfc_001_version` (etc.) with its own RFC implementation versions:

- Same major version → load and emit a `drift_log` entry if minor differs.
- Different major version → emit a `drift_log` entry, refuse to spawn agents from `config.recoverable.agents[]`, surface a "config incompatible with kernel; agents are read-only" warning. The operator may inspect history but not resume agent execution until they migrate the config.

### `metadata.rts.event_log` — chat flow

```json
{
  "version": 1,
  "runs": [
    {
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
        { "key": "llmnb.zone_id",  "value": { "stringValue": "refactor" } },
        { "key": "llmnb.cell_id",  "value": { "stringValue": "cell-12" } },
        { "key": "input.value",    "value": { "stringValue": "{\"observation\":\"Extracted JWT validator\",\"importance\":\"info\"}" } },
        { "key": "input.mime_type",  "value": { "stringValue": "application/json" } },
        { "key": "output.value",     "value": { "stringValue": "{\"acknowledged\":true}" } },
        { "key": "output.mime_type", "value": { "stringValue": "application/json" } }
      ],
      "events": [
        { "timeUnixNano": "1745588938503000000", "name": "tool_call",
          "attributes": [
            { "key": "tool.name", "value": { "stringValue": "notify" } } ] },
        { "timeUnixNano": "1745588938567000000", "name": "tool_result",
          "attributes": [
            { "key": "auto_completed", "value": { "boolValue": true } } ] }
      ],
      "links": []
    }
  ]
}
```

Each entry of `event_log.runs[]` is a strict OTLP/JSON span ([opentelemetry-proto OTLP/JSON encoding](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md)). Three deviations from the protobuf wire form are explicitly noted:

1. `traceId` and `spanId` are lowercase hex strings (32 and 16 chars); `parentSpanId` is the same or `null` for root spans.
2. `startTimeUnixNano` and `endTimeUnixNano` are JSON STRINGS of decimal nanoseconds since the Unix epoch (preserves 64-bit precision in JSON parsers).
3. `attributes` and `events[*].attributes` are arrays of `{key, value}` pairs where `value` is an `AnyValue` tagged union (`stringValue | intValue | boolValue | doubleValue | arrayValue | kvlistValue`). The flat-object `{"key": "value"}` form is non-conformant and MUST NOT be used.

#### Mandatory attributes per run

Every run record MUST carry the following attributes (under the `llmnb.*` namespace because they have no OTel semantic-convention equivalent):

- `llmnb.run_type` — one of `llm | tool | chain | retriever | agent | embedding | agent_emit`. Renderers dispatch on this attribute.
- `llmnb.agent_id` — the agent that produced the run.

The following SHOULD be present when applicable:

- `llmnb.zone_id` — zone context at run time.
- `llmnb.cell_id` — cell that triggered the run (when traceable to one).
- `llmnb.tool_name` — duplicated from `tool.name` for query convenience (renderers reading purely under `llmnb.*` need not also read `tool.*`).

LLM calls SHOULD use OTel GenAI semantic conventions: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus events `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.choice`.

Tool calls SHOULD use OpenInference conventions: `tool.name`, `input.value`, `input.mime_type`, `output.value`, `output.mime_type`.

#### `agent_emit` runs — raw agent output

The `agent_emit` run type captures every byte of agent output that did NOT route through a structured tool call: free-form prose despite the forced-tool-use system prompt, pre-tool-call reasoning text, Claude Code stream-json `system` / `result` / `error` message types, subprocess stderr, malformed tool-use JSON the parser could not classify. This refines [DR-0010](../decisions/0010-force-tool-use-suppress-text.md): structured tool calls remain the *primary* operator-facing channel, but raw agent output is captured and surfaced rather than silently discarded.

Each `agent_emit` span MUST carry:

- `llmnb.run_type: "agent_emit"`.
- `llmnb.agent_id` — the agent that emitted the output.
- `llmnb.emit_kind` — one of:
  - `prose` — free-form text emitted despite the suppression prompt.
  - `reasoning` — text that preceded a structured tool call (e.g., "Let me check the file first.").
  - `system_message` — Claude Code stream-json `system`-type message.
  - `result` — Claude Code stream-json `result`-type message (terminal session result).
  - `error` — Claude Code stream-json `error`-type message.
  - `stderr` — content captured from the agent subprocess's stderr stream.
  - `invalid_tool_use` — a structurally complete tool-use block that referenced a tool not in the allowed list, or whose arguments failed schema validation.
  - `malformed_json` — content the parser believed was a tool-use block but could not deserialize.
- `llmnb.emit_content` — the raw content (string). Subject to RFC-005's blob threshold: contents above `config.kernel.blob_threshold_bytes` MUST be hashed into `metadata.rts.blobs` and the attribute carries the `$blob:sha256:...` sentinel.

Each `agent_emit` span SHOULD carry when available:

- `llmnb.parser_diagnostic` — for `malformed_json` and `invalid_tool_use`, a short string explaining what the parser tried to do (e.g., `"unexpected end-of-input at position 142"`).
- `parentSpanId` — the LLM call span that produced the emission, when traceable. This makes the agent's full output reconstructable: every LLM call's full output (structured + unstructured) is the union of its child tool spans + its child agent_emit spans.

`agent_emit` spans are **recoverable** — they are pure data captured at run time and load verbatim. They are emitted via the same Family A wire as other spans (RFC-006 §1) and persist in `event_log.runs[]` alongside tool and llm spans. The renderer SHOULD visually de-emphasize them relative to structured tool calls (collapsed by default, expandable on click), preserving the operator's primary attention on tool calls while keeping agent output one click away.

Example `agent_emit` span (free-form prose that escaped suppression):

```json
{
  "traceId": "5d27f5dd26ce4d619dbb9fbf36d2fe2b",
  "spanId":  "f0e1d2c3b4a59687",
  "parentSpanId": "8a3c1a2e9d774f0a",
  "name": "agent_emit:prose",
  "kind": "SPAN_KIND_INTERNAL",
  "startTimeUnixNano": "1745588938302000000",
  "endTimeUnixNano":   "1745588938302000000",
  "status": { "code": "STATUS_CODE_OK", "message": "" },
  "attributes": [
    { "key": "llmnb.run_type",     "value": { "stringValue": "agent_emit" } },
    { "key": "llmnb.agent_id",     "value": { "stringValue": "alpha" } },
    { "key": "llmnb.emit_kind",    "value": { "stringValue": "prose" } },
    { "key": "llmnb.emit_content", "value": { "stringValue": "Let me check the file structure before I propose any changes." } }
  ],
  "events": [],
  "links": []
}
```

#### In-progress spans

A span with `endTimeUnixNano: null` and `status.code: "STATUS_CODE_UNSET"` is in-progress. The kernel MAY persist in-progress spans on autosave to avoid data loss on crash.

In-progress spans are **volatile** — they cannot be reliably reconstructed across kernel restarts because the agent that produced them is no longer in the same process. On resume, the kernel scans for in-progress spans and either:

1. *Reopens* the span when the originating agent has rejoined (rare in V1; happens when a kernel restart preserves agent process state, which V1 does not).
2. *Truncates* the span by setting `endTimeUnixNano` to the kernel-restart wall-clock time and `status.code: "STATUS_CODE_ERROR", message: "kernel restart truncated"`. A drift event is emitted: `field_path: "event_log.runs[<index>].status"`, `severity: "info"`. This is the V1 default.

Closed spans (those with `endTimeUnixNano` set and `status.code != STATUS_CODE_UNSET`) are **recoverable** and are loaded verbatim.

#### Cross-structure references

- Run-to-run references (e.g., `follows_from`, `caused_by`, `branched_from`) use OTel `links[]` with real `traceId`+`spanId` and a `link.attributes["llmnb.kind"]` carrying the relationship kind.
- Run-to-layout-node and run-to-agent-graph-node references use **attributes**, NOT links. Examples: `llmnb.touched_files: arrayValue([...])`, `llmnb.in_zone: stringValue("...")`, `llmnb.spawned_by_agent: stringValue("...")`.

This split keeps the OTel link primitive strict-schema-conformant (links MUST point at real spans) while preserving the cross-structure queries that chapter 07 §"Cross-structure references" requires.

#### Line-oriented serialization

The kernel's writer MUST format `event_log.runs[]` so each span occupies its own line in the serialized JSON, with the outer array brackets on their own lines:

```
"runs": [
  { ... full span on this line, can be wide ... },
  { ... },
  { ... }
]
```

Pretty-printing inside the per-span line is not required (and reduces git delta efficiency). The kernel SHOULD emit each span as one line to maximize git pack-delta compression on append-heavy histories. The same convention applies to `layout.tree.children[]` and `agents.nodes[]`/`agents.edges[]` arrays where practical.

### `metadata.rts.blobs` — content-addressed large attribute values

```json
{
  "sha256:c4f5e9b8a7d6...": {
    "content_type": "text/plain",
    "encoding": "utf-8",
    "size_bytes": 130421,
    "data": "...full content..."
  },
  "sha256:7e8f9a0b1c2d...": {
    "content_type": "application/json",
    "encoding": "utf-8",
    "size_bytes": 84112,
    "data": "..."
  }
}
```

Any attribute value whose serialized form exceeds `config.kernel.blob_threshold_bytes` (default 64 KiB) MUST be stored as a content-addressed blob. The originating attribute's value is replaced with a sentinel:

```json
{ "key": "output.value", "value": { "stringValue": "$blob:sha256:c4f5e9b8a7d6..." } }
```

Receivers MUST recognize the `$blob:` prefix and resolve the content from `metadata.rts.blobs`. The hash MUST be the SHA-256 of the original `data` content (the hash key validates the blob's integrity).

V1 supports text content only (`encoding: "utf-8"`). Binary content (images, archives) is not supported in V1; tools that produce binary outputs MUST either truncate, encode to text, or fail. V2 introduces `.llmnb-objects/` sidecar storage following git-LFS semantics.

#### Blob garbage collection

V1 blob GC is manual: `pixi run kernel-gc <file>` walks `event_log.runs[*]` looking for `$blob:` references in attribute values, marks reachable blobs, and rewrites the file with unreachable blobs removed. Auto-GC on save is V2.

Blob lifecycle is append-only by default: kernels append new blobs but never automatically prune. The git-LFS-like assumption is that git's pack-delta compression handles long-lived blob histories well enough that GC is a manual maintenance task, not a per-save cost.

### Cell-level metadata

```json
{
  "cell_type": "code",
  "metadata": {
    "rts": {
      "trace_id": "5d27f5dd26ce4d619dbb9fbf36d2fe2b",
      "target_agent": "alpha"
    }
  },
  "outputs": [
    {
      "output_type": "display_data",
      "data": {
        "application/vnd.rts.run+json": { /* one full OTLP span — same shape as event_log.runs[*] */ }
      },
      "metadata": { "display_id": "8a3c1a2e9d774f0a" }
    }
  ]
}
```

`cells[*].metadata.rts` is intentionally minimal — only fields that a reader needs *before* any run record exists in `event_log`:

- `trace_id` — links the cell to runs in `event_log` (filter by `traceId`).
- `target_agent` — `agent_id` the cell was dispatched to.

Everything else (timing, run IDs, status, durations) is recoverable from `event_log` by `traceId` lookup and is therefore omitted from cell metadata to minimize per-save diff churn.

#### Cell outputs

`cells[*].outputs[*]` carry one merged OTLP/JSON span per `application/vnd.rts.run+json` MIME-typed output. The cell-output span and its `event_log.runs[]` entry MUST be the same span (identical `traceId`+`spanId`). The cell-output is the "rendered" view; `event_log` is the canonical store. They are kept in sync by the kernel.

The Jupyter `display_id` field on the output's `metadata` MUST equal the span's `spanId`. This is what enables `update_display_data` to hit the right cell output during streaming.

### Branching and history (git semantics)

V1 uses git for all history and branching. The `.llmnb` file is a single artifact; multiple branches of a notebook = multiple git refs pointing at different commits of the same file. There is no in-file branch identifier and no in-file lineage tracking.

Implications:

- Edit-and-resend creates a new cell with new `cell_id` and new `trace_id`; no in-file link to the old cell. Operators recover lineage via `git log -p <file>`.
- Forking a session = `git checkout -b alt-jwt-impl` then editing the cell on the new branch.
- Comparing two sessions = `git diff main..alt-jwt-impl -- session.llmnb`.

The line-oriented serialization (above) is what makes `git diff` on `.llmnb` produce useful output. Without it, every append would rewrite the entire `event_log.runs[]` line and diffs would be pointless.

### Persistence strategy: who writes the file

[Chapter 07 §"One file"](../dev-guide/07-subtractive-fork-and-storage.md) names "two physical writers, one logical writer." This RFC fixes the implementation:

- **Single physical writer:** the VS Code extension, via the `vscode.NotebookEdit` API and VS Code's normal serializer pipeline.
- **Single logical writer of `metadata.rts`:** the kernel.

The kernel ships `metadata.rts` snapshots to the extension over a custom message family (`notebook.metadata` — see RFC-003 v2 / future supersession), the extension applies the snapshot via `vscode.NotebookEdit.updateNotebookMetadata(...)`, and VS Code's save flow persists. There are NO direct kernel writes to disk under normal operation.

#### When no extension is attached

If the kernel runs with no extension attached (e.g., headless smoke, kernel managed by Jupyter server with VS Code closed), the kernel queues `notebook.metadata` updates in memory. Bounded queue policy:

- All `event_log` appends are kept in arrival order (semantically additive — they MUST persist).
- `layout` and `agents` snapshots are last-writer-wins; only the most recent is retained.
- Hard cap of 10 000 queued event-log entries. On overflow, kernel writes a checkpoint marker to disk and direct-writes once. The "two writers" violation is constrained to this rare overflow path and is logged.

#### Snapshot triggers

The kernel emits `notebook.metadata` updates on:

1. **Operator save** (extension reports save event).
2. **Clean shutdown** (kernel `pre_shutdown` hook).
3. **Periodic timer** every 30 seconds while the file is dirty (hooked into the autosave path).
4. **End-of-run** when `event_log` gains a closed span.

Crash recovery loses at most the last 30 seconds of activity, which is acceptable for V1.

## Backward-compatibility analysis

The `metadata.rts.schema_version` field (top-level) and per-substructure `version` fields together form a two-level versioning scheme.

**Top-level major bump (`schema_version: "1.0.0"` → `"2.0.0"`):**
- Renaming or removing required substructures.
- Changing the envelope (e.g., relocating `metadata.rts` to a different namespace).
- Changing the file's `nbformat` requirement.

Receivers MUST reject any file whose top-level `schema_version` major differs from theirs.

**Top-level minor bump (`1.0.0` → `1.1.0`):**
- Adding a new substructure under `metadata.rts` (old readers ignore unknown keys).
- Adding a new optional field at the top level.

**Substructure version bumps** are independent within a top-level major version:

- *Additive* (substructure minor): new optional field, new enum value (in attribute keys, edge kinds, node types). Receivers MUST tolerate unknown enum values per the RFC-003 conventions.
- *Deprecating* (substructure minor): a field marked obsolete but still honored. Kernels MUST emit both the deprecated form and its replacement for at least one minor version.
- *Breaking* (substructure major): rename/remove a required field, type change, semantic redefinition.

Within a top-level major version, substructure majors MAY differ between readers and writers if the writer's substructure major is ≤ the reader's. Otherwise, the affected substructure is read as opaque (preserved on round-trip but not interpreted).

#### Forward compatibility for OTel evolution

OTel itself versions its semantic conventions (`opentelemetry.io/schemas/1.32.0`, etc.). When the OTel GenAI semconv version we follow changes, this RFC's minor version bumps and the new attribute keys are documented in the changelog. Old readers MAY ignore unknown attributes; that is the additive happy path.

## Failure modes

| # | Trigger | Recipient response | Recovery surface |
|---|---|---|---|
| F1 | `metadata.rts.schema_version` major mismatches reader's | Refuse to load. Surface "incompatible file format" error to operator. | Operator-facing upgrade prompt linking to migration docs. |
| F2 | Forbidden secret field detected anywhere in `config` | Refuse to load with security error. MUST NOT log the offending value. | Operator manually edits the file or restores from a clean version. |
| F3 | In-progress span (`endTimeUnixNano: null`) found at file open | Mark `status.code: STATUS_CODE_ERROR, message: "kernel restart truncated"`, set `endTimeUnixNano` to current wall-clock. Do NOT block load. | Operator sees a truncated run in cell output; can re-execute the cell to rerun. |
| F4 | Attribute value carries `$blob:sha256:<hash>` but `metadata.rts.blobs` lacks that key | Render placeholder ("(blob missing: sha256:abc123...)"). Surface a file-corruption warning. Continue loading other content. | Operator can attempt git-restore of an earlier file revision. |
| F5 | `metadata.rts.blobs[<key>].data`'s SHA-256 hash != `<key>` | Reject load. File is corrupted beyond safe interpretation. | Operator restores from git or accepts data loss and loads with `--ignore-blob-integrity` (V2 flag). |
| F6 | `cells[*].metadata.rts.trace_id` references no spans in `event_log.runs[]` | Tolerate. Render the cell as untouched. Not an error. | None. Common during edit-and-resend before the new cell has executed. |
| F7 | `event_log.runs[]` references unknown `llmnb.cell_id` | Tolerate. The orphaned run still appears in the event log but no cell shows it. | Replay harness flags as orphaned-run anomaly. |
| F8 | `cells[*].metadata.rts.target_agent` references an `agent_id` not in `config.agents[]` | Cell renders with an "orphaned agent" indicator. Operator may re-spawn or remove. | Surfaced via the sidebar Activity Bar; not blocking. |
| F9 | Layout tree contains duplicate `id` anywhere in the subtree | Reject load. Tree integrity violation. | File is corrupt; restore from git. |
| F10 | Agent graph edge references nonexistent node | Reject load with a clear "graph integrity violation: edge {source}→{target} kind={kind}" message. | File is corrupt; restore from git. |
| F11 | OTLP/JSON attribute encoding uses flat-object form `{"key":"value"}` instead of `[{key,value:{stringValue}}]` | Reject load with "non-conformant OTLP encoding" error. | Writer bug in older client; upgrade kernel. |
| F12 | `startTimeUnixNano` or `endTimeUnixNano` is a JSON number instead of a string | Tolerate-with-warning. Convert to string on next write. (Note: this is a common bug in JS-based writers because Number coercion is automatic.) | Writer SHOULD be fixed; reader's tolerance is a transition-period concession. |
| F13 | `notebook.metadata` queue overflow at the kernel (>10 000 entries with no extension attached) | Kernel writes a checkpoint marker and direct-writes once. Logs a "queue overflow; direct-write fallback" warning. | Operator sees the file has changed under VS Code on next reconnect; VS Code prompts to reload. |
| F14 | Volatile field drift detected on file load (`config.volatile.*` differs from current environment) | Append entry to `metadata.rts.drift_log` with `severity: "warn"` (or `"error"` for RFC major mismatch). Surface to operator before resuming agents. | Operator-facing modal listing drift events; "acknowledge and resume" / "investigate" / "discard volatile config and start fresh" actions. |
| F15 | Drift event severity `"error"` (RFC major version mismatch, MCP server unreachable, model unavailable) | Refuse to spawn agents from `config.recoverable.agents[]`. Allow read-only inspection of history. Surface a blocking modal. | Operator must manually update the file's `config` to match the current environment (or migrate the kernel) before resuming. |
| F16 | Volatile field reverts to a previously-persisted value (model bumped 4-5 → 4-6 → 4-5 across two sessions) | Emit a fresh drift event for the second transition. Both events remain in the log; this RFC does not coalesce drift history. | Audit-trail surface; no operator action required unless severity demands it. |

## Worked example

A minimal session: one zone, one agent, two cells, one closed run, one in-progress run, one large blob.

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "rts": {
      "schema_version": "1.0.0",
      "schema_uri": "https://llmnb.dev/llmnb/v1/schema.json",
      "session_id": "9c1a3b2d-4e5f-4061-a072-8d9e3f4a5b6c",
      "created_at": "2026-04-26T12:14:08.221Z",
      "layout": {
        "version": 1,
        "tree": {
          "id": "root",
          "type": "workspace",
          "render_hints": { "label": "monorepo" },
          "children": [
            {
              "id": "zone-refactor",
              "type": "zone",
              "render_hints": { "color": "#4a90e2" },
              "children": [
                { "id": "src/auth/tokens.rs", "type": "file", "render_hints": {}, "children": [] }
              ]
            }
          ]
        }
      },
      "agents": {
        "version": 1,
        "nodes": [
          { "id": "agent:alpha", "type": "agent", "properties": { "status": "busy" } },
          { "id": "zone-refactor", "type": "zone", "properties": {} },
          { "id": "tool:notify", "type": "tool", "properties": {} }
        ],
        "edges": [
          { "source": "agent:alpha", "target": "zone-refactor", "kind": "in_zone", "properties": {} },
          { "source": "agent:alpha", "target": "tool:notify", "kind": "has_tool", "properties": {} }
        ]
      },
      "config": {
        "version": 1,
        "recoverable": {
          "kernel": { "blob_threshold_bytes": 65536 },
          "agents": [
            {
              "agent_id": "alpha",
              "zone_id": "refactor",
              "tools_allowed": ["notify", "report_completion", "ask"]
            }
          ],
          "mcp_servers": [
            { "server_id": "operator-bridge",
              "tools": ["notify", "report_completion", "ask"] }
          ]
        },
        "volatile": {
          "kernel": {
            "model_default": "claude-sonnet-4-5",
            "passthrough_mode": "litellm",
            "rfc_001_version": "1.0.0",
            "rfc_002_version": "1.0.1",
            "rfc_003_version": "2.0.0"
          },
          "agents": [
            {
              "agent_id": "alpha",
              "model": "claude-sonnet-4-5",
              "system_prompt_template_id": "rfc-002-default",
              "system_prompt_hash": "sha256:c4f5e9b8a7d6"
            }
          ],
          "mcp_servers": [
            { "server_id": "operator-bridge", "transport": "stdio" }
          ]
        }
      },
      "event_log": {
        "version": 1,
        "runs": [
          {
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
              { "key": "llmnb.zone_id",  "value": { "stringValue": "refactor" } },
              { "key": "llmnb.cell_id",  "value": { "stringValue": "cell-12" } },
              { "key": "llmnb.touched_files",
                "value": { "arrayValue": { "values": [
                  { "stringValue": "src/auth/tokens.rs" } ] } } },
              { "key": "input.value",
                "value": { "stringValue": "{\"observation\":\"Extracted JWT validator into src/auth/jwt_validator.rs\",\"importance\":\"info\"}" } },
              { "key": "input.mime_type",  "value": { "stringValue": "application/json" } },
              { "key": "output.value",     "value": { "stringValue": "{\"acknowledged\":true}" } },
              { "key": "output.mime_type", "value": { "stringValue": "application/json" } }
            ],
            "events": [],
            "links": []
          },
          {
            "traceId": "9e8f7d6c5b4a39281706fedcba987654",
            "spanId":  "1234567890abcdef",
            "parentSpanId": null,
            "name": "report_progress",
            "kind": "SPAN_KIND_INTERNAL",
            "startTimeUnixNano": "1745589022114000000",
            "endTimeUnixNano":   null,
            "status": { "code": "STATUS_CODE_UNSET", "message": "" },
            "attributes": [
              { "key": "llmnb.run_type", "value": { "stringValue": "tool" } },
              { "key": "tool.name",      "value": { "stringValue": "report_progress" } },
              { "key": "llmnb.agent_id", "value": { "stringValue": "alpha" } },
              { "key": "llmnb.cell_id",  "value": { "stringValue": "cell-13" } },
              { "key": "input.value",    "value": { "stringValue": "$blob:sha256:c4f5e9b8a7d6e3f1c2d4b5a6978876543210abcdef0123456789abcdef0123" } },
              { "key": "input.mime_type", "value": { "stringValue": "application/json" } }
            ],
            "events": [],
            "links": []
          }
        ]
      },
      "blobs": {
        "sha256:c4f5e9b8a7d6e3f1c2d4b5a6978876543210abcdef0123456789abcdef0123": {
          "content_type": "application/json",
          "encoding": "utf-8",
          "size_bytes": 87421,
          "data": "{\"status\":\"...\",\"percent\":42,\"blockers\":[...87KB of detail...]}"
        }
      },
      "drift_log": [
        {
          "detected_at": "2026-04-26T13:22:45.000Z",
          "field_path": "event_log.runs[1].status",
          "previous_value": "STATUS_CODE_UNSET",
          "current_value": "STATUS_CODE_ERROR (kernel restart truncated)",
          "severity": "info",
          "operator_acknowledged": true
        }
      ]
    }
  },
  "cells": [
    {
      "cell_type": "code",
      "id": "cell-12",
      "source": "/spawn alpha task:\"refactor JWT validator\"",
      "metadata": {
        "rts": {
          "trace_id": "5d27f5dd26ce4d619dbb9fbf36d2fe2b",
          "target_agent": "alpha"
        }
      },
      "outputs": [
        {
          "output_type": "display_data",
          "data": {
            "application/vnd.rts.run+json": { "$ref": "metadata.rts.event_log.runs[0]" }
          },
          "metadata": { "display_id": "8a3c1a2e9d774f0a" }
        }
      ]
    },
    {
      "cell_type": "code",
      "id": "cell-13",
      "source": "/continue alpha",
      "metadata": {
        "rts": {
          "trace_id": "9e8f7d6c5b4a39281706fedcba987654",
          "target_agent": "alpha"
        }
      },
      "outputs": [
        {
          "output_type": "display_data",
          "data": {
            "application/vnd.rts.run+json": { "$ref": "metadata.rts.event_log.runs[1]" }
          },
          "metadata": { "display_id": "1234567890abcdef" }
        }
      ]
    }
  ]
}
```

(The `"$ref"` notation in the example above is illustrative; in the actual file, the cell output carries the same span object verbatim. The cell-output span and the `event_log` span MUST be byte-identical to within JSON serialization noise.)

Reading this file:

1. Layout tree shows a `monorepo` workspace with one `zone-refactor` zone containing `src/auth/tokens.rs`.
2. Agent graph shows `agent:alpha` busy in zone `refactor`, with `notify` as one of its tools. (`properties.status: "busy"` is volatile — the kernel will re-evaluate against the current process state on load and may emit a drift event.)
3. Config separates recoverable (zone bindings, tool restrictions, blob threshold) from volatile (model, RFC versions, system-prompt hash). On resume, the kernel checks each volatile field against the current environment and emits drift events for mismatches.
4. Event log shows two runs: one closed `notify` call in cell-12 (recoverable; loaded verbatim) and one in-progress `report_progress` in cell-13 whose input was large enough to spill into a content-addressed blob (volatile; truncated on resume with a drift event).
5. Cells reference their runs by `trace_id`; outputs carry the same OTLP spans as `event_log` for in-cell rendering.
6. The `drift_log` shows that a previous load already detected and acknowledged the cell-13 truncation. No re-prompt on subsequent loads unless the same field drifts again.

On resume after a kernel crash mid-`report_progress`:

- The kernel detects the in-progress span (cell-13's run, `endTimeUnixNano: null`).
- It truncates: sets `endTimeUnixNano` to current wall-clock, `status.code: "STATUS_CODE_ERROR"`, message `"kernel restart truncated"`.
- It appends a fresh entry to `drift_log` with `severity: "info"` (or skips if the same field is already acknowledged in the log).
- The operator sees the truncated run in cell-13's output; they may re-execute the cell to retry.

If the operator has updated their kernel between sessions and `rfc_001_version` jumped from `1.0.0` to `1.1.0`, the kernel emits a `drift_log` entry with `severity: "warn"` and surfaces a banner: "RFC-001 advanced from 1.0.0 to 1.1.0 (additive); resume safely?" If `rfc_001_version` jumped to `2.0.0`, the entry's severity is `"error"`, agents are read-only, and a blocking modal appears.

## Consumers

- **LLMKernel `metadata_writer` module (new in V1):** the single logical writer of `metadata.rts`. Emits `notebook.metadata` snapshots over RFC-003 v2 envelopes; does not write to disk directly except in the queue-overflow fallback path.
- **VS Code extension `serializer.ts`:** the physical writer. Receives `metadata.rts` snapshots from the extension's message router and applies them via `vscode.NotebookEdit.updateNotebookMetadata`. Must preserve unknown keys verbatim on round-trip.
- **VS Code extension `notebook/controller.ts`:** reads cell-level `metadata.rts` (`trace_id`, `target_agent`) on cell execution.
- **Renderer `extension/src/renderers/run-renderer.ts`:** reads each cell-output OTLP span and dispatches on `attributes["llmnb.run_type"]` to the appropriate component.
- **Replay harness (RFC-004):** reads `metadata.rts.event_log` and replays runs through a mock extension. The line-oriented serialization is what makes the replay harness a JSON walker rather than a streaming parser.
- **`pixi run kernel-gc` task (V1 manual GC):** walks `event_log.runs[*]` for `$blob:` references, marks-and-sweeps `metadata.rts.blobs`.
- **Drift detector (kernel module on file open):** scans `config.volatile.*`, `agents.nodes[*].properties.status`, and in-progress `event_log.runs[*]`; emits drift events to `metadata.rts.drift_log`; surfaces unacknowledged drift to the operator before resuming agent execution.
- **Drift surface (extension UI):** renders the drift log as a banner / modal with per-event acknowledgment. Acknowledgments persist back to `metadata.rts.drift_log[*].operator_acknowledged: true`.
- **Standard tooling:** nbdime / git diff. They rely on line-oriented serialization for human-readable diffs.

## Open issues queued for amendment

| Issue | Surfaced by | Disposition |
|---|---|---|
| `metadata.rts.layout.tree` and `metadata.rts.agents` could grow large for long sessions; in-place mutation with line-oriented serialization may not be enough. | Anticipated future scale. | V1.5 may introduce per-substructure JSON-Patch wire encoding while keeping the persistent form as a full snapshot. RFC-005 v1.1.0 reserved. |
| Binary content support for tool outputs (images, PDFs, archives). | Tools that produce binary outputs are deferred. | V2 introduces `.llmnb-objects/` sidecar storage following git-LFS semantics. |
| Multiple sessions per file (long-running workspaces with many distinct sessions persisted side-by-side). | Operator workflow not yet observed in V1. | V2 promotes `session_id` to an array of `sessions[]` entries; the V1 single-session form is then a special case (sessions[0]). |
| Auto-GC of orphaned blobs on save. | Manual GC may grow operator burden. | V2 auto-GCs on save when blob count exceeds a configurable threshold. |

## Source

- ADR: [DR-0009 — VS Code NotebookController API; no Jupyter kernel](../decisions/0009-notebook-controller-no-jupyter-kernel.md)
- ADR: [DR-0014 — three storage structures embedded in one .llmnb file](../decisions/0014-three-storage-structures-embedded.md)
- ADR: [DR-0016 — RFC-driven standards discipline](../decisions/0016-rfc-standards-discipline.md)
- Dev-guide chapter: [07 — Subtractive fork and storage](../dev-guide/07-subtractive-fork-and-storage.md) (storage structures + ipynb derivation rationale)
- Sibling RFCs: [RFC-001](RFC-001-mcp-tool-taxonomy.md) (referenced by `config.kernel.rfc_001_version`), [RFC-002](RFC-002-claude-code-provisioning.md) (referenced by `config.agents[*].system_prompt_template_id`), [RFC-003](RFC-003-custom-message-format.md) (wire form; this RFC is the persistent counterpart), [RFC-004](RFC-004-failure-modes.md) (replay harness consumes this format)
- External: [opentelemetry-proto OTLP/JSON encoding](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md), [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), [OpenInference conventions](https://github.com/Arize-ai/openinference)
