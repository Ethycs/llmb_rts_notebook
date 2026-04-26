# RFC-004 — Failure-mode analysis and fault-injection harness

## Status

- **Status:** Draft
- **Date:** 2026-04-25
- **Version:** 1.0.0

## Context

V1 ships a three-component system — VS Code extension, LLMKernel Python subprocess, and one or more Claude Code agent subprocesses — communicating across two protocol boundaries: the Jupyter messaging protocol (extension ↔ kernel, governed by RFC-003) and the Model Context Protocol (kernel ↔ agent and kernel ↔ extension, governed by RFC-001 and DR-0015). Every cross-component message holds the message in a stable, inspectable form (the "paper-telephone" property of DR-0015), but observability alone does not make the system robust. Each link can fail; each failure must be classified, surfaced, and recoverable.

[DR-0013](../decisions/0013-v1-feasible-with-claude-code.md) committed V1 to a serious release on a five-to-six-week calendar with the explicit caveat that the *complete* fault-injection harness is not part of V1's must-ship list. What V1 *must* ship is the foundation: a normative failure taxonomy, a published harness shape, and the property invariants the implementation conforms to. The full Markov chaos suite parallelizes alongside feature work; the foundation gates Stage 4 testing.

[Chapter 07](../dev-guide/07-subtractive-fork-and-storage.md) ("Testing strategy") commits to four layers: doc-driven contract tests grounded in published specifications, a single Python mock kernel reused by Python and TypeScript test consumers, Markov-chain simulation for distributed-system invariants, and fault injection that makes lifecycle bugs testable rather than aspirational. [Chapter 08](../dev-guide/08-blockers-mediator-standards.md) names this RFC as one of the four numbered RFCs that close out the design phase, and fixes the *hard kernel/notebook failure split* as a load-bearing decision: kernel-level failures (process crash, endpoint unreachable) and notebook-level failures (file corruption, schema mismatch) MUST surface through different operator-facing channels with different recovery paths.

This RFC is normative. It specifies the failure taxonomy, the three replay-harness modes, the fault-injection scheduler, the property invariants, and the doc-driven contract test families before any test code is written. Implementations conform to this RFC; deviations require an RFC update, not a test-suite workaround.

V1 fails CLOSED. Where a failure is detected, agent operations halt, the operator surface shows a structured error citing the documented log signature, and explicit operator action is required to resume. There are no silent retries in V1. The reliability hypothesis is that observable, halting failure with structured surfaces is more valuable to early dogfooding than opportunistic recovery that hides bugs.

## Specification

### Failure taxonomy (the hard kernel/notebook/cross-boundary split)

The taxonomy partitions failures by *where the failure originates*, not by where the symptom is observed. The split is normative: each failure has exactly one home and exactly one canonical recovery path. The operator-facing surface column names which UI element MUST display the structured error.

Each row has the same shape: trigger condition, observable symptoms, recovery path, operator-facing surface, log signature. The log signature is the JSONL line prefix the harness asserts on; every signature is emitted by the kernel's structured logger to `metadata.rts.event_log` and to stderr.

#### Kernel-level failures

