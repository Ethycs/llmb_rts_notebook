# Engineering Guide — `llmb_rts_notebook`

This document captures the engineering philosophy and process the project follows. It is descriptive rather than prescriptive: every pattern below is one that has produced load-bearing artifacts in this repository (RFC-001 through RFC-008, sixteen ADRs, two implementation refactors, a working VS Code extension and Python kernel, an end-to-end live smoke). The patterns are documented here so future contributors can extend them without re-deriving them.

The discipline is informally called **Bell System engineering** in the docket — a reference to the AT&T pre-divestiture engineering culture that combined numbered protocol specs, formal compatibility analysis, fault-tree thinking, and layered abstractions with stable interfaces. [DR-0016](docs/decisions/0016-rfc-standards-discipline.md) and [chapter 08 §"Bell System–inspired standards discipline"](docs/dev-guide/08-blockers-mediator-standards.md) are the originating source.

---

## 1. Origin and motivation

The project is small in scope (one VS Code extension, one Python kernel, ~5–6 weeks of calendar) but rich in protocol boundaries. There are five integration risks named in chapter 08 — MCP tool taxonomy, Claude Code provisioning, custom message format, fault-injection harness, kernel-host transport — and each has multiple consumers, multiple producers, and meaningful failure modes. Without discipline, these boundaries drift on inconsistent assumptions and surface as bugs in week 4.

Bell System discipline addresses this by:

1. **Specifying protocols normatively before implementation.** Numbered, dated, version-locked RFCs.
2. **Treating backward-compatibility as a first-class concern.** Every spec has an explicit class system; every change is classified.
3. **Cataloguing failure modes systematically.** Fault tables enumerate triggers, responses, and recovery surfaces.
4. **Layered abstractions with stable interfaces.** Each layer presents one shape upward; the shape doesn't leak.
5. **Documentation precedes implementation.** Specs are written first, reviewed against requirements, then handed to implementation. Conformance is to the document.

The cost is a week of writing instead of a week of coding. The benefit is integration risks surface as written ambiguities rather than as runtime surprises in week 4.

---

## 2. The decision artifacts

The project has three kinds of normative documents:

### 2.1 Decision Records (ADRs)

Located under [docs/decisions/](docs/decisions/). Each ADR captures one load-bearing commitment: what forced the decision, what was chosen, what was given up, what alternatives were considered. Format is **MADR-lite**:

1. Title and metadata (status, date, tag)
2. Context — what forced the decision
3. Decision — the chosen path, stated as an imperative
4. Consequences — positive, negative, follow-ups
5. Alternatives considered — what was rejected and why
6. Source — links to raw conversation turns and the relevant dev-guide chapter

Tags: `PIVOT` (direction change), `LOCK-IN` (architectural commitment), `SCOPE-CUT` (V1 simplification).

ADRs preserve context that the dev guide flattens away. The dev guide states the design as fact; the ADRs preserve the journey, including reversals and superseded commitments.

### 2.2 Request for Comments (RFCs)

Located under [docs/rfcs/](docs/rfcs/). Each RFC specifies one protocol or format normatively. Implementations conform to the RFC; deviations require an RFC update, not a code workaround.

The docket as of V1:

| # | Title | Status |
|---|---|---|
| RFC-001 | V1 MCP tool taxonomy | Draft |
| RFC-002 | Claude Code provisioning procedure | Draft |
| RFC-003 | Custom Jupyter message format | Superseded by RFC-006 |
| RFC-004 | Failure-mode analysis and fault-injection harness | Draft |
| RFC-005 | `.llmnb` file format | Draft |
| RFC-006 | Kernel↔extension wire format (v2) | Draft |
| RFC-007 | `.tape` files (OTLP/JSON Logs) | Queued |
| RFC-008 | Kernel host integration (PTY + socket) | Draft |

### 2.3 Dev Guide chapters

Located under [docs/dev-guide/](docs/dev-guide/). Each chapter is the *imperative description* of a coherent slice of the design at the end of the design phase, with reversals flagged but not narrated. Chapters are self-contained; they describe state, not journey.

Three different artifacts for three different jobs: ADRs for "why this was chosen," RFCs for "how this works on the wire," dev guide for "what the design looks like as one document."

---

## 3. RFC structure and lifecycle

### 3.1 Section layout

Every RFC under [docs/rfcs/](docs/rfcs/) follows the same section order:

