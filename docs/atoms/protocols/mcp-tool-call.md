# Protocol: MCP tool call (RFC-001)

**Status**: `protocol` (V1 shipped, RFC-001 v1.0.1)
**Family**: outside the RFC-006 Comm — JSON-RPC over the kernel's MCP server
**Direction**: agent ↔ kernel ↔ extension (paper-telephone via DR-0015)
**Source specs**: [RFC-001 §"Common conventions"](../../rfcs/RFC-001-mcp-tool-taxonomy.md#common-conventions), [RFC-001 §"Native tools"](../../rfcs/RFC-001-mcp-tool-taxonomy.md#native-tools), [RFC-001 §"Failure modes"](../../rfcs/RFC-001-mcp-tool-taxonomy.md#failure-modes)
**Related atoms**: [tool-call](../concepts/tool-call.md), [span](../concepts/span.md), [protocols/family-a-otlp-spans](family-a-otlp-spans.md), [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md)

## Definition

The MCP tool call is the **agent-to-operator wire**: agents emit JSON-RPC tool calls (`tools/list`, `tools/call`) against the kernel's in-process MCP server; the kernel validates against the RFC-001 schema, dispatches the call (native handler or paper-telephone forward to the extension), emits a Family A run record, and returns a structured JSON-RPC response. Per DR-0010, structured tool calls are the SOLE agent-to-operator surface — free-form text is suppressed at the system-prompt level.

## Wire shape

```jsonc
// agent → kernel (JSON-RPC request)
{
  "jsonrpc": "2.0",
  "id":      47,
  "method":  "tools/call",
  "params":  {
    "name":      "request_approval",
    "arguments": {
      "_rfc_version": "1.0.0",                      // optional; defaults to "1.0.0"
      "action":       "extract validateJwt() ...",
      "diff_preview": { "kind": "unified_diff", "body": "..." },
      "risk_level":   "medium"
    }
  }
}

// kernel → agent (JSON-RPC response)
{
  "jsonrpc": "2.0",
  "id":      47,
  "result":  {
    "_rfc_version": "1.0.0",
    "run_id":       "7c3f8e2a-...",                 // UUIDv4 correlating to the run record
    "decision":     "approve"
  }
}
```

Every input schema is JSON Schema Draft-2020-12 with `additionalProperties: false`. Every result envelope MUST carry `_rfc_version` and a kernel-assigned `run_id` (UUIDv4) correlating to the LangSmith / event-log run.

## V1 catalog (13 tools)

Native (10): `ask`, `clarify`, `propose`, `request_approval`, `report_progress`, `report_completion`, `report_problem`, `present`, `notify`, `escalate`. Proxied (3): `read_file`, `write_file`, `run_command`. Per RFC-001 §"Specification" no tool not in this catalog MAY be exposed to V1 agents.

## Schema-version handshake

Per-call: optional `_rfc_version` field (default `"1.0.0"`); explicit-mismatch returns `-32001` with `data.expected` / `data.received`. Catalog-level: `tools/list` returns the kernel-registered tool set; an agent attempting to call an unknown tool gets `-32601` (method not found).

## Error envelope (JSON-RPC error codes)

| Code   | Meaning |
|---|---|
| `-32001` | Schema validation failure (with `data.violations` listing JSON Pointers) |
| `-32002` | Operator response timeout (blocking tools only) |
| `-32003` | Operator denied/withdrew |
| `-32004` | Extension unreachable (paper-telephone broken) |
| `-32005` | Proxied operation refused by policy |
| `-32006` | Proxied operation underlying I/O failure |
| `-32601` | Method not found (unknown tool) |

Failure posture per RFC-001 §"Failure modes": V1 fails closed. Unknown tools rejected outright. Timeouts surface as typed tool errors back to the agent. Paper-telephone breaks are recoverable: the kernel buffers run records during disconnect and replays them on extension reconnect.

## Run-record integration

Every invocation emits a Family A span (see [protocols/family-a-otlp-spans](family-a-otlp-spans.md)) with `attributes["llmnb.run_type"] = "tool"`, `tool.name = <name>`, `llmnb.agent_id = <agent>`. The span's `spanId` IS the `run_id` returned in the JSON-RPC response, so the agent can correlate its result with the operator-visible run.

## V1 vs V2+

- **V1**: thirteen tools fixed; per-zone policy MAY auto-approve `risk_level=low`.
- **V2+**: capability tokens (`read_files`, `write_files`, etc. per [decisions/capabilities-deferred-v2](../decisions/capabilities-deferred-v2.md)) gate tool availability per agent; new tools added via additive RFC-001 minor bump.

## See also

- [tool-call](../concepts/tool-call.md) — the span-shape definition this protocol produces on the wire.
- [protocols/family-a-otlp-spans](family-a-otlp-spans.md) — every tool call generates a Family A span.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — tool calls live as spans on the parent turn, never as their own cells.
- [decisions/capabilities-deferred-v2](../decisions/capabilities-deferred-v2.md) — V1 ships no capability tokens.