| Failure | Trigger | Symptoms | Recovery | Operator surface | Log signature |
|---|---|---|---|---|---|
| Kernel process crash | Uncaught exception in kernel main loop, OOM, SIGKILL from OS, panic in Rust extension module | Jupyter sockets close; extension's heartbeat times out; agent subprocesses orphaned | Halt all cells; mark in-flight runs as `error` with `cause: kernel_crash`; operator MUST manually restart kernel via command palette | Notebook status bar shows red "Kernel: dead"; banner above active cell offers "Restart kernel" | `kernel.lifecycle.crashed` |
| LiteLLM endpoint unreachable | Provider API down, network failure, auth failure (401/403), rate limit (429) past retry budget | Agent's model call returns transport error; kernel's run-tracker emits `run.error` for the LLM run | Halt the agent run; emit `run.error` with `cause: litellm_unreachable` and the underlying provider code; agent process kept alive but idle | Cell output renders structured error card with provider name and HTTP status; operator chooses "Retry" or "Abandon run" | `kernel.litellm.unreachable` |
| MCP server crash | Kernel-hosted MCP server thread raises; transport (stdio/SSE/HTTP) tears down | Agent's next tool call returns transport error; kernel detects via internal supervisor | Halt active agent operations bound to that MCP transport; emit `run.error` with `cause: mcp_server_crashed`; kernel attempts one in-process restart of the MCP thread, then surfaces failure if restart fails | Notebook status bar shows yellow "MCP: degraded" then red "MCP: dead"; banner offers "Restart MCP server" | `kernel.mcp.thread_crashed` |
| Agent subprocess crash | Claude Code dies (segfault, exit non-zero, killed by OS) | Kernel's agent supervisor detects exit; pending tool calls and LLM calls for that agent abort | Mark all in-flight runs owned by the agent as `error` with `cause: agent_crashed`; release any zone locks held by the agent; do NOT auto-respawn in V1 | Cell output renders structured error card; sidebar agent-tree marks the agent as "crashed"; operator MUST manually re-provision via the agent menu | `kernel.agent.subprocess_exit` |
| Run-tracker desync | `run.complete` emitted without a matching `run.start` (or two `run.start` events with the same `run_id`) | Run-tracker raises `RunTrackerDesyncError`; the offending event is dropped | Halt the cell that produced the desynced event; emit `run.error` with `cause: run_tracker_desync` and the `run_id`; full event-log dump written to side file `<notebook>.<timestamp>.desync.jsonl` for offline analysis | Cell output shows structured error; banner above cell offers "Open desync log" | `kernel.run_tracker.desync` |
| File-write failure during snapshot | Disk full, permission denied, file locked by another process during the 30-second autosave or operator save | Snapshot raises `OSError`; previous snapshot remains on disk untouched | Halt active agents; surface error; do NOT mark previous save as invalid; operator MUST resolve the disk/permission issue and trigger manual save before resuming | Notebook title bar shows "(unsaved changes)"; banner offers "Retry save" with the underlying errno | `kernel.snapshot.write_failed` |

#### Notebook-level failures

| Failure | Trigger | Symptoms | Recovery | Operator surface | Log signature |
|---|---|---|---|---|---|
| File corruption | `.llmnb` file is invalid JSON, truncated, or has a checksum mismatch on load | Notebook fails to open; extension's loader raises `LlmnbParseError` | Refuse to start kernel; show file-corruption dialog; offer to open the most recent autosave snapshot from `.llmnb.autosave/` if present | Modal dialog "This notebook is corrupted"; choices are "Open last autosave" / "Open in raw JSON editor" / "Cancel" | `notebook.file.corrupt` |
| Schema-incompatible file | `metadata.rts.rfc_version` major component does not match the running extension's supported major | Notebook loads enough to read the version envelope but refuses to mount cells | Refuse to start kernel; show version-mismatch dialog naming the file's version and the extension's supported range | Modal dialog "This notebook was written by a newer/older version of the extension"; choices are "Cancel" / "View diagnostics" | `notebook.schema.incompatible` |
| Malformed cell output | A cell's output payload fails the renderer's input schema (RFC-001 `application/vnd.rts.run+json` validation) | The renderer rejects the payload and emits a fallback error cell-output | Cell output renders a structured "Malformed run record" tile in place of the run UI; the underlying JSON remains in the file untouched | Cell shows a yellow tile naming the failing field path and JSON Schema rule; "Show raw JSON" toggle | `notebook.output.malformed` |
| Missing required metadata | `metadata.rts` namespace absent, or one of its required keys (`layout`, `agents`, `config`, `event_log`, `rfc_version`) missing | Loader detects on open; cannot reconstruct in-memory state | Refuse to start kernel; offer to migrate by initializing missing namespace with defaults (operator confirms) | Modal dialog "Notebook missing required RTS metadata"; choices are "Initialize defaults" / "Cancel" | `notebook.metadata.missing` |
| Git operation failure mid-save | Lock contention on `.git/index.lock`, merge conflict, pre-commit hook failure, working-tree dirty during branch switch | The save completes to disk but the git operation aborts; notebook and git are out of sync | Notify operator; do NOT roll back the file; the save itself is durable; operator resolves git state manually and triggers a new commit | Status bar shows "Git: out of sync"; sidebar "Source Control" panel shows the underlying git error verbatim | `notebook.git.operation_failed` |

