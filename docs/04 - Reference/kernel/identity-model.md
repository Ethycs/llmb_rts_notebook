# Identity model

**Status**: V1 shipped (identifiers below are all live in the `llm_kernel`
substrate; `executor_id` is forward-declared only)
**Source specs**: [BSP-002](../../03%20-%20Blueprint/BSP-002-conversation-graph.md) (conversation graph — zone / agent / turn), [BSP-008 §6–§8](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#6-runframe--purpose) (RunFrame + ContextManifest), [RFC-002 §env](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md) (agent/zone provisioning), [RFC-006](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) (wire families), [RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md) (tape / OTLP logs)
**Related atoms**: [zone](../atoms/concepts/zone.md), [agent](../atoms/concepts/agent.md), [turn](../atoms/concepts/turn.md), [cell](../atoms/concepts/cell.md), [run-frame](../atoms/concepts/run-frame.md), [context-manifest](../atoms/concepts/context-manifest.md), [span](../atoms/concepts/span.md), [tool-call](../atoms/concepts/tool-call.md)

## Purpose

This is the single reference for every identifier the kernel uses. The
kernel threads ~10 distinct ids through provisioning, the turn DAG,
RunFrames, and the OTLP wire; without one place to look them up, a new
contributor pays a recurring cognitive tax reconstructing them from
scattered code. Each entry below gives the id's **definition**, its
**scope / uniqueness**, its **lifecycle**, its **code anchors**
(`file:line` in [`vendor/LLMKernel/llm_kernel/`](../../../vendor/LLMKernel/llm_kernel/)), and its **wire / spec anchor**.

Read the [related atoms](#see-also) for the concepts these ids name; this
doc is about the *identifiers*, not the entities.

## At a glance

| Identifier | Names… | Unique per | Minted by | Format | Primary home |
|---|---|---|---|---|---|
| [`zone_id`](#zone_id) | one notebook / `.llmnb` session | file (lifetime) | host (provisioned) | UUID / string | `metadata.rts.zone.zone_id` |
| [`agent_id`](#agent_id) | one executor ref in a zone | zone | operator / host | operator name (`alpha`) or UUID | `metadata.rts.zone.agents.<agent_id>` (dict key) |
| [`executor_id`](#executor_id) | who ran a RunFrame | run frame | AgentSupervisor | string — **always `== agent_id`** | `run_frames.<run_id>.executor_id` |
| [`turn_id`](#turn_id) | one immutable turn (DAG node) | zone | host (append_turn) | `t_<ULID>` string | `agents.<id>.turns[].id` |
| [`cell_id`](#cell_id) | one overlay issuance site | notebook | VS Code | notebook-cell URI | `metadata.rts.cells[<cell_id>]` |
| [`run_id`](#run_id) | one cell run (RunFrame) | zone | AgentSupervisor | UUIDv4 hex | `run_frames.<run_id>` |
| [`manifest_id`](#manifest_id) | one ContextPacker output | zone | ContextPacker | UUIDv4 | `context_manifests.<manifest_id>` |
| [`claude_session_id`](#claude_session_id) | one Claude Code CLI conversation | agent (mutable) | kernel | UUIDv4 | `turns[].claude_session_id`, `session.claude_session_id` |
| [`trace_id`](#trace_id) | one kernel run's OTLP trace | kernel process | kernel | 32-lowercase-hex | span `traceId`; `LLMKERNEL_RUN_TRACE_ID` |
| [`correlation_id`](#correlation_id) | one wire envelope / request-response pair | envelope | emitter | UUIDv4 or OTLP id | envelope `correlation_id` |

Two ids in this table are **overloaded on purpose** — read their sections:
`run_id` means one thing in the RunFrame subsystem and another in the OTLP
run-tracker (where it equals a span id), and `correlation_id` collapses to
the span id on Family A.

---

## `zone_id`

**Definition.** The kernel-side session identifier: one notebook = one
`.llmnb` file = one `zone_id`. The zone IS the connected turn DAG — all
[turns](../atoms/concepts/turn.md), [agents](../atoms/concepts/agent.md),
run frames, manifests, and blobs for one notebook live under it. See the
[zone atom](../atoms/concepts/zone.md).

**Scope / uniqueness.** Unique per `.llmnb` file; immutable for the file's
lifetime. There is no sub-zone or cross-zone concept in V1.

**Lifecycle.** Provisioned at agent spawn as the `LLMKERNEL_ZONE_ID`
environment variable ([RFC-002 §env](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md)); persisted at `metadata.rts.zone.zone_id`; dies with the file.

**Code.**
[`_kernel_hooks.py:148`](../../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py) reads `LLMKERNEL_ZONE_ID` (default `"default"`);
[`_provisioning.py:366`](../../../vendor/LLMKernel/llm_kernel/supervision/_provisioning.py) writes it into the spawned agent's env;
[`mcp_server.py:147`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py) stores `self.zone_id`;
`AgentSupervisor.spawn(zone_id, agent_id, …)` ([`agent_supervisor.py:307`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)).

**Wire / spec.** `llmnb.zone_id` is a situational span attribute on Family A
([RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md)); provisioning env in [RFC-002 §env](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md); storage in [RFC-005](../../05%20-%20Standards/rfcs/RFC-005-llmnb-file-format.md).

## `agent_id`

**Definition.** The name of one registered semantic executor — a mutable
ref into the turn DAG (git-branch analog), plus the runtime state of the
underlying `claude-code` process. See the [agent atom](../atoms/concepts/agent.md).

**Scope / uniqueness.** Unique per [zone](#zone_id); it is the dict key at
`metadata.rts.zone.agents.<agent_id>` (not a duplicated field). Operator-facing
in practice (`alpha`, `beta`).

**Lifecycle.** Chosen by the operator at `/spawn` (or defaulted); provisioned
as `LLMKERNEL_AGENT_ID`; survives notebook close → reopen via the
`metadata.rts` hydrate path. A restart after death re-spawns under a fresh
`agent_id`; prior run records stay attributed to the dead one
([RFC-002 §restart](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md)).

**Code.**
`AgentHandle.agent_id` field ([`agent_supervisor.py:90`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py));
`LLMKERNEL_AGENT_ID` read at [`_kernel_hooks.py:147`](../../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py) (default `"kernel"`), written at [`_provisioning.py:366`](../../../vendor/LLMKernel/llm_kernel/supervision/_provisioning.py);
`self.agent_id` at [`mcp_server.py:146`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py).

**Wire / spec.** `llmnb.agent_id` is a *mandatory* Family A span attribute
([RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md)); provisioning contract in [RFC-002 §env](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md); data model in [BSP-002 §2.2](../../03%20-%20Blueprint/BSP-002-conversation-graph.md#22-agent).

> **Naming note.** [RFC-002 §env](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md) describes `LLMKERNEL_AGENT_ID` as a kernel-issued **UUID v4**, but the shipped BSP-002 data model and the atoms treat `agent_id` as the **operator-chosen name** (`alpha`, `beta`) used as the `agents` dict key. Both forms are valid strings on the wire; the kernel does not enforce UUID shape.

## `executor_id`

**Definition.** The RunFrame field naming *which executor ran the cell*. It
is a **forward declaration**: the schema reserves an executor abstraction
distinct from the agent, but **no executor abstraction has landed** — today
`executor_id` **always equals [`agent_id`](#agent_id)**.

**Scope / uniqueness.** One value per [RunFrame](#run_id); required, non-empty.

**Lifecycle.** Written by the AgentSupervisor at each RunFrame emit (start
and terminal), sourced verbatim from the running agent's `agent_id`.

**Code.** The equality is literal at every call site:
`executor_id=agent_id` in the terminal-frame emits at
[`agent_supervisor.py:706`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py) and [`agent_supervisor.py:748`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py);
`_submit_terminal_run_frame(executor_id: str, …)` at [`agent_supervisor.py:922`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py);
writer-side required-field validation at [`_writer.py:2731`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py).

**Wire / spec.** [BSP-008 §7 RunFrame schema](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#7-runframe-v1-minimal-schema) is explicit — the field is
annotated `executor_id: string  // agent_id (BSP-002 §2.2)`, and the §9
pseudocode assigns `executor_id: agent.id`. See also the [run-frame atom](../atoms/concepts/run-frame.md) ("`executor_id` matches `agent.id`"). A real executor/agent split would land additively in V2.

## `turn_id`

**Definition.** The immutable id of one [turn](../atoms/concepts/turn.md) —
a single operator-or-agent message, a node in the append-only turn DAG.
Stored as the turn record's `id`. Format `t_<ULID>` (e.g. `t_01HZX7K3…`).

**Scope / uniqueness.** Unique zone-wide (enforced across all agents, not
just per-agent — PLAN-S4.1 §3.A). Immutable once persisted; re-running a
cell creates a **new** turn, never mutates one.

**Lifecycle.** Minted **host-side** (the extension) and supplied in the
`append_turn` intent; the kernel *validates and persists* it but does not
mint it. Referenced thereafter by `parent_id`, the agent's mutable
`head_turn_id` / `last_seen_turn_id`, and RunFrame `turn_head_before` /
`turn_head_after`.

**Code.**
`_handle_append_turn` reads `params["id"]` (alias `turn_id`), requires it,
and rejects duplicates ([`_writer.py:1051`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py), id required at [`_writer.py:1071`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py), dup-check at [`_writer.py:1100`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py));
zone-wide uniqueness set at [`_writer.py:987`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py);
`last_seen_turn_id` on `AgentHandle` ([`agent_supervisor.py:124`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py));
`_notebook_head_turn_id()` ([`agent_supervisor.py:297`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)).

**Wire / spec.** Turn schema and DAG rules in [BSP-002 §2.1](../../03%20-%20Blueprint/BSP-002-conversation-graph.md#21-turn); appears in RunFrame as `turn_head_before` / `turn_head_after` ([BSP-008 §7](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#7-runframe-v1-minimal-schema)).

## `cell_id`

**Definition.** The id of one [cell](../atoms/concepts/cell.md) — the
operator-scoped issuance site in the notebook overlay. It is **VS Code's
notebook-cell URI** (`vscode-notebook-cell:.../#abc`), not a kernel-minted
key.

**Scope / uniqueness.** Unique per notebook document. On a turn it is a
**back-reference** (`turn.cell_id`), not a primary key: splitting / merging
cells updates the back-reference but does not move turns. RunFrames pin to
the *original* `cell_id` across overlay edits (decision S5).

**Lifecycle.** Created by VS Code when a cell is created; travels with the
cell payload into every `execute_request`; recorded on turns, spans,
RunFrames, and ContextManifests.

**Code.**
Cell records keyed by `cell_id` in the writer's cells map ([`_writer.py:116`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py));
threaded through the run-frame emits as `cell_id=…` ([`agent_supervisor.py:705`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py)); required-field check in `record_run_frame` ([`_writer.py:2696`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py)).

**Wire / spec.** `llmnb.cell_id` situational span attribute
([RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md)); cell schema in [BSP-002 §6](../../03%20-%20Blueprint/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) and [RFC-005](../../05%20-%20Standards/rfcs/RFC-005-llmnb-file-format.md).

## `run_id`

> **Overloaded.** `run_id` names two different things depending on
> subsystem. Read both senses.

**Sense 1 — RunFrame id (the primary sense here).**
The id of one cell run, i.e. one [RunFrame](../atoms/concepts/run-frame.md).
Unique per [zone](#zone_id); the storage key at
`metadata.rts.zone.run_frames.<run_id>`. Append-only across distinct
`run_id`s, but **idempotent on `run_id`** for the start→terminal status
update (one `run_id` gets a `status: running` frame then a terminal frame).

- **Lifecycle.** Minted by the AgentSupervisor as `uuid.uuid4().hex` at run
  start; the same value is reused for the terminal frame.
- **Code.** minted at [`agent_supervisor.py:877`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py);
  validated / stored by `record_run_frame` at [`_writer.py:2721`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) (K102 on `run_id` collision with a different `cell_id`).
- **Wire / spec.** [BSP-008 §7–§8](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#7-runframe-v1-minimal-schema); `llmnb.run_id` appears on RunFrame telemetry spans.

**Sense 2 — OTLP run-tracker run id (`== spanId`).**
In the run-tracker / MCP surface, "run" means one OTLP span, and its
`run_id` **is the span id** (16-lowercase-hex). `RunTracker.start_run(...)`
returns the `span_id` and callers pass it back as `run_id` to
`event` / `complete` / `fail`. This span-id `run_id` is what becomes the
Family A `correlation_id` (see [`correlation_id`](#correlation_id)).

- **Code.** `start_run(...)` returns `span_id` and emits `run.start` with
  `correlation_id=span_id` ([`run_tracker.py:289`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py)); `event(run_id, …)` / `complete(run_id, …)` use it as the key ([`run_tracker.py:292`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py), [`run_tracker.py:316`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py)); MCP-side tool runs mint `run_id = _secrets.token_hex(8)` ([`mcp_server.py:346`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py)).
- **Wire / spec.** [RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) — the Family-A attribute table maps `correlation_id → spanId` (which is also the `display_id`).

These two are not linked in V1: a RunFrame `run_id` (a UUID) is not the
same value as the OTLP `run_id`/`spanId` (16-hex) of the spans produced
during that run.

## `manifest_id`

**Definition.** The id of one [ContextManifest](../atoms/concepts/context-manifest.md) — the deterministic,
persisted record of what context ContextPacker selected for one cell run.

**Scope / uniqueness.** Unique per [zone](#zone_id); storage key at
`metadata.rts.zone.context_manifests.<manifest_id>`. Every RunFrame carries
a `context_manifest_id` pointing here; the pair is what makes a run
end-to-end inspectable.

**Lifecycle.** Minted **fresh per `pack()` call** — ContextPacker is a pure
function *except* for the freshly generated `manifest_id` and `generated_at`.
Persisted (append-only) via a `record_context_manifest` intent the
AgentSupervisor wraps around the pure output; never deleted.

**Code.**
minted `str(uuid.uuid4())` at [`context_packer.py:327`](../../../vendor/LLMKernel/llm_kernel/capture/context_packer.py);
validated / stored by `record_context_manifest` at [`_writer.py:2370`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py) (required-field check; storage key note at [`_writer.py:2351`](../../../vendor/LLMKernel/llm_kernel/capture/metadata_writer/_writer.py));
wired to the RunFrame as `context_manifest_id=manifest_id` at [`agent_supervisor.py:749`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py).

**Wire / spec.** [BSP-008 §4](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#4-contextmanifest-schema) (schema) and [§7](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#7-runframe-v1-minimal-schema) (RunFrame linkage via `context_manifest_id`).

## `claude_session_id`

**Definition.** The id of one **Claude Code CLI conversation** — passed to
the process as `--session-id` and used with `--resume` to pick a
conversation back up. Kernel-owned (the kernel mints it, not the CLI).

**Scope / uniqueness.** Bound to an [agent](#agent_id) at a point in time,
but **not immutable on the agent**: `/branch` and `/revert` assign a *new*
session at the next continuation. Because pre-revert turns must keep the
session that produced them, `claude_session_id` is recorded on **each turn**
as well as on the agent's mutable `session`.

**Lifecycle.** Minted `str(uuid.uuid4())` on a fresh spawn; reused via
`resume_claude_session_id` on respawn / idle-resume so `--resume` reattaches;
round-trips through `metadata.rts` so idle agents survive close → reopen.

**Code.**
`AgentHandle.claude_session_id` field ([`agent_supervisor.py:120`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py));
minted at [`agent_supervisor.py:373`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py), resume path at [`agent_supervisor.py:370`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py); fresh session minted for the next continue on revert around [`agent_supervisor.py:1314`](../../../vendor/LLMKernel/llm_kernel/supervision/agent_supervisor.py).

**Wire / spec.** Field on the turn schema in [BSP-002 §2.1](../../03%20-%20Blueprint/BSP-002-conversation-graph.md#21-turn) (and the [turn atom](../atoms/concepts/turn.md)); provisioning in [RFC-002](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md).

> **Not the kernel session id.** Distinct from the kernel-host session id
> `LLMKERNEL_SESSION_ID` (serve / PTY transports, health-probe
> `kernel_session_id`) and from the OTLP `llmnb.session_id` tape attribute
> ([RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md)). `claude_session_id` is specifically the CLI conversation; those name the kernel process's own session.

## `trace_id`

**Definition.** The OTLP `traceId` for one kernel run — the trace under
which every [span](../atoms/concepts/span.md) the kernel emits is grouped.
Format: 32-lowercase-hex (16 random bytes), per OTLP.

**Scope / uniqueness.** One `trace_id` per kernel run/process (all spans for
that run share it, distinguished by their own `spanId`).

**Lifecycle.** Sourced from `LLMKERNEL_RUN_TRACE_ID` (provisioned into the
agent env) or minted fresh if absent. A UUID input is accepted and coerced
to 32-hex so the kernel never emits a malformed `traceId`.

**Code.**
read / fallback at [`_kernel_hooks.py:149`](../../../vendor/LLMKernel/llm_kernel/_kernel_hooks.py);
`_new_trace_id()` (32-hex) and `_coerce_trace_id()` at [`run_tracker.py:83`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py);
MCP-side coercion (UUID→hex) at [`mcp_server.py:148`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py), stamped onto spans as `"traceId": self.trace_id` ([`mcp_server.py:433`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py));
provisioned into agent env as `LLMKERNEL_RUN_TRACE_ID` ([`_provisioning.py:209`](../../../vendor/LLMKernel/llm_kernel/supervision/_provisioning.py)).

**Wire / spec.** Top-level OTLP field on every Family A span
([RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md)); cross-referenced by `.tape` log records via native `traceId` / `spanId` ([RFC-007 §per-line](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md)).

## `correlation_id`

**Definition.** The envelope-level id used to (a) pair a request with its
response and (b) route a span-carrying envelope. Not a single entity id —
its meaning depends on the RFC-006 family carrying it.

**Scope / uniqueness.**
- **Family A (run lifecycle):** `correlation_id` **is the `spanId`** (also
  the Jupyter `display_id`) — i.e. the OTLP-sense [`run_id`](#run_id).
- **Families B/C/F/G (comm channel):** a UUIDv4 in the thin envelope;
  **required** for request/response pairing (Family C
  `agent_graph.query` ↔ `.response` must share it), optional-and-for-tracing
  otherwise.
- **MITM / provider passthrough:** a per-HTTP-flow UUID pairing intercepted
  request/response rows.

**Lifecycle.** For Family A, equals the span id minted at `start_run`. For
comm envelopes, preserved from the inbound envelope if present, else minted
fresh (`str(uuid.uuid4())`). For provider passthrough, minted by the mitm
addon per flow and carried on both request and response records.

**Code.**
envelope constructor + validation (accepts OTLP hex or UUID) at [`run_envelope.py:77`](../../../vendor/LLMKernel/llm_kernel/capture/run_envelope.py) (docstring: "`correlation_id` is a UUIDv4 string (the `run_id` for Family A)");
thin-envelope preserve-or-mint at [`custom_messages.py:126`](../../../vendor/LLMKernel/llm_kernel/capture/custom_messages.py);
Family C required-field type at [`wire/families.py:70`](../../../vendor/LLMKernel/llm_kernel/wire/families.py);
Family A emit `correlation_id=span_id` at [`run_tracker.py:289`](../../../vendor/LLMKernel/llm_kernel/capture/run_tracker.py);
run lookup by correlation at [`mcp_server.py:855`](../../../vendor/LLMKernel/llm_kernel/mcp/mcp_server.py);
mitm addon per-flow id at [`_mitm_addon.py:65`](../../../vendor/LLMKernel/llm_kernel/providers/_mitm_addon.py).

**Wire / spec.** [RFC-006 §1](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) (Family A: `correlation_id → spanId`), [§3](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) (thin comm envelope), [§5](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) (Family C pairing). Every `wire/schemas/family-*.json` declares the field.

---

## How they relate

### Containment (storage nesting)

```
zone (zone_id)                         one .llmnb file
└── agents { agent_id → … }            per-zone executor refs
    ├── turns[ { turn_id, cell_id,     immutable DAG nodes;
    │            claude_session_id } ] cell_id is a back-ref
    │   └── spans[ { spanId, traceId } ]   tool-calls / prose (OTLP)
    └── session { head_turn_id,        mutable agent ref +
                  claude_session_id }  current CLI conversation
├── cells { cell_id → … }             operator overlay (VS Code URIs)
├── run_frames { run_id → {           one per cell run
│       cell_id,                       which cell ran
│       executor_id  (== agent_id),    who ran it  ← forward-declared
│       turn_head_before / _after,     turn_id deltas = the contribution
│       context_manifest_id } }        → the manifest it saw
└── context_manifests { manifest_id }  what ContextPacker selected
```

The conceptual chain an operator reasons about is
**zone ⊃ agent ⊃ turn ⊃ span (tool-call)**; the notebook overlay adds
**cell** as the issuance site each turn back-references.

### RunFrame ↔ ContextManifest linkage

One cell run ties four ids together, and is the unit Inspect mode replays:

```
run_id ──1:1──▶ RunFrame
   │              ├─ cell_id              (which cell — pinned across edits)
   │              ├─ executor_id  == agent_id   (who)
   │              ├─ turn_head_before / turn_head_after   (what changed in the DAG)
   │              └─ context_manifest_id ──▶ manifest_id  (what the agent saw)
   └─ (this run's OTLP spans carry their own trace_id / spanId /
       correlation_id — NOT this run_id)
```

- **RunFrame → ContextManifest** is `run_frames.<run_id>.context_manifest_id
  → context_manifests.<manifest_id>` — the pair answers *"what context did
  the agent see, and what did it change?"* ([BSP-008 §6](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md#6-runframe--purpose)).
- **RunFrame → turn DAG** is the `turn_head_before` / `turn_head_after`
  pair; their diff is the agent's contribution for that run.
- **`executor_id` = `agent_id`** today — the executor column is a schema
  seat kept warm for a future executor/agent split.

### Identifier families by origin

| Origin | Identifiers |
|---|---|
| Provisioned into the agent env (RFC-002) | `zone_id`, `agent_id`, `trace_id` (`LLMKERNEL_RUN_TRACE_ID`) |
| Minted by the host / VS Code | `turn_id`, `cell_id` |
| Minted by the kernel at runtime | `run_id` (RunFrame), `manifest_id`, `claude_session_id`, OTLP `run_id`/`spanId`, `correlation_id` |
| Derived / aliased | `executor_id` (= `agent_id`); Family A `correlation_id` (= `spanId`) |

## See also

- [zone](../atoms/concepts/zone.md) — the `zone_id` entity.
- [agent](../atoms/concepts/agent.md) — the `agent_id` entity and session state.
- [turn](../atoms/concepts/turn.md) — `turn_id`, and why `claude_session_id` lives per-turn.
- [cell](../atoms/concepts/cell.md) — the `cell_id` overlay entity.
- [run-frame](../atoms/concepts/run-frame.md) — `run_id`, `executor_id`, `turn_head_*`, `context_manifest_id`.
- [context-manifest](../atoms/concepts/context-manifest.md) — the `manifest_id` entity.
- [span](../atoms/concepts/span.md) / [tool-call](../atoms/concepts/tool-call.md) — where `traceId` / `spanId` / `correlation_id` live on the wire.
- [capture-invariants.md](capture-invariants.md) — the substrate properties these ids serve.
- [RFC-006](../../05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) — wire families and the `correlation_id`/`spanId` mapping.
- [BSP-008](../../03%20-%20Blueprint/BSP-008-contextpacker-runframes.md) — RunFrame + ContextManifest, the `executor_id` forward-declaration.
