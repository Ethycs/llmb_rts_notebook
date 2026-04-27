# RFC-007 — `.tape` files (OTLP/JSON Logs for raw kernel observability)

## Status

**Queued.** Date placeholder: 2026-04-26. Version: 0.1.0 (sketch).

This RFC is queued for drafting after RFC-005 + RFC-006 implementation lands. The locked-in design points below capture the architectural decisions made during the RFC-005/006 design conversation; future drafting should treat these as ratified and elaborate the schema, opt-in mechanics, rotation policy, replay semantics, and worked examples.

This file is intentionally a sketch, not a normative spec. Do NOT implement against it.

## Context (sketch)

Operators occasionally need forensic-level visibility into kernel operations: every HTTPS body the kernel saw, every line of agent stdout/stderr, every Jupyter Comm message, every Python kernel log statement. The structured `event_log` in [RFC-005](RFC-005-llmnb-file-format.md) captures the *semantic* layer (OTel spans for runs and tool calls); the layer below — raw bytes, low-level events — is not persisted by V1 unless an operator opts in.

`.tape` files are the opt-in raw-observability layer. They are NOT the operator surface (that's the rendered cells in `.llmnb`); they are NOT the structured semantic layer (that's `metadata.rts.event_log`); they are the **operational layer below both**, intended for developers, on-call, and forensic replay.

The unifying insight from the design conversation: **`.tape` is OTLP/JSON Logs**, line-oriented, with native span correlation back to the trace IDs in `metadata.rts.event_log`. We do not invent a schema; we adopt OTel's standard logs signal and rename it `.tape` for operator UX.

## Locked-in design points (ratified during RFC-005/006 conversation)

These are decided. The eventual full RFC-007 draft elaborates them; it does not relitigate them.

### Format

- **OTLP/JSON Lines.** One [`LogRecord`](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto) per line in OTLP/JSON encoding.
- The tape file is line-oriented (`tail -f`-friendly, JSONL-parseable, indexable).
- File extension: `.tape`. MIME: `application/vnd.llmnb.tape+jsonl`.

### Per-line LogRecord shape

Each line is one OTLP `LogRecord`:

```jsonl
{"timeUnixNano":"<nanos>","observedTimeUnixNano":"<nanos>","severityNumber":<1-24>,"severityText":"INFO|WARN|ERROR|FATAL","body":{"stringValue":"..."},"attributes":[{"key":"event.name","value":{"stringValue":"<event-kind>"}},{"key":"llmnb.source","value":{"stringValue":"<producer>"}},{"key":"llmnb.session_id","value":{"stringValue":"<uuid>"}}],"traceId":"<32-hex or omitted>","spanId":"<16-hex or omitted>"}
```

- `severityNumber` follows OTel spec: 1–4 TRACE, 5–8 DEBUG, **9–12 INFO**, **13–16 WARN**, **17–20 ERROR**, **21–24 FATAL**. Default for kernel info logs: `9`.
- `body` carries the raw line/payload (OpenInference convention: when payload is structured, use `kvlistValue`; otherwise `stringValue`).
- `traceId` + `spanId` are top-level OTel native fields. When the log line belongs to a particular run (an HTTP intercept during an LLM span, or stdout from an agent process producing a tool span), these MUST be set — span correlation is automatic and lets any OTel collector slot the tape lines into the run timeline.
- `attributes["event.name"]` is the typed kind enumeration (see below).
- `attributes["llmnb.source"]` identifies the producer component (e.g., `agent_supervisor:alpha`, `mitm_passthrough:8081`).
- `attributes["llmnb.session_id"]` links to the `.llmnb` `metadata.rts.session_id`.

### `event.name` enumeration

V1 event kinds (additive in minor versions):

- **mitm**: `mitm.request`, `mitm.response`, `mitm.error` — HTTPS flow log entries from the mitmproxy passthrough addon.
- **agent**: `agent.stdout`, `agent.stderr` — line-by-line subprocess output from spawned agents.
- **mcp**: `mcp.request`, `mcp.response` — JSON-RPC frames over the MCP transport.
- **kernel**: `kernel.log` — Python `logging` output from the kernel (stdlib logger redirected to the tape writer).
- **comm**: `comm.inbound`, `comm.outbound` — Jupyter Comm messages crossing the `llmnb.rts.v2` channel (RFC-006 §2).
- **iopub**: `iopub.display_data`, `iopub.update_display_data` — outbound run-lifecycle messages (the same Family A spans, but observed at the wire layer rather than read from `event_log.runs[]`).
- **provisioning**: `provisioning.spawn`, `provisioning.shutdown`, `provisioning.restart` — RFC-002 lifecycle events.
- **autosave**: `autosave.snapshot_emitted`, `autosave.queue_overflow` — RFC-005/006 Family F events.
- **drift**: `drift.detected`, `drift.acknowledged` — RFC-005 drift_log events.

Receivers MUST tolerate unknown `event.name` values per OTel additive-compatibility (V1).

### Opt-in mechanics

- **Default off.** A new `.llmnb` does NOT auto-create a tape. Sessions where the operator doesn't need forensic visibility get no I/O overhead and no privacy footprint.
- **Enable via config.** `metadata.rts.config.recoverable.kernel.tape.enabled: true` (per RFC-005 v1.1.0 — addition reserved). When true, the kernel rotates a tape for that session.
- **Toggle mid-session.** Operator may flip the flag at runtime; the kernel starts/stops the writer cleanly without a restart.
- **Verbatim opt-in (forensic mode).** Even with tapes enabled, default redaction applies. `LLMNB_TAPE_VERBATIM=1` is the explicit forensic-mode opt-in — skip redaction entirely. Intended for developer-side bug reproduction.