#### Cross-boundary failures

| Failure | Trigger | Symptoms | Recovery | Operator surface | Log signature |
|---|---|---|---|---|---|
| Extension-kernel disconnect | Kernel hangs without crashing (deadlock, infinite loop, blocked on I/O) or extension hangs; sockets remain open but no traffic flows | Heartbeat misses ≥ 3 consecutive cycles (RFC-003); extension marks kernel as unresponsive | Halt all cells; mark in-flight runs as `error` with `cause: kernel_unresponsive`; offer kill-and-restart of the kernel process; do not auto-kill | Notebook status bar shows red "Kernel: unresponsive"; banner offers "Force restart kernel" with confirmation | `crossboundary.heartbeat.missed` |
| Message-protocol version mismatch | RFC-003 envelope `rfc_version` major component does not match the consumer's supported major | Receiver drops the message and emits a structured rejection back along the same channel | Halt the cell that produced the message; emit `run.error` with `cause: protocol_version_mismatch`; the offending envelope is logged in full | Cell shows structured error naming the sending and receiving versions | `crossboundary.protocol.version_mismatch` |
| Partial run record | Kernel crashed mid-run; extension has `run.start` but neither `run.complete` nor `run.error` in its in-memory state on resume | Reconciler detects orphan `run.start` after extension reconnects to a fresh kernel | Synthesize a `run.error` with `cause: partial_run_recovered`, `recovered_at` timestamp, and the original `run_id`; append to event log; cell output renders error tile | Cell output shows yellow "Run did not complete (recovered)" tile | `crossboundary.run.partial_recovered` |
| Heartbeat timeout | More than 30 seconds elapse without a kernel heartbeat (RFC-003 cadence is 10s ± 2s) | Same observation as extension-kernel disconnect, but the timeout case is the trigger | Same recovery as extension-kernel disconnect | Same surface | `crossboundary.heartbeat.timeout` |
| correlation_id collision or reuse | Receiver observes a `correlation_id` already present in its in-flight table | Receiver rejects the duplicate envelope; sender sees a structured rejection | Halt the originating cell; emit `run.error` with `cause: correlation_id_collision` and the offending id | Cell shows structured error naming the colliding id | `crossboundary.correlation.collision` |

#### Recovery posture

For every row in the three tables above, V1 fails CLOSED. The recovery columns spell this out concretely: agent operations halt, the operator surface shows a structured error citing the log signature, no silent retry is attempted, and explicit operator action is required to resume. The harness MUST verify the closed-fail property as one of its assertion sets (see "Fault-injection scheduler" below).

The two narrow exceptions to closed-fail in V1 are bounded automatic retries:

- *MCP server thread restart*: at most one in-process restart per session before the failure escalates to operator-facing.
- *LiteLLM provider retry*: governed by LiteLLM's own retry policy (the layer-2 abstraction owns this), bounded by the LiteLLM configuration. Once the LiteLLM retry budget is exhausted, the failure is closed-fail per the table above.

No other failure type retries automatically. Adding a retry path to a failure type is a breaking change to this RFC (see "Backward-compatibility analysis").

### Replay harness modes

The harness MUST support three modes. Mode selection is a top-level argument to the harness driver; the driver MUST refuse to start if the mode is ambiguous or if a recorded log's metadata is incompatible with the requested mode.

#### Live replay

