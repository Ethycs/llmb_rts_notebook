# Kernel substrate documentation

This folder documents the **LLMKernel as a legibility substrate for
agentic work** — the layer at which every MCP-mediated input is
captured with provenance, every state change becomes a typed envelope,
and every failure mode has a name. Agent supervision is a *consumer*
of that substrate, not its purpose. Coordination models like PBX /
Telephone are also consumers — they plug in through the kernel's
extension contract rather than being carved into the core.

## Distinct from the other doc folders

- [`atoms/`](../atoms/) — canonical definitions of small things
  (concepts, operations, protocols, contracts, disciplines,
  anti-patterns). Vocabulary layer.
- [`rfcs/`](../../05%20-%20Standards/rfcs/) — public boundary contracts (wire formats,
  taxonomies, transports). Normative, versioned.
- [`decisions/`](../../02%20-%20Implementation/decisions/) — the 16 original MADR-lite ADRs
  (DR-0001 — DR-0016) anchoring the architecture.
- [`notebook/`](../../03%20-%20Blueprint/) — BSPs, FSPs, and per-slice PLAN-S* files
  for the V1 notebook substrate (UI/host side).
- [`dev-guide/`](../../01%20-%20Design/dev-guide/) — narrative chapters from the original
  design conversation.
- [`bsps/`](../../03%20-%20Blueprint/) — the older single-file BSP namespace.
- [`ops/`](../../02%20-%20Implementation/ops/) — operational runbooks.
- **`kernel/` (this folder)** — substrate-level documentation about
  the kernel itself: what its load-bearing invariants are, how it
  embeds, how it deploys, how to extend it. Not getting-started
  material (that lives in [`vendor/LLMKernel/QUICKSTART.md`](../../../vendor/LLMKernel/QUICKSTART.md));
  not formal wire specs (those live in `rfcs/`).

## Files in this folder

| File | Purpose | Status |
|---|---|---|
| [`README.md`](README.md) | This index. | Present (slice 1). |
| [`identity-model.md`](identity-model.md) | Single-page reference for every kernel identifier (`agent_id`, `zone_id`, `executor_id`, `trace_id`, `run_id`, `cell_id`, `turn_id`, `manifest_id`, `claude_session_id`, `correlation_id`). | Present (slice 1). |
| [`capture-invariants.md`](capture-invariants.md) | The substrate's load-bearing properties: every-byte-resets-watchdog, malformed-lines-as-spans, tape-plus-spans, no-silent-drops, K-class error taxonomy. The "what to defend" charter. | Present (slice 1). |
| `architecture.md` | The `Kernel` facade, `Transport` protocol, `Extension` protocol. Sequence diagrams for boot, transport-bind, extension-register, shutdown. | Planned — slice 2. |
| `embedding.md` | Library-embedding guide. How to `from llm_kernel import Kernel`, drive it from a Python script / FastAPI app / Jupyter cell. Async-only contract, event-loop ownership, threadsafety. | Planned — slice 2. |
| `deployment.md` | The three surfaces (internal stdio MCP, kernel-host PTY+socket, external HTTP MCP). Auth/scope model. Session resumption. Operational concerns. | Planned — slice 3. |
| `external-mcp-reference.md` | Reference docs for the external MCP surface: tool catalog, resource catalog, notification catalog, session-id semantics. | Planned — slice 3. |
| `extensions.md` | Extension authoring guide. The `Extension` protocol contract. PBX as the worked example. Versioning + prompt-marker conventions. | Planned — slice 4. |
| `pbx.md` | PBX reference: telephone envelope shape, `dial` / `answer_call` semantics, area-code config, hop-count / TTL rules. Operator-facing. | Planned — slice 4. |

The substrate trajectory that produced this folder is recorded as a
Claude Code planning artifact at
`~/.claude/plans/let-s-sketch-this-out-deep-peacock.md` (outside the
repo). The four slices defended what is unique about the kernel
(capture invariants, failure-mode discipline, wire-format separation,
identity-model clarity) and treated every coordination model as a
downstream consumer.

## Planning artifacts

Implementation-level plans for substrate work live alongside the
reference docs here. They drove (or will drive) specific slices of
the trajectory and are kept in the repo for traceability and review.

| File | Scope | Status |
|---|---|---|
| [`PLAN-kernel-facade.md`](../../07%20-%20Status%20Reports/PLAN-kernel-facade.md) | Slice 2 — `Kernel` facade extraction. Hoists subsystem wiring into a public `Kernel` class so the kernel can be embedded as a Python object (`from llm_kernel import Kernel`). Includes design conversation summary, 8 pros / 8 cons, 10-commit decomposition, verification. | Drafted; not yet started. |