1. **Status** — Draft / Accepted / Queued / Superseded by RFC-NNN; date; semver version string (e.g., `1.0.0`).
2. **Context** — what forces the spec, citing the relevant ADRs and prior RFCs.
3. **Specification** — the normative content (schemas, procedures, message catalogs, framing rules). The bulk of the document.
4. **Backward-compatibility analysis** — what counts as breaking vs. additive vs. deprecating; how versions are signaled.
5. **Failure modes** — for runtime-behavior RFCs; fault table per RFC-004's taxonomy.
6. **Worked example** — at least one end-to-end concrete example exercising the spec.
7. **Consumers** — which components depend on this RFC.
8. **Open issues queued for amendment** — known issues with disposition.
9. **Source** — referenced ADRs, dev-guide chapters, sibling RFCs, external docs.

### 3.2 Versioning and lifecycle

- **Version field is mandatory.** Every RFC declares semver. The wire / file format uses this version explicitly (e.g., `metadata.rts.schema_version: "1.0.0"`, Comm target `llmnb.rts.v2`).
- **Patch bumps**: clarifications that change neither shape nor semantics.
- **Minor bumps**: additive features. Old consumers continue working.
- **Major bumps**: breaking changes. Old consumers MUST be updated. New RFC-NNN supersedes the old.
- **Supersession over amendment for major changes.** When RFC-003 became RFC-006 (OTLP/JSON payloads + thin envelope), we superseded rather than amended. The old RFC stays in the docket marked `Superseded`. The new RFC takes a new number.
- **Lifecycle states**: `Draft` (under design or implementation), `Accepted` (proven in production), `Queued` (architecturally locked but not yet drafted in full — see RFC-007), `Superseded by RFC-NNN` (replaced by a major-version successor).

### 3.3 Backward-compatibility classes

Three classes are shared across every RFC:

- **Additive**: new optional fields, new tools, new message types, new enum values, new attribute keys. Old clients keep working without updates. Receivers MUST tolerate unknown fields and unknown enum values.
- **Deprecating**: a field/tool/message marked obsolete but still honored. Senders MUST emit both the deprecated form and its replacement for at least one minor version. The RFC document MUST list every deprecation against the version it was introduced and the version in which removal is permitted.
- **Breaking**: rename or remove a required field, type change, semantic redefinition, change to required-field set. Bumps the major version.

V1 has only one schema version per RFC, but the framework exists from the start so V2 evolution is tracked rather than improvised.

### 3.4 Worked examples

Every RFC includes at least one end-to-end concrete example. Examples must be:

- **Complete**: every required field present.
- **Realistic**: matches actual implementation output, not idealized.
- **Annotated**: explanatory prose accompanies the example showing what each piece does.

Examples serve as conformance test fixtures: implementations that round-trip the worked example correctly are likely to round-trip real traffic correctly.

### 3.5 Failure-mode tables

Each runtime-behavior RFC (RFC-002, -005, -006, -008 in this docket) has a fault table. Columns:

| # | Trigger | Recipient response | Recovery surface |

- **Trigger**: the precise condition that surfaces the failure (e.g., "Comm message missing required field").
- **Response**: what the recipient MUST do (log and discard, refuse to load, emit a structured error, etc.). MUST NOT use SHOULD when the action is critical; MUST when the action is.
- **Recovery surface**: what reaches the operator and how the failure unblocks (operator-facing modal, replay path, restart logic).

Failure tables are not aspirational — every row corresponds to a code path that has been (or will be) implemented and tested.

### 3.6 Open issues queued for amendment

Each RFC tracks issues surfaced during drafting or implementation that did not block the RFC but warrant future attention. Format:

| Issue | Surfaced by | Disposition |

Disposition is concrete: `V1.5: introduce X`, `V2: switch to Y`, `Held until V1 ships`. Open issues without disposition are bugs in the RFC.

---

## 4. ADR structure and lifecycle

### 4.1 MADR-lite layout

Six sections per ADR (see [docs/decisions/0001-rts-as-agent-orchestrator.md](docs/decisions/0001-rts-as-agent-orchestrator.md) for an example):

1. Title + metadata (status, date, tag)
2. Context
3. Decision (imperative)
4. Consequences (positive / negative / follow-ups)
5. Alternatives considered (rejected paths with reasoning)
6. Source (raw turn links + dev-guide chapter)

### 4.2 Refinement over rewrite