- **Use case:** reproducing a bug at scale against a real running kernel.
- **Input format:** JSONL file of run records (LangSmith-shaped, RFC-001) and RFC-003 envelopes, in receive order, each with a monotonic sequence number.
- **Driver behavior:** spawns a real LLMKernel process, real Claude Code subprocesses, real LiteLLM endpoint (provider mocking is OPTIONAL via LiteLLM's own test mode). Drives the kernel via the recorded sequence of inputs (cell executions, operator actions, MCP responses). Outputs are real: actual model calls happen, actual tool side effects happen, actual filesystem mutations happen against a sandboxed temporary working directory.
- **Output format:** a reconstructed `.llmnb` file at the temporary working directory, the live VS Code UI (when run in foreground mode), and a JSONL trace of all observed messages on both protocol boundaries.
- **Invariants:** all property invariants from "Property-based invariants" below MUST hold across every replayed sequence.

#### Dry replay

- **Use case:** regression test of the renderer and state-reconciliation logic; CI-cheap; no provider quota consumed.
- **Input format:** same JSONL format as live replay.
- **Driver behavior:** state simulation only. No real model calls; no filesystem mutations; no real Claude Code subprocess. Outputs are derived from the recorded log directly. The driver feeds recorded messages into the in-memory state machine and asserts the resulting state matches the recorded state at each checkpoint.
- **Output format:** reconstructed `.llmnb` file in memory only; serialized to disk solely for assertion comparison; JSONL trace of state-machine transitions.
- **Invariants:** all property invariants MUST hold; additionally, the reconstructed in-memory state at each checkpoint MUST equal the recorded state byte-for-byte after canonicalization.

#### Partial replay

- **Use case:** debugging a specific tool-call failure or single-cell behavior without running the entire scenario.
- **Input format:** same JSONL format, plus a selector specifying a single cell id, a single run id, or a single agent id. Only events matching the selector are replayed; everything else is mocked at the protocol boundary.
- **Driver behavior:** real for the selected unit; mocked elsewhere. Mocks are deterministic: every external dependency returns a fixture from the recorded log.
- **Output format:** JSONL trace of the selected unit's behavior; reconstructed cell output (if cell-scoped) or single run record (if run-scoped).
- **Invariants:** all property invariants scoped to the selected unit MUST hold; cross-unit invariants are not asserted in this mode.

The three modes share the same input format; a recording made for one mode replays in any other mode (with the appropriate level of mocking). The harness MUST emit the mode in its trace output so post-hoc analysis can distinguish recordings.

### Fault-injection scheduler

The scheduler is a Markov-style driver that takes a known-good event sequence (a "happy path" recording for some scenario, e.g., the Stage 3 paper-telephone smoke), schedules failure injections at random points using a configurable transition probability matrix (one transition per failure type from the taxonomy above), and asserts the recovery path produces a documented end state. The end-state assertion is "green" iff the operator surface shows the expected error, agent operations are halted, and the log contains the documented signature for the injected failure.

The scheduler's configuration schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "rfc004.fault-injection.scheduler.v1",
  "type": "object",
  "required": ["scenario_id", "transition_matrix", "seed", "assertion_set"],
  "properties": {
    "scenario_id": {
      "type": "string",
      "description": "Identifier of the recorded happy-path scenario to drive."
    },
    "transition_matrix": {
      "type": "object",
      "description": "Per-step injection probabilities, keyed by failure type from the taxonomy.",
      "additionalProperties": {
        "type": "number",
        "minimum": 0.0,
        "maximum": 1.0
      }
    },
    "seed": {
      "type": "integer",
      "description": "PRNG seed for reproducibility. The same seed plus the same scenario_id MUST produce the same injection schedule."
    },
    "assertion_set": {
      "type": "string",
      "enum": ["closed_fail", "invariants_only", "all"],
      "description": "Which assertion family to enforce for each injected failure."
    },
    "max_injections_per_run": {
      "type": "integer",
      "minimum": 1,
      "default": 1,
      "description": "Cap on simultaneous failures per replay. V1 default is 1 to keep failure-mode reasoning tractable."
    },
    "timeout_seconds": {
      "type": "integer",
      "minimum": 1,
      "default": 300,
      "description": "Kill-switch for a single replay run."
    }
  }
}
```

The scheduler MUST be deterministic given a fixed `seed` and `scenario_id`. A failed assertion MUST emit a reproducer block to stdout: the seed, scenario, transition matrix, the injection point, and the divergence witness.

The transition matrix's keys are exactly the failure-type identifiers from the taxonomy tables (e.g., `kernel.process_crash`, `notebook.file_corruption`, `crossboundary.heartbeat_timeout`). Unknown keys MUST cause the scheduler to refuse to start. Adding a new failure type to the taxonomy implicitly extends the schema's allowed keys.

### Property-based invariants

The kernel-side property suite uses `hypothesis` (Python). The extension-side suite uses `fast-check` (or vitest's property mode). Both suites consume the same JSONL recording format; both assert the same invariants.

Each invariant has a one-line statement plus a witness — the property-test predicate, in mathematical-style shorthand.

- **I1.** Every `run.start` has a matching `run.complete` or `run.error` within timeout T (default T=300s).
  - *Witness:* ∀ events e, ∀ run_starts r in e, ∃ matching `run.complete`/`run.error` r' in e with `r'.run_id == r.run_id` and `r'.timestamp - r.timestamp ≤ T`.
- **I2.** Every `request_approval` (RFC-001 tool) has a recorded operator response or a documented timeout-with-error within T.
  - *Witness:* ∀ events e, ∀ tool_calls t with `t.name == "request_approval"`, ∃ tool_result r' for t with `r'.timestamp - t.timestamp ≤ T`, OR ∃ `run.error` with `cause: approval_timeout` for t.