### Default redaction

When tapes are enabled but verbatim is OFF (the default-enabled state), the writer applies the same redaction the mitm addon already does:

- HTTP headers: `Authorization`, `X-API-Key`, `Cookie`, `Set-Cookie` redacted to `<first-8>...<last-4>` form.
- HTTP request bodies: leave structurally; redact known secret-shaped fields (`api_key`, `*_token`, `*_secret`).
- HTTP response bodies: leave verbatim (responses don't typically carry secrets).
- Subprocess stdio: leave verbatim (agents shouldn't be emitting secrets; if they do, that's a bug to debug).
- MCP frames, Comm messages: leave verbatim (no secrets expected; failures here are spec violations).

A V1.1 amendment may add per-attribute redaction policies in `config`.

### Storage and pairing

- **Default location.** OS temp directory: `<tmp>/llmnb-tapes/<session_id>.tape`. Implementation aligns with mitm passthrough's existing temp-dir convention.
- **Promote to workspace.** Operator UI exposes a "save tape with notebook" action that copies `<tmp>/llmnb-tapes/<session_id>.tape` to `<workspace>/.llmnb-tapes/<session_id>-<created_at>.tape`. The workspace location is `.gitignore`d by default; the operator opts to commit on a per-tape basis.
- **One tape per session.** Tapes are not shared across sessions. The unit of recording is one kernel session = one `session_id` = one tape (rotated as needed).

### Rotation

- **Size threshold.** Default 64 MiB per segment. Configurable via `config.recoverable.kernel.tape.rotation_size_bytes`.
- **Naming.** Active segment: `<session_id>.tape`. Rotated segments: `<session_id>.tape.1.gz`, `<session_id>.tape.2.gz`, etc. (gzipped on rotation; the active segment is always uncompressed for `tail -f`).
- **Per-segment header.** Each segment opens with one `LogRecord` of `event.name: "tape.segment_started"` carrying the rotation index, the file format version, and any operator-set metadata.

### Replay

`.tape` files are **replayable**: feeding the file to a replay harness reproduces the kernel's structured `event_log` for a session.

- The replay harness opens a stub kernel, replays each tape line in `timeUnixNano` order through the appropriate consumer (mitm intercepts to `flush_into_tracker`-equivalent; stream-json lines to the parser; comm messages to the message router), and produces an `event_log.runs[]` reconstruction.
- Equality between the original `event_log` (in the paired `.llmnb`) and the replayed `event_log` is the integrity invariant. RFC-004's fault-injection harness can use this: a known-good tape + a perturbation = a controlled test for kernel resilience.

This dovetails with RFC-004's replay specification: tapes provide the "known-good event sequences" the harness needs.

### Resource correlation

- One OTel `Resource` per kernel session, emitted as the first record's resource block (or via OTLP/JSON Logs' `resourceLogs` envelope at file head — V1 picks one form during full RFC-007 drafting).
- Resource attributes: `service.name: "llmkernel"`, `service.instance.id: <session_id>`, `service.version: <kernel-version>`, `host.name: <hostname>`, `os.type: <os>`.

### Out of scope for V1 (deferred to V1.5+ amendments)

- Per-attribute redaction policies (V1.1).
- Binary content support in tape body (V2; V1 is text-only via the same constraint as RFC-005 blobs).
- Cross-session tape concatenation tooling (`pixi run tape-merge`) — V1.5.
- Automatic correlation of tape lines into a `.llmnb`'s rendered cells (V2 UI feature).

## Critical files (sketch)

When RFC-007 is drafted in full, these are the implementation surfaces:

- `vendor/LLMKernel/llm_kernel/tape_writer.py` — the OTLP-Logs writer. Subscribes to all the producer surfaces (Python logger handler, mitm addon hook, agent supervisor stdio capture, comm dispatcher, MCP server frames). Produces one `LogRecord` per event; rotates on size threshold; gzips rotated segments.
- `vendor/LLMKernel/llm_kernel/tape_replay.py` — the replay harness. Reads a tape, replays through stub consumers, produces a reconstructed `event_log`.
- `pixi run tape-cat <file>` — pretty-print tool.
- `pixi run tape-grep <pattern> <file>` — filter.
- `pixi run tape-replay <file> [--against <llmnb>]` — replay + optional integrity check.

## Sibling RFCs

- [RFC-001](RFC-001-mcp-tool-taxonomy.md), [RFC-002](RFC-002-claude-code-provisioning.md), [RFC-004](RFC-004-failure-modes.md), [RFC-005](RFC-005-llmnb-file-format.md), [RFC-006](RFC-006-kernel-extension-wire-format.md).
- This RFC is the operational counterpart to RFC-005's persistent `event_log`: spans (traces signal) live in `.llmnb`, log records (logs signal) live in `.tape`, and they cross-reference via OTel-native `traceId`/`spanId`.

## External references

- [OTel Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [opentelemetry-proto OTLP/JSON encoding](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md)
- [OTel semantic conventions for `event.name`](https://opentelemetry.io/docs/specs/semconv/general/events/)