When a decision evolves but its core stands, add a **Refinement** section to the existing ADR rather than writing a new one. Example: [DR-0010](docs/decisions/0010-force-tool-use-suppress-text.md) was refined when RFC-005's `agent_emit` introduced — the original "suppress text" intent was preserved (renderers visually de-emphasize raw output) but the silent-drop hole was closed (raw output is now captured as `agent_emit` spans).

A refinement section names:
- The version / RFC era of the change
- What's preserved from the original decision
- What's clarified or adjusted
- What this means for conforming implementations

Refinements are appended; the body of the ADR stays as historical record.

### 4.3 Supersession

When a decision is fully replaced, mark it superseded by linking the new ADR. Status moves to `Superseded by DR-NNNN`. This rarely happens for ADRs (decisions tend to evolve via refinement); it's more common for RFCs.

### 4.4 Tag discipline

Three tags only:

- **PIVOT**: the project's scope or approach shifted. Used sparingly. Examples: DR-0001 (project pivots from Vega-game to RTS-for-agents), DR-0006 (reject React).
- **LOCK-IN**: an architectural commitment. Downstream work depends on it. Most ADRs.
- **SCOPE-CUT**: a feature, integration, or layer removed to keep V1 reachable. Examples: DR-0005 (V1 cuts), DR-0012 (LLMKernel sole kernel).

Combinations are not allowed. An ADR is exactly one tag.

---

## 5. Standards adoption: strict over loose

When a relevant external standard exists, adopt it strictly rather than half-implement.

### 5.1 The principle

Strict standards adoption gets external validation for free. OTel collectors reject malformed OTLP/JSON; tooling that consumes our outputs will fail-fast on schema bugs we'd otherwise discover in week 4. Loose schemas (LangSmith's permissive ingest, for example) accept malformed records and surface bugs late.

### 5.2 Examples in this docket