- **I3.** The in-memory state of the kernel is reconstructable from the append-only event log (state-as-fold).
  - *Witness:* ∀ events e, fold(initial_state, e) == kernel.in_memory_state at e's terminal timestamp, where fold is the reducer documented in RFC-003.
- **I4.** No two simultaneous agent operations on the same zone.
  - *Witness:* ∀ events e, ∀ pairs (op1, op2) of agent operations in e, if op1.zone == op2.zone, then their lifetime intervals do not overlap.
- **I5.** Every MCP tool call from agent to kernel produces exactly one run record.
  - *Witness:* ∀ events e, ∀ MCP tool_calls c agent→kernel in e, |{ run records r in e : r.parent_call_id == c.id }| == 1.
- **I6.** `correlation_id`s in RFC-003 envelopes are UUIDv4 and unique within a session.
  - *Witness:* ∀ events e, ∀ envelopes m in e, m.correlation_id matches UUIDv4 regex AND ∀ pairs (m1, m2) in e with m1 ≠ m2, m1.correlation_id ≠ m2.correlation_id.
- **I7.** Heartbeats arrive at the documented cadence (every 10s ± 2s) when the kernel is healthy.
  - *Witness:* ∀ events e ∩ healthy intervals, ∀ consecutive heartbeats h1, h2 in e, 8s ≤ h2.timestamp - h1.timestamp ≤ 12s.
- **I8.** Layout tree mutations preserve tree invariants (no cycles, no orphans, no duplicate ids).
  - *Witness:* ∀ events e, ∀ layout-edit envelopes m in e, post-state of layout tree after applying m is a valid tree (acyclic, single-rooted, every node reachable from root, every id distinct).
- **I9.** Agent graph mutations preserve graph invariants (no dangling edges, no impossible edge types).
  - *Witness:* ∀ events e, ∀ agent-graph mutations m in e, post-state has every edge's endpoints present as nodes AND every edge's type drawn from the documented edge-type vocabulary in DR-0014.

The invariant set above is the V1 normative minimum. Adding a new invariant is additive (does not bump the RFC major). Removing or weakening an invariant is breaking.

### Doc-driven contract test families

The protocols V1 depends on each have published specifications. The contract test families are organized by spec source. Each family walks its source spec; for each documented call/message/field, a test verifies conformance. Tests cite their doc source in comments. Coverage is tracked against the doc, not the code.

| Protocol | Doc source | Test family | Driver |
|---|---|---|---|
| VS Code Extension API | code.visualstudio.com/api | `@vscode/test-electron` suite walking each documented call V1 uses | TypeScript |
| Jupyter messaging protocol | jupyter-client.readthedocs.io | Tests verifying `display_id` in-place update behavior, `execute_request` lifecycle, `kernel_info_reply` shape | Python (mock kernel) and TypeScript (extension client) |
| LangSmith run record schema | docs.smith.langchain.com | Schema-validation tests over recorded run records; round-trip POST/event/PATCH | Python |
| MCP protocol | modelcontextprotocol.io | Tests against the official MCP test vectors (where published) plus custom RFC-001 tool round-trips | Python (server side) and TypeScript (client side) |
| RFC-001 (this project) | docs/rfcs/RFC-001-mcp-tool-taxonomy.md | Schema validation per tool; worked-example round trips | Python and TypeScript |
| RFC-003 (this project) | docs/rfcs/RFC-003-custom-message-format.md | Envelope schema validation; message-catalog round trips | Python and TypeScript |