## Cross-references

**Formal contracts the kernel implements:**
- [RFC-001](../../05%20-%20Standards/rfcs/RFC-001-mcp-tool-taxonomy.md) — MCP tool taxonomy
  (the agent-facing tool surface).
- [RFC-002](../../05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md) — Claude
  Code provisioning (system prompt template, allowed-tools, spawn
  argv).
- [RFC-003](../../05%20-%20Standards/rfcs/RFC-003-custom-message-format.md) — custom
  message format (superseded in places by RFC-006 v2).
- [RFC-004](../../05%20-%20Standards/rfcs/RFC-004-failure-modes.md) — failure-mode
  taxonomy + K-class error codes.
- [RFC-006 v2](../atoms/protocols/family-d-event-log.md) — envelope
  routing (Families A/B/C/D/F/G).
- [RFC-007](../../05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md) — tape capture +
  OTLP log records.
- [RFC-008](../../05%20-%20Standards/rfcs/RFC-008-kernel-host-integration.md) — kernel
  ↔ host integration (PTY + socket).
- [RFC-009](../../05%20-%20Standards/rfcs/RFC-009-zone-control-and-config.md) — zones
  and configuration.

**ADRs the kernel embodies:**
- [DR-0012](../../02%20-%20Implementation/decisions/0012-llmkernel-sole-kernel.md) — LLMKernel
  is the sole kernel (no Jupyter kernel).
- [DR-0015](../../02%20-%20Implementation/decisions/0015-kernel-extension-bidirectional-mcp.md)
  — kernel ↔ extension bidirectional MCP.
- [DR-0010](../../02%20-%20Implementation/decisions/0010-force-tool-use-suppress-text.md) —
  force tool use; suppress agent free-text.
- [DR-0016](../../02%20-%20Implementation/decisions/0016-rfc-standards-discipline.md) — RFC
  standards discipline.

**Substrate sequencing plans:**
- [BSP-004](../../03%20-%20Blueprint/BSP-004-kernel-runtime.md) — kernel runtime
  (asyncio under uvicorn / FastAPI lifespan).
- [BSP-006](../../03%20-%20Blueprint/BSP-006-embedded-asgi.md) — embedded ASGI.

**Key code entry points** (kernel package lives in
[`vendor/LLMKernel/llm_kernel/`](../../../vendor/LLMKernel/llm_kernel/)):
- [`agent_supervisor.py`](../../../vendor/LLMKernel/llm_kernel/agent_supervisor.py)
  — agent process supervision, watchdog, restart machinery.
- [`mcp_server.py`](../../../vendor/LLMKernel/llm_kernel/mcp_server.py)
  — operator-bridge MCP server (the agent-facing surface).
- [`custom_messages.py`](../../../vendor/LLMKernel/llm_kernel/custom_messages.py)
  — RFC-006 envelope dispatcher.
- [`metadata_writer.py`](../../../vendor/LLMKernel/llm_kernel/metadata_writer.py)
  — event log + RunFrame persistence.
- [`run_tracker.py`](../../../vendor/LLMKernel/llm_kernel/run_tracker.py)
  — OTLP span lifecycle.
- [`wire/tools.py`](../../../vendor/LLMKernel/llm_kernel/wire/tools.py)
  — JSON Schema catalog for RFC-001 tools.

## Reading paths

**For a newcomer who wants to understand what the kernel is:**
1. Read this README to anchor the folder's purpose.
2. Read [`capture-invariants.md`](capture-invariants.md) — the "what
   to defend" charter explains the substrate's reason for existence.
3. Read [`identity-model.md`](identity-model.md) — the kernel's
   identifier vocabulary before reading any code.
4. Skim [RFC-008](../../05%20-%20Standards/rfcs/RFC-008-kernel-host-integration.md) to
   understand the kernel ↔ host wire.

**For a contributor about to modify the kernel:**
1. Read [`capture-invariants.md`](capture-invariants.md) — these are
   the properties your change MUST preserve.
2. Read [`identity-model.md`](identity-model.md) — the identifiers
   you'll touch.
3. Locate the relevant slice plan
   (`C:\Users\Qeyto\.claude\plans\*.md`) if implementing planned work.
4. Read the relevant RFC for any wire-visible change.

**For an extension author (after slice 2 lands):**
1. Read `architecture.md` to understand the `Kernel` facade and
   `Extension` protocol.
2. Read `extensions.md` for the authoring guide.
3. Use `pbx.md` as a worked example.