- **OTLP/JSON over LangSmith** for run records. RFC-005 specifies strict OTLP/JSON encoding (`startTimeUnixNano` as JSON-string of decimal nanos, `traceId` as 32-hex, `attributes` as `[{key, value: {stringValue}}]` not flat objects). External validators check our work. The cost was a 1.5-day mechanical refactor (R1); the benefit is end-to-end conformance with the OTel ecosystem (Jaeger, Tempo, Honeycomb, Grafana ingest our outputs).
- **OTel GenAI semantic conventions** for LLM-call attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`). Free schema work; aligned with industry direction.
- **OpenInference attribute conventions** for tool-call inputs/outputs (`tool.name`, `input.value`, `input.mime_type`). Also free schema.
- **`llmnb.*` namespace ONLY for fields with no semconv equivalent**: `llmnb.run_type`, `llmnb.agent_id`, `llmnb.zone_id`, `llmnb.cell_id`. Five custom attributes; everything else is standard.
- **JSON Schema Draft-2020-12** for input/output schemas in RFC-001. External validation tools work without adapter.

### 5.3 When to deviate

Deviations require explicit justification in the RFC. The current docket has zero deviations from strict OTel/JSON encoding once it was adopted. RFC-005 §"event_log" enumerates three permitted deviations from the wire form (line-oriented persistence, ISO timestamps removed, blob extraction); each is documented with reasoning.

### 5.4 The half-conformance trap

"We use ACP at the framing layer but invent custom methods" is a half-conformance. Avoid it. If a standard fits, conform fully; if it doesn't fit, design from first principles. The middle ground is the worst of both: tracking an upstream we don't use plus reinventing what we do use.

This is why the project uses ACP at the kernel-to-agent layer (where it fits — editor-to-coding-agent) but custom RFC-008 at the extension-to-kernel layer (where ACP doesn't fit — extension is not an agent).

---

## 6. Recoverable vs volatile state

Every persisted artifact is one of two kinds:

- **Recoverable**: deterministic on resume. Pure data. Loads verbatim. Examples: layout-tree node IDs, agent-graph structure, closed run records, blob contents (hash-verifiable).
- **Volatile**: depends on external reality that may have changed since save. Examples: model availability, RFC implementation versions, prompt-template hashes, agent-process state, in-progress runs.

### 6.1 Schema-level split

Where structural separation is possible, split the schema explicitly. RFC-005 §"`metadata.rts.config`" is the canonical example: `config.recoverable.{kernel,agents,mcp_servers}` vs `config.volatile.{kernel,agents,mcp_servers}`. The boundary is in the schema, not just the documentation.

### 6.2 Drift detection

Every volatile field MUST be checked for drift on load. Detected differences produce **drift events** appended to a `metadata.rts.drift_log[]` array. Each event carries:

- `detected_at` (ISO 8601)
- `field_path` (JSONPath-like)
- `previous_value`
- `current_value`
- `severity`: `info | warn | error`
- `operator_acknowledged: boolean`

Drift events are append-only: they form an audit trail. Acknowledgment closes the operator prompt for that specific event but does not silence future drift on the same field.

### 6.3 Severity classification

- `info`: benign drift (in-progress span auto-truncated; agent process state changed; harmless)
- `warn`: changes that may affect behavior but resume can proceed (model version bump within same major; system prompt hash changed)
- `error`: drift that blocks resume (RFC major version mismatch, MCP server unreachable, model unavailable)

Errors block agent execution until acknowledged or resolved. Warns surface to the operator but don't block. Infos are audit-only.

### 6.4 The principle generalizes beyond config

In RFC-005, the recoverable/volatile distinction applies to:
- `config.{recoverable,volatile}` (explicit split)
- `agents.nodes[*].properties.status` (volatile)
- `event_log.runs[]` open spans (volatile) vs closed spans (recoverable)
- `metadata.rts.blobs` (recoverable, hash-verifiable)
- `metadata.rts.layout` (recoverable)

When designing a new persistent artifact, ask: which fields are pure data and which depend on external reality? Split accordingly.

---

## 7. The implementation pattern

Implementation follows a fixed sequence:

```
1. Identify gap                                  (operator review of dev-guide / scope review)
2. Push on design                                (numbered Q&A, lock answers individually)
3. Draft RFC                                     (or refine existing one)
4. Update docket index                           (docs/rfcs/README.md)
5. Carve refactoring out as separate work        (if applicable)
6. Brief implementation agent(s)                 (precise, scoped, with verification)
7. Dispatch (parallel where slices are disjoint)
8. Wait for completion (background)
9. Verify (smokes, tests, grep)
10. Update todo list as steps complete
```

### 7.1 RFC-first

No implementation begins until the RFC governing the change is at least drafted. The RFC is the brief: implementation agents read it, conform to it, return a report citing what they changed against it.

This rule has held across R1 (RFCs were already in place; refactor implemented), I-K/I-X (RFC-005 + RFC-006 were drafted first), I-T-K/I-T-X (RFC-008 was drafted first).

### 7.2 Push on design before drafting

Before writing an RFC, surface the open design choices as numbered questions. Lock each individually.

Example: when designing the `.llmnb` file format (RFC-005), the conversation surfaced seven questions:

1. Wire form vs persistent form (merge into canonical)
2. Who writes the file
3. `metadata.rts` top-level shape
4. `config` block contents
5. Cell-level metadata
6. Cross-structure references
7. Event log size

Each was locked individually with a recommendation and a sharpest-remaining-question. Locking happened before the RFC was drafted.

### 7.3 Refinement when an architectural insight changes things

When the user surfaces a refinement mid-design ("agent output should be emitted to output cells whether or not it's valid"), apply the refinement to all affected docs *before* implementation. Don't ship two versions of an RFC and reconcile later. The `agent_emit` refinement touched RFC-005, RFC-006, RFC-002, and DR-0010 in one pass.

### 7.4 Carving out refactoring

Refactoring work that's mechanical (rename fields, switch encoding) is carved out as a separate task with a clear name (e.g., "Refactor R1 — LangSmith → strict OTLP/JSON"). The scope is documented; an agent runs it; the result is verified.

This separation prevents a "design + refactor + new feature" bundle that's hard to verify.

---

## 8. Multi-agent execution

### 8.1 When to dispatch

Use multiple agents in parallel when:
- The slices are **architecturally independent** (no file overlap, no protocol coordination required beyond a stable spec)
- The brief can be **precise** (the spec is locked, not in flux)
- The total work exceeds **~1 day** of single-agent serial execution

Don't dispatch agents for:
- Tasks that require seeing the full codebase context (use direct tools)
- Work that's still being designed (the brief will drift)
- One-line fixes (overhead exceeds the work)

### 8.2 The two-agent pattern

The default for substantial work has been two parallel agents — one for kernel (Python), one for extension (TypeScript). Examples:

- **R1** (LangSmith → OTLP refactor): R1-K + R1-X. ~1.5 days each.
- **Implementation I** (RFC-005 + RFC-006 + agent_emit): I-K + I-X. ~2 days each.
- **Implementation T** (RFC-008 transport): I-T-K + I-T-X. ~1 day each.

The slices are disjoint by repository tree (`vendor/LLMKernel/` vs `extension/`). Coordination is through the spec only.

### 8.3 Briefing

A good brief contains:
- **What to read first** (specific RFC files in order)
- **Locked-in design points** (the seven decisions or whatever applies)
- **Specific files to touch** (paths, not patterns)
- **Field migration tables** (when a refactor)
- **Specific verification commands** (`pixi run -e kernel pytest ...`)
- **Acceptance criteria** (must-pass conditions before declaring done)
- **Out of scope** (what NOT to touch)
- **Reporting format** (a 250-word report with specific elements)

Bad briefs are open-ended ("implement RFC-008"). Good briefs are precise to the file, function, and test level.

### 8.4 Verification ritual

After each agent returns:

1. **Read the report** — what did they say they did?
2. **Check the artifacts** — do the files they claimed to create exist?
3. **Run the verification commands** — do the tests pass?
4. **Grep for forbidden patterns** — no LangSmith remnants, no `@jupyterlab/services`, no v1 Comm targets.
5. **Update todos** — mark this verification step complete only after all checks pass.

The "trust but verify" principle: an agent's summary describes what they intended; the actual changes describe what they did. Always check the actual changes.

### 8.5 Agent flagging vs guessing

Briefs explicitly require agents to **flag contradictions, not guess**. When the I-K agent found that RFC-001 v1.0.0 said "no run record on unknown tool" while RFC-002 §"Failure modes" said "emit `agent_emit:invalid_tool_use`," the agent flagged it and picked the newer doc as authoritative, citing both. That flag was reviewable; a silent guess would have hidden the conflict.

---

## 9. Verification rituals

### 9.1 Tiered smokes

The project has three tiers of smoke tests:

- **Tier 1 — paper-telephone smoke** (`paper-telephone-smoke`): in-process kernel; no agent; round-trip RFC-006 envelopes through the dispatcher and run tracker. Verifies the wire is emitted correctly.
- **Tier 2 — VS Code contract suite** (`npm test:contract`): extension tests with stub kernel; verifies the extension's consumption of RFC-006 frames.
- **Tier 3 — live OAuth + mitm smoke** (`LLMKERNEL_USE_PASSTHROUGH=1 ... agent-supervisor-smoke`): real Claude Code subprocess; real Anthropic API calls intercepted via mitmproxy; verifies end-to-end against production providers.

Run each tier after every change that affects its layer. Tier 1 is fast (<5s); Tier 2 is medium (~30s); Tier 3 is slow (~30s + costs ~$0.01 in API calls per run).

### 9.2 Scoped test suites

The kernel has a scoped suite for each refactor cycle:

```
pixi run -e kernel pytest \
  vendor/LLMKernel/tests/test_run_tracker.py \
  vendor/LLMKernel/tests/test_custom_messages.py \
  vendor/LLMKernel/tests/test_mcp_server_round_trip.py \
  vendor/LLMKernel/tests/test_agent_supervisor.py \
  vendor/LLMKernel/tests/test_litellm_proxy.py \
  vendor/LLMKernel/tests/test_metadata_writer.py \
  vendor/LLMKernel/tests/test_drift_detector.py \
  vendor/LLMKernel/tests/markov/ \
  -q