Each family runs on every commit (per the CI cadence in chapter 07). A spec change is reflected in the test by walking the diff in the doc source; tests update with the spec, not with the implementation.

## Backward-compatibility analysis

The failure catalog evolves under the same backward-compatibility classes the RFC docket uses:

- **Additive (no version bump):** adding a new failure type with its full row in the appropriate table; adding a new replay mode that does not overlap with the existing three; adding a new property invariant; adding a new entry to the contract-test families table; widening the `assertion_set` enum with a new value at the end.
- **Deprecating (no major bump; emit a notice):** marking a failure type as obsolete while still honoring it for one major version; renaming a log signature with the old signature still emitted alongside the new one for one major version.
- **Breaking (major bump):** renaming or merging failure types; removing a failure type without deprecation; renaming a log signature without alias; changing a recovery path from closed-fail to opportunistic-retry or vice versa; removing a property invariant or weakening its witness; reordering or removing replay-harness modes; changing the harness configuration schema's required keys; changing the meaning of an `assertion_set` value.

The harness configuration schema (`rfc004.fault-injection.scheduler.v1`) carries its own version suffix in `$id`. Bumping the schema's major version is itself a breaking change to this RFC and follows the same rules.

V1 has only one version of this catalog. The framework above exists from the start so V2 evolution is tracked rather than improvised.

## Failure modes

This section is meta — it catalogues how the harness itself fails. The harness is a system under test like any other; its failure modes MUST be enumerated and recovered from, lest a green run mask a broken assertion.

| Harness failure | Trigger | Symptoms | Recovery | Log signature |
|---|---|---|---|---|
| Scheduler hangs | Bug in the Markov driver, deadlock between the driver and the system under test, exhausted PRNG state | Configured `timeout_seconds` elapses with no progress | Kill-switch terminates the run; the timeout itself is logged as a harness-side failure; the seed/scenario/matrix is emitted for offline reproduction | `harness.scheduler.timeout` |
| Recorded sequence corrupts mid-replay | Truncated JSONL, invalid envelope, monotonic-sequence violation in the input | Driver detects on read; refuses to continue past the offending record | Halt the replay; emit a structured corruption report naming the offending sequence number and byte offset | `harness.input.corrupt` |
| Hypothesis shrinker can't minimize a counterexample | Pathological input space, side effects that prevent shrinking, time budget exhausted | Hypothesis emits its largest known failing example without further minimization | Report the un-minimized counterexample with a "shrinking incomplete" flag; the counterexample is still reproducible from the seed | `harness.hypothesis.shrink_incomplete` |
| Fault injection deadlocks the SUT | The injected failure prevents progress beyond the injection point; SUT hangs without producing an end state | No green/red assertion within `timeout_seconds` (default 300s, harness deadlock budget capped at 5 minutes) | Kill-switch terminates; the deadlock is logged as a *finding*, not as a green run; reproducer block emitted | `harness.injection.deadlock` |
| Recording driver desync | The harness's own message recorder drops a message or duplicates one | Recorded JSONL fails its own self-validation pass on the next replay | Refuse to use the recording; emit a structured warning; require a fresh recording before continuing | `harness.recording.desync` |
| Property-test environment leakage | A property test mutates global state (filesystem, network, stdout) in a way that affects subsequent tests | Tests pass in isolation but fail under randomization or parallelism | Pytest/vitest isolation must be enforced; if leakage is detected, the offending test is quarantined and reported | `harness.environment.leakage` |

A green harness run is conditional on none of these harness-side signatures appearing in the run's own log. The harness's self-test suite asserts this property as part of CI.

## Worked example

End-to-end fault injection on the Stage 3 paper-telephone smoke (the `notify` tool):

**Scenario:** the agent emits a `notify` MCP tool call. The kernel logs `run.start` with the run record's `id` and routes the notification through to the extension via an RFC-003 envelope. Mid-`run.event` (between `run.start` and `run.complete`), the harness severs the kernel-extension transport (closes the underlying socket from the kernel side) — simulating the cross-boundary `crossboundary.heartbeat.timeout` failure.

