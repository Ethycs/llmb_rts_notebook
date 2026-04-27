# RFC-001 — V1 MCP tool taxonomy

## Status

Draft. Date: 2026-04-27. Version: 1.0.1.

This RFC is the layer-6 normative specification for the kernel-extension MCP surface, per [chapter 08](../dev-guide/08-blockers-mediator-standards.md). It MUST be accepted before any kernel MCP server registration code is merged. Conforming implementations attach to this exact version string; deviations require an RFC update, not a code workaround.

**Changelog**:
- v1.0.1 (additive): added two optional input fields to two tools — `report_completion.task_id` (string, optional) for once-per-task idempotency tracking, and `present.artifact_id` (string, optional) for artifact-update idempotency. Both fields are required by RFC-001 §"Native tools" behavioral semantics ("idempotent at most once per task", "idempotent under (artifact.uri, body-hash)"); v1.0.0 did not document them in input schemas. V1 implementations track these fields per K-MCP's mega-round implementation.
- v1.0.0: initial draft.

## Context

[DR-0008](../decisions/0008-bidirectional-mcp-as-comm-channel.md) makes bidirectional MCP the chat protocol: tools are conversation primitives, not capability extensions. [DR-0010](../decisions/0010-force-tool-use-suppress-text.md) suppresses the agent's free-form text channel at the system-prompt level, leaving structured MCP tool calls as the SOLE agent-to-operator surface. [DR-0015](../decisions/0015-kernel-extension-bidirectional-mcp.md) places that MCP server inside LLMKernel, the paper-telephone mediator.

Together these decisions make the agent's communicative grammar identical to this tool catalog: get the taxonomy wrong and the agent cannot express categories of intent the operator surface needs to render. This RFC locks the V1 catalog at thirteen tools — ten native operator-interaction primitives and three proxied system tools. Every tool listed below MUST be implemented before V1 ships. No tool not listed here MAY be exposed to V1 agents.

## Specification

### Common conventions

All input schemas are JSON Schema Draft-2020-12. All inputs MUST include an optional `_rfc_version` string defaulting to `"1.0.0"`; agents SHOULD omit it and validators MUST accept omission. Protocol-level negotiation is deferred to RFC-003. JSON-RPC error codes use the `-32000` server-error band:

- `-32001` schema validation failure; `-32002` operator response timeout; `-32003` operator denied/withdrew
- `-32004` extension unreachable (paper-telephone broken); `-32005` proxied operation refused by policy
- `-32006` proxied operation underlying I/O failure; `-32601` method not found (unknown tool)

Every tool result envelope (success or error) MUST carry `_rfc_version` and a kernel-assigned `run_id` (UUID v4) correlating to the LangSmith run record.

### Native tools

The ten tools below are implemented directly inside LLMKernel. Each invocation MUST emit a LangSmith run record (POST `run.start`, zero or more `run.event`, terminal `run.complete` or `run.error`) before the kernel returns the tool result to the agent.

#### ask

Operator-targeted free-form question. The agent SHALL use `ask` when it needs information that cannot be expressed as a closed option set. Blocks the agent until the operator answers or the call times out.

Input schema (all schemas in this RFC use `$schema: "https://json-schema.org/draft/2020-12/schema"` and `additionalProperties: false`; omitted below for brevity):

```json
{
  "type": "object", "required": ["question"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "question": { "type": "string", "minLength": 1 },
    "context": { "type": "string" },
    "options": { "type": "object", "properties": {
      "timeout_ms": { "type": "integer", "minimum": 0, "default": 600000 },
      "allow_followup": { "type": "boolean", "default": true }
    } }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["answer", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "answer": { "type": "string" },
    "answered_at": { "type": "string", "format": "date-time" }
  }
}
```

Errors: `-32001` schema validation, `-32002` operator timeout, `-32004` extension unreachable.

Semantic notes: NOT idempotent. No external side effects. Default operator response budget 10 minutes. Blocking.

Example: request `{"question":"Which JWT secret store should I read from?","context":"src/auth/tokens.rs has two candidates."}` returns `{"answer":"vault.kv.tokens","run_id":"…","answered_at":"2026-04-26T14:02:11Z"}`.

#### clarify

Typed clarification with a discrete option set. The agent SHALL prefer `clarify` over `ask` whenever the answer space is enumerable; this allows the renderer to surface a radio picker instead of a free-text box.