```

Pre-existing test failures in unrelated modules (`test_kernel.py`, `test_multimodal_display.py`, `test_pdf_notebook_integration.py` — all `ModuleNotFoundError: ipywidgets`) are explicitly excluded with `--ignore`. The scoped suite is the in-scope canon.

### 9.3 Grep checks

After each refactor, run targeted greps to confirm conformance:

```
# No LangSmith field names remain
grep -rn "run_type\|parent_run_id\|start_time\b" extension/src/ vendor/LLMKernel/llm_kernel/
# (excluding doc comments that reference upstream specs)

# No legacy Comm target
grep -rn "llmnb\.rts\.v1" extension/src/ vendor/LLMKernel/llm_kernel/

# No legacy dependency
grep -rn "@jupyterlab/services" extension/

# No insecure config fields
grep -rEn "_key|_token|_password|_secret" docs/rfcs/RFC-005-llmnb-file-format.md
```

Greps are in addition to tests, not in place of them. They catch incomplete refactors that tests didn't exercise.

---

## 10. Naming and versioning conventions

### 10.1 RFC numbering

Sequential, no gaps. RFC-001, RFC-002, ..., RFC-008. New RFCs take the next available number. Superseded RFCs keep their number; they don't get renumbered.

### 10.2 Major version in the wire / file

The major version of an RFC-defined artifact is encoded literally in the address:

- Comm target name: `llmnb.rts.v2`
- File schema URI: `https://llmnb.dev/llmnb/v1/schema.json`
- MIME types: `application/vnd.rts.run+json` (versioned by content-shape; not by URL)
- Env vars: `LLMKERNEL_PTY_MODE=1` (binary; minor versions don't break)

This is the OTel convention (`opentelemetry.io/schemas/1.32.0`). Major version mismatch fails fast at the protocol handshake — that's the upgrade prompt.

### 10.3 Trace and span IDs

OTel-conformant: 32 lowercase hex chars for `traceId`, 16 lowercase hex chars for `spanId`. Generated via `secrets.token_hex(16)` / `secrets.token_hex(8)` in Python. NOT UUIDs (v4 UUIDs encode wrong: 36 chars including dashes; OTel wants 32 without).

### 10.4 Time encoding

OTel-conformant: `startTimeUnixNano` as **JSON string** of decimal nanoseconds since the Unix epoch. Not a JSON number (loses 64-bit precision in browsers). Not ISO 8601 (OTel collectors reject).

### 10.5 Attribute encoding

OTLP/JSON tagged-union form:
```json
"attributes": [
  { "key": "llmnb.run_type", "value": { "stringValue": "tool" } },
  { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "1234" } }
]
```

Not the K8s-style flat object (`{"key": "value"}`). The strict form preserves type information and is what OTel collectors consume.

### 10.6 Filenames

- ADRs: `NNNN-kebab-case-title.md` (e.g., `0010-force-tool-use-suppress-text.md`).
- RFCs: `RFC-NNN-kebab-case-title.md` (e.g., `RFC-005-llmnb-file-format.md`).
- Dev guide: `NN-kebab-case-title.md`.
- Engineering Guide: `Engineering_Guide.md` (this file; root-level convention for project-level meta-doc, distinct from ADR/RFC indexing).

---

## 11. Anti-patterns to avoid

### 11.1 "Half-conformance" to a standard

Using a standard's framing but inventing custom methods/shapes. The cost of tracking the upstream remains; the benefit (validator pass-through, ecosystem tooling) is lost.

If a standard fits, conform fully. If it doesn't fit, design from first principles and document why the standard wasn't suitable.

### 11.2 Backward-compat shims for non-existent legacy

This project has no production data and no external consumers in V1. Adding migration code, deprecation tolerance, or "support both old and new" branches for cases that can't happen is dead weight.

The R1 refactor explicitly took the clean break: LangSmith records were not preserved across the OTLP refactor because there were none in the wild. This kept the codebase smaller and simpler.

### 11.3 Premature abstraction

If three implementations of a thing exist, the abstraction is justified. If one exists, write it concretely; abstract later when you see what shape the others want.

The first iteration of the kernel-extension wire (RFC-003 v1) had a uniform envelope for *every* message including run lifecycle. The OTel adoption made it clear that runs are self-describing OTel spans; the envelope was redundant for them. RFC-006 supersession dropped the envelope from Family A. The abstraction was premature; the right shape was visible only after the OTel decision.

### 11.4 Silent drops

Architecture should never silently discard data the operator might need. The DR-0010 refinement is a worked example: "if it's not a tool call, the operator does not see it" was refined to "tool calls are the *primary* operator-facing channel; raw output is captured and surfaced as `agent_emit`." Silent drops were a debuggability hazard; the refinement closed it without weakening the operator-UX intent.

### 11.5 Editing intermediate files instead of the canonical doc

Implementation agents have repeatedly been told not to update the RFC documents from inside the implementation work. The RFC is the spec; implementation conforms. A change to the RFC is a separate, reviewable doc update — not a side-effect of implementation.

If implementation surfaces an RFC bug, the agent flags it; the operator reviews; the RFC is updated; implementation continues against the corrected RFC. Don't bury spec changes in implementation diffs.

### 11.6 Abandoning specs under time pressure

The discipline is most valuable exactly when the work is under pressure. RFC-008 was added mid-implementation when the kernel-extension transport became architecturally important; it took ~30 minutes to draft and ~2 hours of agent work to implement. Skipping the RFC would have saved 30 minutes and lost the spec; the fault tables and worked examples would have been re-derived later.

The threshold for "this needs an RFC" is: the artifact crosses a process / language / version boundary AND has more than one consumer.

### 11.7 Logging inside a lock the log handler may re-enter

When a module holds a lock around its critical section AND calls `logger.warning` (or any logging API) inside that section AND the logger has a handler that routes back through the *same module's* critical section, a non-reentrant lock will deadlock on the second acquire.

This is exactly what happened to `SocketWriter`:

1. `SocketWriter.write_frame` acquires `self._lock` and calls `sock.sendall`.
2. `sendall` raises (broken socket).
3. The error path calls `logger.warning(...)`.
4. The root logger has an `OtlpDataPlaneHandler` whose backing writer is the same `SocketWriter` instance.
5. `OtlpDataPlaneHandler.emit` calls `self._writer.write_frame(<log_record>)`.
6. `write_frame` tries to acquire `self._lock` — **already held by step 1 → deadlock**.

The fix was one line: `threading.Lock` → `threading.RLock`. Re-entrance from the same thread is now allowed. The log path can ride the data path safely.

The diagnostic trick: **if your log path goes through your data path, those paths must be re-entrant**. Anywhere you have:

- A module-level lock (data plane)
- That logs from inside the critical section
- And a logging handler that invokes the same module's surface

… switch to `RLock`, OR move the logging call outside the `with` block, OR use a dedicated lock for the log path.

This anti-pattern is silent: tests pass in isolation, the deadlock surfaces only when the log handler is wired up live (e.g., kernel pty-mode where `OtlpDataPlaneHandler` is installed on the root logger). The cost of finding it: a 50-minute test hang and several monitor cycles before the agent statically identified the re-entrance. The cost of avoiding it: knowing the rule.

Generalization: **any callback path that logs MUST be re-entrant against the locks it transitively holds**. Applies to socket writers, file writers, queue producers — anywhere a producer's error path emits a log record, and the log handler is consumed by the same producer.

---

## 12. The Bell System reference, in practice

The reference is not decorative. The following Bell System practices are explicitly carried over:

| Bell System practice | Project equivalent |
|---|---|
| Numbered RFCs preceding implementation | RFC-001 through RFC-008 in [docs/rfcs/](docs/rfcs/) |
| Backward-compatibility analysis as a first-class concern | Three classes (additive / deprecating / breaking) in every RFC's §"Backward-compatibility analysis" |
| Fault-tree analysis | Fault tables in RFC-002, RFC-005, RFC-006, RFC-008 |
| Layered abstractions with stable interfaces | LiteLLM as TCP/IP-stack-layer; OTel as observability-stack-layer; MCP as tool-call-layer; each presents one shape upward |
| Documentation precedes implementation | RFC-first sequence (§7.1) |
| Spec-document changes are documents | Refinement sections on ADRs (§4.2); RFC supersession (§3.2) |
| Numbered, dated, version-locked specs | Every RFC has Status / Date / Version |
| Reliability via systematic enumeration | Fault tables + property-based testing (Markov harness in RFC-004) |

What the project does **not** do (where Bell-System-strict would over-formalize):

- **Formal review committees** — the project has one operator + agents. Review is a single-operator code-review.
- **Reference implementation libraries shipping with each RFC** — the implementation IS the reference.
- **Conformance test suites separate from the codebase** — the contract tests are the conformance suite.
- **Multiple implementations interoperating against one spec** — V1 has one Python kernel and one TypeScript extension; multi-implementation interop is a V2 question.

The discipline is calibrated to project scale: full RFC + worked-example + fault-table; lighter on review process and conformance ceremony.

---

## 13. The docket as it stands (V1)

For convenience, the load-bearing artifacts:

**ADRs** (16 total, [docs/decisions/README.md](docs/decisions/README.md) is the index):

DR-0001 through DR-0016. Three pivots, ten lock-ins, three scope cuts. DR-0010 has a "Refinement (RFC-005/006 era)" section.

**RFCs** ([docs/rfcs/README.md](docs/rfcs/README.md) is the index):

| # | Title | Status | Implementation status |
|---|---|---|---|
| 001 | V1 MCP tool taxonomy | Draft | Implemented; 13 tools |
| 002 | Claude Code provisioning procedure | Draft v1.0.1 | Implemented; live OAuth + mitm smoke green |
| 003 | Custom Jupyter message format | Superseded by RFC-006 | (Old) |
| 004 | Failure-mode analysis and fault-injection harness | Draft | Implemented; Markov suite green |
| 005 | `.llmnb` file format | Draft | Implemented; metadata_writer + drift_detector |
| 006 | Kernel↔extension wire format (v2) | Draft | Implemented; smokes green |
| 007 | `.tape` files (OTLP/JSON Logs) | Queued | Stub spec; implementation deferred |
| 008 | Kernel host integration (PTY + socket) | Draft | Implementation in flight |

**Dev-guide chapters** (8 total, [docs/dev-guide/00-overview.md](docs/dev-guide/00-overview.md) is the entry point):

Chapters 01–08 cover the design history. Chapter 08 names the four originating RFCs (001–004); RFCs 005–008 followed during V1 implementation.

**Engineering Guide** (this file): the philosophy and process distillation.

---

## 14. Reading paths

For a new contributor:

1. Read this file end-to-end (~15 min).
2. Read [docs/dev-guide/00-overview.md](docs/dev-guide/00-overview.md) for the design at a glance.
3. Read [docs/rfcs/README.md](docs/rfcs/README.md) and skim the active RFCs.
4. Read the RFC for the layer you're about to touch.
5. When implementing, conform to the RFC; flag any contradictions you find.

For a reviewer:

1. Walk [docs/decisions/README.md](docs/decisions/README.md) — the audit trail.
2. For each ADR being reviewed, follow its `Source` link to the raw conversation turns.
3. Cross-reference against the relevant RFCs and dev-guide chapters.

For an operator running a session:

1. Read [README.md](README.md) for status and reading paths.
2. Verify versions: `metadata.rts.config.volatile.kernel.rfc_*_version` against current kernel build.
3. Drift events surface in `metadata.rts.drift_log`; acknowledge or resolve before resuming agents.

---

## Appendix A — When to write a new RFC

A new RFC is warranted when a proposed change:

1. Crosses a process / language / version boundary, AND
2. Has more than one consumer or producer, AND
3. Has more than one valid implementation, AND
4. Will outlive the current implementation.

A change can skip the RFC and go straight to code if:

- It's contained within one module
- It only has one consumer (e.g., a kernel-internal helper)
- The implementation is the spec

Refactors typically don't warrant new RFCs. They often *do* warrant updating an existing RFC (deprecation note, backward-compat clarification).

## Appendix B — When to refine vs supersede

**Refine** (add a section to an existing ADR or RFC) when:

- The core decision stands; only the application changes.
- Old conformance is still valid; new conformance is additionally valid.
- The change is documentable as a clarification.

**Supersede** (write a new RFC that replaces the old) when:

- The wire shape changes incompatibly.
- A schema's required fields shift.
- The fundamental abstraction layer changes (e.g., LangSmith → OTel).
- Compatibility within the existing major version cannot be preserved.

Refinement is a much smaller commitment than supersession. Default to refinement; supersede only when the architectural change exceeds what refinement can carry.

## Appendix C — Glossary

- **ACP**: Agent Client Protocol (Zed's; LSP-equivalent for coding agents). NOT IBM's "Agent Communication Protocol" or Google's A2A. In this project: kernel-to-agent layer (V2); not used at extension-to-kernel.
- **Family A–F**: RFC-006's message families. A = run lifecycle; B = layout; C = agent graph; D = operator action; E = heartbeat; F = notebook metadata.
- **MADR-lite**: the ADR format used in this project (six sections; concise).
- **MCP**: Model Context Protocol (Anthropic's). Used for kernel-to-agent tool calls in V1.
- **mitmproxy**: HTTPS interception proxy. Used in Tier 3 smoke for layer-2 observability of Anthropic API calls.
- **OTLP/JSON**: OpenTelemetry's wire encoding. Strict-mode is the project standard for run records, log records, file format event_log entries.
- **PTY**: Pseudoterminal. RFC-008's control plane for kernel host integration.
- **RFC-006 envelope**: the thin Comm-channel envelope `{type, payload, correlation_id?}`. Replaces the v1 envelope (which had `direction`, `timestamp`, `rfc_version`).
- **`.llmnb`**: project file format. Per RFC-005. Extends `.ipynb`-shaped JSON with `metadata.rts.{layout,agents,config,event_log,blobs,drift_log}`.
- **`.tape`**: opt-in raw observability log. Per RFC-007 (queued). OTLP/JSON Logs format.

---

*This guide is itself an RFC-style artifact: drafted, dated (2026-04-26), versioned implicitly by the docket state at time of writing. Future updates land as additions or refinements; the structure stays.*