**Expected recovery:**

- The extension's heartbeat watchdog fires after 30 seconds of silence.
- The extension surfaces a "kernel disconnected" structured error in the notebook status bar (red "Kernel: unresponsive") and a banner above the active cell offering "Force restart kernel".
- The cell is marked halted; the operator-facing surface shows the documented log signature `crossboundary.heartbeat.timeout`.
- No agent state mutation persisted past the failure point: the kernel's snapshot timer either ran before the injection (in which case the snapshot is durable and reflects pre-failure state) or not (in which case nothing was written).

**Property invariants checked at the assertion point:**

- *I1*: the recorded `run.start` for the `notify` call has a corresponding `run.error` synthesized by the cross-boundary recovery path with `cause: kernel_unresponsive` (as required by the cross-boundary table). PASS.
- *I3*: replay of the event log up to the failure point — feeding the JSONL through dry-replay mode — reconstructs the same in-memory state the kernel held immediately before the socket close. PASS.
- *I6*: the `correlation_id` on the `notify` envelope is a valid UUIDv4 and does not collide with any other envelope in the session. PASS.
- *I7*: heartbeats up to the injection point arrive within 10s ± 2s; after the injection, the watchdog correctly classifies the missing heartbeats as a timeout rather than a healthy interval. PASS.

**Assertion set:** `closed_fail`. The harness asserts: agent operations halted (yes — the cell is marked halted), operator surface shows expected error (yes — the status bar banner with the documented signature), log contains the documented signature (yes — `crossboundary.heartbeat.timeout` appears in the JSONL trace). Run is GREEN.

**Reproducer block emitted on success:**

```json
{
  "scenario_id": "stage3.paper_telephone.notify",
  "seed": 4242,
  "transition_matrix": { "crossboundary.heartbeat_timeout": 1.0 },
  "max_injections_per_run": 1,
  "assertion_set": "closed_fail",
  "outcome": "green",
  "injected_at_sequence": 17,
  "log_signatures_observed": ["kernel.run_tracker.start", "crossboundary.heartbeat.timeout"]
}
```

A red outcome on the same scenario emits the same block with `"outcome": "red"` and a `"divergence": <details>` field naming which assertion failed.

## Consumers

- The test harness implementation (Stage 4 T1 + T2 of the implementation plan) — implements the three replay modes and the fault-injection scheduler against this RFC's normative spec.
- The operator-facing error documentation — every log signature in the failure-taxonomy tables MUST have a corresponding operator-facing help entry naming the recovery path verbatim.
- The Stage 5 renderers — display the structured errors per the operator-surface column of each failure table; renderer tests are doc-driven against this RFC.
- The on-call playbook for V1 dogfooding — every failure type's recovery path is the playbook's runbook entry; the playbook is generated from this RFC's tables.
- The kernel's custom-messages dispatcher — raises the documented errors with the documented log signatures; signature emission is itself a contract test family.
- The replay-harness recording driver — emits JSONL conforming to the input format described in "Replay harness modes"; the driver's self-validation is a harness-side property test.

## Source

- [DR-0013](../decisions/0013-v1-feasible-with-claude-code.md) — V1 feasibility with Claude Code; testing-harness scope deferred but foundation lands.
- [DR-0015](../decisions/0015-kernel-extension-bidirectional-mcp.md) — bidirectional MCP and the paper-telephone observability property that makes replay possible.
- [Chapter 07](../dev-guide/07-subtractive-fork-and-storage.md) — testing strategy: doc-driven contract tests, Markov simulation, fault injection, lifecycle smoke tests.
- [Chapter 08](../dev-guide/08-blockers-mediator-standards.md) — RFC-004 framing: failure-mode analysis as Bell-style fault-tree analysis applied to the kernel/notebook split; the four-RFC docket; LiteLLM as a layered abstraction.
- [RFC-001](RFC-001-mcp-tool-taxonomy.md) — tool schemas referenced by I2 and I5.
- [RFC-003](RFC-003-custom-message-format.md) — envelope shape, `correlation_id`, heartbeat cadence referenced by I3, I6, I7.