Input schema:

```json
{
  "type": "object", "required": ["question", "options"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "question": { "type": "string", "minLength": 1 },
    "options": { "type": "array", "minItems": 2, "items": {
      "type": "object", "required": ["id", "label"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9_]+$" },
        "label": { "type": "string" },
        "description": { "type": "string" }
      }
    } },
    "default_id": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 0, "default": 600000 }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["selected_id", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "selected_id": { "type": "string" },
    "free_text": { "type": "string" }
  }
}
```

Errors: `-32001`, `-32002`, `-32004`.

Semantic notes: NOT idempotent (the operator's selection is the side effect). Blocking. The renderer SHOULD honor `default_id` as the pre-selected radio.

Example: `{"question":"Inline or extract?","options":[{"id":"inline","label":"Inline at call site"},{"id":"extract","label":"Extract to module"}]}` → `{"selected_id":"extract","run_id":"…"}`.

#### propose

A coarse-grained operation needing operator attention but not necessarily a hard approval gate. Richer than `request_approval`: carries a rationale and may include a non-binary scope (e.g. "per-zone", "per-file", "session"). Agents SHOULD use `propose` for design-level decisions and `request_approval` for executable operations.

Input schema:

```json
{
  "type": "object", "required": ["action", "rationale"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "action": { "type": "string", "minLength": 1 },
    "rationale": { "type": "string", "minLength": 1 },
    "preview": { "type": "object", "properties": {
      "kind": { "type": "string", "enum": ["text", "diff", "plan", "code", "json"] },
      "body": { "type": "string" }
    } },
    "scope": { "type": "string", "enum": ["one_shot", "this_file", "this_zone", "session"], "default": "one_shot" },
    "timeout_ms": { "type": "integer", "minimum": 0, "default": 1800000 }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["decision", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "decision": { "type": "string", "enum": ["accept", "reject", "modify", "defer"] },
    "modification": { "type": "string" },
    "scope_granted": { "type": "string", "enum": ["one_shot", "this_file", "this_zone", "session"] }
  }
}
```

Errors: `-32001`, `-32002`, `-32003`, `-32004`.

Semantic notes: NOT idempotent. No direct side effects (the agent acts on the response). Blocking. Default budget 30 minutes; design decisions are slower than approvals.

Example: `{"action":"adopt repository pattern for token store","rationale":"…","scope":"this_zone"}` → `{"decision":"accept","scope_granted":"this_zone","run_id":"…"}`.

#### request_approval

Hard gate before the agent performs an executable operation. The operator MUST act (or time out) before the agent proceeds.

Input schema:

```json
{
  "type": "object", "required": ["action", "diff_preview", "risk_level"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "action": { "type": "string", "minLength": 1 },
    "diff_preview": { "type": "object", "required": ["kind", "body"], "properties": {
      "kind": { "type": "string", "enum": ["unified_diff", "text", "code", "command"] },
      "body": { "type": "string" }, "file_a": { "type": "string" }, "file_b": { "type": "string" }
    } },
    "risk_level": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
    "alternatives": { "type": "array", "items": { "type": "object", "required": ["label", "description"],
      "properties": { "label": { "type": "string" }, "description": { "type": "string" } } } },
    "timeout_ms": { "type": "integer", "minimum": 0, "default": 1800000 }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["decision", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "decision": { "type": "string", "enum": ["approve", "approve_with_modification", "deny", "defer"] },
    "modification": { "type": "string" },
    "alternative_label": { "type": "string" }
  }
}
```

Errors: `-32001`, `-32002`, `-32003`, `-32004`.

Semantic notes: NOT idempotent. The decision itself is the side effect. Blocking. Per-zone policy MAY auto-approve `risk_level=low` calls; auto-approval MUST still emit a run record. The renderer MUST surface a "Show diff" affordance that delegates to VS Code's diff editor when `kind=unified_diff`.

Example: `{"action":"extract validateJwt() to src/auth/jwt.rs","diff_preview":{"kind":"unified_diff","body":"…"},"risk_level":"medium"}` → `{"decision":"approve","run_id":"…"}`.

#### report_progress

Status update during long-running work. Non-blocking: the agent MAY continue immediately after the call returns.

Input schema:

```json
{
  "type": "object", "required": ["status"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "status": { "type": "string", "minLength": 1 },
    "percent": { "type": "number", "minimum": 0, "maximum": 100 },
    "blockers": { "type": "array", "items": { "type": "string" } },
    "display_id": { "type": "string" }
  }
}
```

Output schema (the same `acknowledged`/`run_id` shape recurs for `report_completion`, `report_problem`, `notify`, `escalate`):

```json
{
  "type": "object", "required": ["acknowledged", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "acknowledged": { "type": "boolean", "const": true }
  }
}
```

Errors: `-32001`, `-32004`.

Semantic notes: Idempotent within a `display_id`. No side effects beyond rendering. Non-blocking. Reusing `display_id` MUST update the existing rendered widget rather than appending a new one.

Example: `{"status":"reading auth module","percent":40,"display_id":"alpha-progress-1"}` → `{"acknowledged":true,"run_id":"…"}`.

#### report_completion

Final completion signal for a unit of agent work. The agent SHALL emit exactly one `report_completion` per task before returning control to the operator.

Input schema:

```json
{
  "type": "object", "required": ["summary"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "summary": { "type": "string", "minLength": 1 },
    "artifacts": { "type": "array", "items": { "type": "object", "required": ["uri", "kind"],
      "properties": {
        "uri": { "type": "string" },
        "kind": { "type": "string", "enum": ["file", "diff", "plan", "url", "log"] },
        "title": { "type": "string" }
      } } },
    "outcome": { "type": "string", "enum": ["success", "partial", "aborted"], "default": "success" }
  }
}
```

Output schema: the shared `acknowledged`/`run_id` shape from `report_progress`.

Errors: `-32001`, `-32004`.

Semantic notes: Idempotent at most once per task; second call MUST raise `-32001`. Marks the cell complete in the extension. Non-blocking.

#### report_problem

Blocking issue the agent encountered. Distinct from `escalate`: `report_problem` documents a fault; `escalate` demands operator attention now.

Input schema:

```json
{
  "type": "object", "required": ["severity", "description"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "severity": { "type": "string", "enum": ["info", "warning", "error", "fatal"] },
    "description": { "type": "string", "minLength": 1 },
    "suggested_remediation": { "type": "string" },
    "related_artifacts": { "type": "array", "items": { "type": "string" } }
  }
}
```

Output schema: shared `acknowledged`/`run_id` shape.

Errors: `-32001`, `-32004`.

Semantic notes: Idempotent. No side effects beyond logging and rendering. Non-blocking. `severity=fatal` SHOULD be paired with a subsequent `report_completion` with `outcome=aborted`.

#### present

Generated content lifted to the artifacts surface. Agents SHALL use `present` rather than embedding code or plans inside `report_progress`.

Input schema:

```json
{
  "type": "object", "required": ["artifact", "kind", "summary"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "artifact": { "type": "object", "required": ["body"], "properties": {
      "body": { "type": "string" }, "uri": { "type": "string" }, "language": { "type": "string" },
      "encoding": { "type": "string", "enum": ["utf-8", "base64"], "default": "utf-8" }
    } },
    "kind": { "type": "string", "enum": ["code", "plan", "diff", "doc", "json", "image"] },
    "summary": { "type": "string", "minLength": 1 }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["artifact_id", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "artifact_id": { "type": "string" }
  }
}
```

Errors: `-32001`, `-32004`.

Semantic notes: Idempotent under the same `(artifact.uri, body-hash)` pair. Side effect: artifact appears in the sidebar. Non-blocking.

#### notify

Fire-and-forget annotation. Used for observations that do not require operator action and SHOULD NOT interrupt.

Input schema:

```json
{
  "type": "object", "required": ["observation", "importance"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "observation": { "type": "string", "minLength": 1 },
    "importance": { "type": "string", "enum": ["trace", "info", "warn"] },
    "tags": { "type": "array", "items": { "type": "string" } }
  }
}
```

Output schema: shared `acknowledged`/`run_id` shape.

Errors: `-32001`, `-32004`.

Semantic notes: Idempotent. No side effects. Non-blocking. Per-zone policy MAY rate-limit `notify`; rate-limiting MUST surface an `-32005` rather than silently dropping.

#### escalate

Demands operator attention urgently. The renderer MUST raise the operator's notification surface (sound, badge, panel focus) rather than appending quietly.

Input schema:

```json
{
  "type": "object", "required": ["reason", "severity"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "reason": { "type": "string", "minLength": 1 },
    "severity": { "type": "string", "enum": ["medium", "high", "critical"] },
    "context": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 0, "default": 300000 }
  }
}
```

Output schema: the shared `acknowledged`/`run_id` shape extended with an optional `operator_response: string`.

Errors: `-32001`, `-32002`, `-32004`.

Semantic notes: NOT idempotent (each escalation re-rings the alarm). Blocking up to `timeout_ms`; an unanswered escalate STILL acknowledges (so the agent does not deadlock) but the timeout MUST be logged. The kernel MUST detect escalate floods (more than five `severity=critical` in 60 seconds from one agent) and rate-limit with `-32005`.

### Proxied tools

The three tools below mediate real implementations. The kernel MUST log every call with full arguments BEFORE forwarding, and log the result on return. Per-zone policy MAY refuse a proxied call with `-32005`; refusal MUST NOT forward the call to the underlying implementation.

#### read_file

Returns file contents from the workspace.

Input schema:

```json
{
  "type": "object", "required": ["path"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "path": { "type": "string", "minLength": 1 },
    "encoding": { "type": "string", "enum": ["utf-8", "base64"], "default": "utf-8" },
    "max_bytes": { "type": "integer", "minimum": 1, "default": 1048576 }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["content", "encoding", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "content": { "type": "string" },
    "encoding": { "type": "string", "enum": ["utf-8", "base64"] },
    "truncated": { "type": "boolean" },
    "size_bytes": { "type": "integer", "minimum": 0 }
  }
}
```

Errors: `-32001`, `-32005` (path outside workspace or denied), `-32006` (file not found, permission denied, I/O failure).

Semantic notes: Idempotent. No side effects. Non-blocking (synchronous from the agent's view but does not require operator response). Paths MUST be resolved against the zone workspace root; absolute paths outside the root MUST be rejected with `-32005`.

Example: `{"path":"src/auth/tokens.rs"}` → `{"content":"…","encoding":"utf-8","truncated":false,"size_bytes":2048,"run_id":"…"}`.

#### write_file

Writes file contents inside the workspace. V1 MAY require `request_approval` before write; that policy is per-zone and not normative in this RFC.

Input schema:

```json
{
  "type": "object", "required": ["path", "content"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "path": { "type": "string", "minLength": 1 },
    "content": { "type": "string" },
    "encoding": { "type": "string", "enum": ["utf-8", "base64"], "default": "utf-8" },
    "mode": { "type": "string", "enum": ["create", "overwrite", "append"], "default": "overwrite" }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["bytes_written", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "bytes_written": { "type": "integer", "minimum": 0 },
    "created": { "type": "boolean" }
  }
}
```

Errors: `-32001`, `-32005` (path policy denial), `-32006` (I/O failure, mode=create with existing file).

Semantic notes: NOT idempotent. Side effect: workspace mutation. Non-blocking. The kernel MUST snapshot the prior contents in the run record so the operation is replayable and reversible.

#### run_command

Executes a shell command in the zone workspace. V1 sandbox posture is "trust the kernel's policy"; bubblewrap and friends are deferred (DR-0005). Per-zone policy SHOULD force `request_approval` for any non-allowlisted command.

Input schema:

```json
{
  "type": "object", "required": ["command"],
  "properties": {
    "_rfc_version": { "type": "string", "default": "1.0.0" },
    "command": { "type": "string", "minLength": 1 },
    "args": { "type": "array", "items": { "type": "string" } },
    "cwd": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1, "default": 60000 },
    "env": { "type": "object", "additionalProperties": { "type": "string" } }
  }
}
```

Output schema:

```json
{
  "type": "object", "required": ["exit_code", "stdout", "stderr", "run_id"],
  "properties": {
    "_rfc_version": { "type": "string" },
    "run_id": { "type": "string", "format": "uuid" },
    "exit_code": { "type": "integer" },
    "stdout": { "type": "string" }, "stderr": { "type": "string" },
    "timed_out": { "type": "boolean" },
    "duration_ms": { "type": "integer", "minimum": 0 }
  }
}
```

Errors: `-32001`, `-32005` (command policy denial), `-32006` (spawn failure, signal kill).

Semantic notes: NOT idempotent in general. Side effect: arbitrary. Non-blocking from the operator's view but MAY block the agent up to `timeout_ms`. The kernel MUST capture stdout and stderr in the run record verbatim.

## Backward-compatibility analysis

This RFC ships at version 1.0.0. Future changes are classified per the docket README's three classes:

**Additive changes** preserve compatibility with existing agents and renderers. Permitted without major-version bump:

- Adding a new optional input field with a documented default.
- Adding a new tool to the catalog.
- Adding a new variant to an enum used in *option* lists (e.g. extending `propose.scope` with `"global"`). Adding a variant to an enum used in *required output discriminators* is breaking, not additive.
- Loosening a `minLength`, raising a `maximum`, or relaxing a `pattern`.
- Adding new error codes in the `-32000` server-error band.

**Deprecating changes** mark a field or tool obsolete while the kernel still honors it for one major version. Permitted under a minor-version bump:

- Marking a tool as deprecated (kernel logs a warning on each call; agents still see it in the catalog).
- Marking a field as deprecated (validators accept and forward; agents are migrated by RFC-002 system-prompt updates).
- A deprecation note MUST include a migration target tool/field and a removal version.

**Breaking changes** require a major-version bump (RFC-001 v2.0.0) and a migration note:

- Renaming a field, changing a field's type, removing a field.
- Tightening validation (raising `minLength`, narrowing an enum, adding a required field).
- Changing the semantics of an existing field or tool while preserving the name.
- Removing a tool from the catalog (deprecation MUST precede removal).
- Reassigning a JSON-RPC error code.

**Version signaling.** Every input schema in this RFC includes the optional `_rfc_version` field defaulting to `"1.0.0"`. Agents SHOULD omit it; kernel validators MUST accept omission. Mismatched explicit versions MUST be rejected with `-32001` carrying a structured `data.expected` and `data.received` payload. Protocol-level negotiation between kernel and extension (capability handshake, multi-version coexistence) is deferred to RFC-003; this RFC commits only to the per-call signaling field.

## Failure modes

The table summarizes the four canonical failure surfaces every V1 tool MUST handle. "Caller" means the agent for the agent-facing tool calls.

| Failure | Native blocking tools (`ask`, `clarify`, `propose`, `request_approval`, `escalate`) | Native non-blocking tools (`report_progress`, `report_completion`, `report_problem`, `present`, `notify`) | Proxied tools (`read_file`, `write_file`, `run_command`) | Unknown tool |
|---|---|---|---|---|
| Operator never responds | Tool returns `-32002` after `timeout_ms`; run record terminates `run.error`. `escalate` returns success with logged unanswered marker. | N/A — no operator response expected. | N/A — proxied tools do not block on operator. | N/A. |
| Input schema validation fails | `-32001` with `data.violations` listing JSON Pointers; no run record beyond `run.start` + immediate `run.error`. | `-32001` as above. | `-32001` as above; underlying impl MUST NOT be invoked. | `-32601` (not even validated). |
| Kernel cannot reach extension (paper-telephone broken) | `-32004`; agent receives error; kernel buffers `run.start` for replay; extension reconnect triggers `run.error` finalization. | `-32004`; non-blocking tools fail closed (no silent drops). | `-32004` only for the user-visible logging side; the underlying I/O MAY proceed if the kernel can complete it locally, but the run record MUST be marked `delivery=pending`. | N/A. |
| Agent calls tool not in V1 catalog | `-32601` `MethodNotFound`; no run record; kernel emits a `run.policy` audit event naming the unknown tool and the calling agent. | Same. | Same. | Same. |

Overall posture: V1 fails closed. Unknown tools are rejected outright. Timeouts surface as typed tool errors back to the agent rather than as silent hangs; the agent's system prompt (RFC-002) instructs recovery from `-32002`. Suppressed-text leakage (the agent emitting prose despite DR-0010) is logged at the LiteLLM endpoint but NOT raised to the operator unless an `escalate` flood is detected, in which case the kernel rate-limits with `-32005` and surfaces a single operator notification rather than the flood. Paper-telephone breaks are recoverable: the kernel buffers run records during disconnect and replays them on extension reconnect, with each leg's MCP layer responsible for at-least-once delivery and the run-tracker responsible for idempotent merging.

## Worked example

This walks through a complete `request_approval` round trip end-to-end. Agent `alpha` is in zone `refactor`, mid-task on extracting a JWT validator.

1. Agent emits the JSON-RPC call to its MCP client, which dispatches to the kernel's MCP server:

```json
{
  "jsonrpc": "2.0", "id": 47, "method": "tools/call",
  "params": { "name": "request_approval", "arguments": {
    "action": "extract validateJwt() to src/auth/jwt.rs",
    "diff_preview": { "kind": "unified_diff", "file_a": "src/auth/tokens.rs", "file_b": "src/auth/jwt.rs",
      "body": "@@ -42,18 +0,0 @@\n-fn validate_jwt(...) { ... }\n@@ +0,0 +1,18 @@\n+pub fn validate_jwt(...) { ... }\n" },
    "risk_level": "medium",
    "alternatives": [ { "label": "inline", "description": "Keep validator inline; no module boundary." } ]
  } }
}
```

2. Kernel validates against the schema in this RFC; validation succeeds. Kernel allocates `run_id = 7c3f…` and POSTs `run.start` to the run-tracker. The run-tracker emits a kernel→extension lifecycle event (RFC-003 envelope, message types referenced abstractly: the kernel emits a run-lifecycle event over the custom Jupyter messaging layer with `display_id` set so the cell renders in place).

3. Kernel calls into the extension's MCP server via the bidirectional channel from DR-0015, invoking the extension-side tool that surfaces an approval card. The extension renders an approval card in the cell output bound to `run_id 7c3f…`. The card carries an inline "Show diff" button that delegates to `vscode.diff` against the embedded `diff_preview`.

4. Operator clicks Approve. Extension calls back into the kernel's MCP server (the `resolve_approval` direction is part of the kernel-side surface defined in this RFC implicitly via the response shape; the extension's call payload is `{"run_id":"7c3f…","decision":"approve"}`).

5. Kernel posts `run.complete` to the run-tracker, marks the originally suspended `tools/call` as ready, and returns the JSON-RPC response to the agent:

```json
{ "jsonrpc": "2.0", "id": 47, "result": { "_rfc_version": "1.0.0", "run_id": "7c3f8e2a-…", "decision": "approve" } }
```

6. Agent receives the typed approval response and continues: it now invokes `write_file` for `src/auth/jwt.rs` and a follow-up `write_file` for the trimmed `src/auth/tokens.rs`. Each `write_file` call follows the same paper-telephone path with its own run record.

If the operator had not responded within `timeout_ms` (default 30 minutes for `request_approval`), step 5 would instead return `{"jsonrpc":"2.0","id":47,"error":{"code":-32002,"message":"operator response timeout","data":{"run_id":"7c3f…","elapsed_ms":1800000}}}`, the run record would terminate `run.error`, and the agent's RFC-002 prompt would instruct it to fall back to `report_problem` with `severity=warning` rather than retry indefinitely.

## Consumers

The following components depend normatively on this RFC. A change classified breaking under the analysis above MUST be coordinated across all of them.

- **Extension MIME renderers** — one renderer per tool name, dispatching on the schemas above. The renderer is a switch on tool name with no parsing.
- **Kernel MCP server registration** — the catalog of tools the kernel registers; each schema in this RFC is the validator for the corresponding tool.
- **Kernel run-tracker** — emits LangSmith-shaped POST/event/PATCH records keyed on the `run_id` field defined here.
- **Agent provisioning system prompt template** — RFC-002 derives its tool-use guidance and recovery instructions (especially around `-32002` timeouts and `-32004` reachability errors) from this catalog.
- **Test harness contract tests** — RFC-004 builds property-based and fault-injection tests against the input/output schemas, error code table, and failure-mode table here.
- **`.llmnb` persistence layer** — cell outputs serialize tool-call records whose schema versions trace back to this RFC's `_rfc_version`.

## Source

- [DR-0008 — bidirectional MCP as comm channel](../decisions/0008-bidirectional-mcp-as-comm-channel.md)
- [DR-0010 — force tool use, suppress text](../decisions/0010-force-tool-use-suppress-text.md)
- [DR-0015 — kernel-extension bidirectional MCP](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- [Dev guide chapter 06 — VS Code notebook substrate](../dev-guide/06-vscode-notebook-substrate.md)
- [Dev guide chapter 08 — blockers, mediator, standards](../dev-guide/08-blockers-mediator-standards.md)
