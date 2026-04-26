# 08 — Remaining blockers, kernel mediator role, and standards discipline

## Purpose

By the end of [chapter 07](07-subtractive-fork-and-storage.md) the architecture is settled: VS Code host, subtractive fork, NotebookController, bidirectional MCP, forced tool use, LLMKernel as sole kernel, three storage structures embedded in one `.llmnb` file. What remains are the integration risks that gate V1 implementation — the exact MCP tool taxonomy, the procedure for provisioning Claude Code against the kernel, the kernel-extension custom message catalog, the failure-mode harness — plus a meta-question: what discipline governs how those pieces get specified.

This final chapter catalogues what is locked, names the integration-risk blockers that remain, fixes LLMKernel's role as MCP/PTY mediator, and adopts a Bell System–inspired standards discipline as the engineering culture that will close out the design phase. The two decisions locked here ([DR-0015](../../_ingest/manifests/decisions.json), [DR-0016](../../_ingest/manifests/decisions.json)) are not new architecture; they are the framing under which the remaining work gets done.

## Resolved versus outstanding

After eight phases of design, the architecture is substantially settled. The discipline of this chapter is to be honest about which questions are answered and which still have integration risk hiding inside them.

**Resolved by chapters 02–07** (no longer open):

- *RTS-as-orchestrator metaphor.* Operator commands a fleet of agents; map view is one tab among several. ([DR-0001](../../_ingest/manifests/decisions.json))
- *Hypergraph data model.* Agents author edges; observability is a temporal multiplex graph. ([DR-0002](../../_ingest/manifests/decisions.json))
- *V1 scope cuts.* 3D/VR, macOS, SSH, bubblewrap, live policy, event sourcing, NATO, VegaFusion, the magic CLI — all explicitly out. ([DR-0005](../../_ingest/manifests/decisions.json))
- *VS Code as host.* Marketplace distribution, free diff API, free file navigation, free workspace context. ([DR-0007](../../_ingest/manifests/decisions.json))
- *NotebookController, no Jupyter kernel.* Cell execution is a TypeScript callback in the extension host. ([DR-0009](../../_ingest/manifests/decisions.json))
- *Bidirectional MCP as chat protocol.* Operator-as-server, agent-as-client; tool calls are conversation primitives. ([DR-0008](../../_ingest/manifests/decisions.json))
- *Forced tool use.* Agent text channel suppressed; only structured tool calls reach the operator surface. ([DR-0010](../../_ingest/manifests/decisions.json))
- *Subtractive fork of vscode-jupyter.* Cut Python integration, IPyWidgets, remote servers, debugging, viewers. ([DR-0011](../../_ingest/manifests/decisions.json))
- *LLMKernel as sole kernel.* Hardcoded; no kernel discovery ceremony. ([DR-0012](../../_ingest/manifests/decisions.json))
- *Three storage structures, one file.* Tree for layout, graph for agents, JSON flow for chat — all in `.llmnb`. ([DR-0014](../../_ingest/manifests/decisions.json))
- *Streaming protocol.* LangSmith POST/event/PATCH semantics with Jupyter `display_id` for in-place updates. Append-only, replayable, OTel-shaped.
- *Branching.* Git is the branching mechanism; the notebook is a live record under version control.
- *Failure split.* Hard break between kernel-level and notebook-level failures; different error surfaces for each.

**Outstanding (the work this chapter frames):**

- *Exact MCP tool taxonomy.* The set of tools the agent sees is sketched (`ask`, `clarify`, `propose`, `request_approval`, `report_progress`, `present`, `notify`, `escalate`) but each lacks a locked JSON schema, return shape, error semantics, and example payload. The taxonomy is the agent's communicative grammar; until it is normative, every renderer and every agent integration drifts on inconsistent assumptions.
- *Provisioning procedure for Claude Code.* The exact recipe for spawning a Claude Code subprocess that talks to the kernel's MCP server and the kernel's LiteLLM endpoint — system prompt, environment variables, MCP config JSON, working directory, allowed-tool restrictions, restart logic. This is the riskiest unknown because it is where reality intrudes on architecture.
- *LLMKernel codebase integration patterns.* How the kernel hosts its MCP server alongside its LiteLLM proxy; how it routes between native operator-interaction tools and proxied system tools; the run-tracker that emits POST/event/PATCH records to cell output via the kernel display protocol; the agent-process supervisor that captures stdout/stderr without leaking text to the operator surface.
- *Custom message catalog.* The Jupyter messaging protocol allows custom message types but requires that they be defined. Layout-state updates, agent-graph queries, operator actions, run lifecycle records — each needs an explicit envelope, direction, schema, and semantics. Without the catalog, kernel and extension share no vocabulary.
- *Fault-injection / Markov-chain test harness.* Replay is mentioned across earlier chapters but its semantics are not specified. Live replay vs. dry replay vs. partial replay; same-kernel vs. fresh-kernel; real-tools vs. mocked-tools; output as reconstructed `.llmnb` vs. live VS Code UI vs. JSONL — all are choices that affect what the harness is for.

The shape of the remaining work is consistent: design exercises that need writing down, then small prototypes that verify reality matches the writing. The discipline that produces good written designs is the meta-question this chapter answers.

## LLMKernel as MCP/PTY mediator (DR-0015)

[DR-0015](../../_ingest/manifests/decisions.json) gives LLMKernel a precise role. It is not a passive tool-call broker; it is a pseudoterminal-style intermediary that sits in the path of every agent interaction with the outside world. The framing the user proposes for this is "paper telephone" — every link in the chain holds the message in a stable, inspectable form before passing it on.

### The three layers

The kernel's responsibilities decompose into three layers, all running in one Python process:

1. *Standard MCP server.* The kernel hosts an MCP server that agents connect to as clients. Native tools — the operator-interaction primitives from [chapter 06](06-vscode-notebook-substrate.md) — live here. Proxied tools (filesystem read/write, shell exec, search) are also registered, but the kernel mediates them: every call is logged, optionally transformed, then forwarded to a real implementation.
2. *LiteLLM endpoint.* The kernel exposes an OpenAI-compatible HTTP endpoint that agents configure as their API base. Every model call routes through this endpoint to LiteLLM's provider abstraction. The kernel can cache, redirect across providers, inject system messages, throttle, and log uniformly regardless of whether the agent is calling Anthropic, OpenAI, Google, or Ollama.
3. *Frontend delivery.* Once an interaction is captured and processed, the kernel produces a LangSmith-shaped run record and emits it to the extension via Jupyter messaging with `display_id` semantics. The extension renders; the operator sees structured events.

The PTY analogy is precise. A Unix PTY sits between two processes pretending to be a terminal to each, observing and potentially transforming everything that flows through. Programs talking through a PTY usually do not know they are being mediated. LLMKernel does the analogous thing for an agent: from the agent's perspective, it is making LLM calls (via LiteLLM) and tool calls (via MCP) like any other agent. From the operator's perspective, structured events flow into the extension. From the kernel's perspective, every interaction is observable, modifiable, and replayable.

### The "paper-telephone" property

The kernel's PTY role plus bidirectional MCP between kernel and extension produces a particular topology:

```
Operator <-> Extension <-> LLMKernel (PTY + LiteLLM) <-> Agent <-> Model
                              ^
                              |
                     hosts native + proxied tools
                     hosts LiteLLM endpoint
                     hosts kernel-protocol server
```

Every arrow is bidirectional. Every node holds the message in a structured form (a LangSmith run record) before passing it on. The "paper" is the JSON record; every link writes its part of the trail before forwarding. The chain is observable end-to-end and replayable from the trail.

The bidirectionality between the kernel and the extension is what makes this distinct from plain operator-as-MCP-server (DR-0008). Both sides expose tool surfaces:

- *Extension as MCP server (kernel calls into it).* Tools the kernel needs to drive the operator's UI: `show_diff(file_a, file_b)`, `navigate_to(file, line)`, `display_widget(widget_spec)`, `prompt_operator(prompt_spec)`, `notify(message, urgency)`, `open_panel(panel_id)`, `update_status(state)`, `highlight(file, region)`.
- *Kernel as MCP server (extension and agents call into it).* Tools the extension or agent needs to drive kernel state: `execute_cell(cell_id, content)`, `pause_agent(agent_id)`, `resume_agent(agent_id)`, plus the operator-interaction tools (`ask`, `clarify`, `propose`, etc.) that agents see as their conversation primitives.

Each side is both client and server. There is no "rendering protocol" special-cased outside MCP; everything that crosses the kernel-extension boundary is an MCP-shaped tool call.

### Why bidirectional is required, not aesthetic

The temptation is to make the extension a pure renderer and the kernel a pure backend. That arrangement fails because each side needs to drive UI on the other:

- The kernel needs to ask the extension to show a diff or focus a panel — those are operations the extension owns and only the extension can perform.
- The extension needs to tell the kernel that the operator clicked approve, edited a cell, or switched zones — those are operations the kernel owns and only the kernel can resolve.
- Tool calls flowing from agent through kernel sometimes need operator response (the `prompt_operator` round-trip): kernel forwards to extension, extension renders UI, operator answers, extension calls back into kernel, kernel returns the tool result to the agent.

Modeling each leg as a tool call in the appropriate direction means the same protocol shape (typed RPC, JSON-RPC envelope, schema-validated payload) covers every cross-component message. Adding a new capability means defining a new tool, not inventing a new message type. Replacing the extension (CLI, web, mobile) means reimplementing the MCP-client side.

### What the kernel becomes

With this framing, LLMKernel is the trust boundary, the audit boundary, and the modification boundary for everything an agent does:

- Agents are configured to use the kernel's endpoints exclusively. No direct API keys to providers; no direct shell access; no MCP servers configured outside the kernel's control.
- What the kernel allows, agents can do; what the kernel blocks, they cannot.
- Everything is logged because everything flows through the kernel.
- Every interaction is potentially modifiable — context injection, model redirection, replay-from-checkpoint all happen at this layer.

The user's framing of this in turn 111 — "we don't really care what the model context does as long as we can control its functionality" — is the load-bearing scope claim. The product hypothesis is that bidirectional, mediated, observable control over agent I/O is more valuable than improvements to agent reasoning. The kernel is the implementation of that hypothesis.

## Bell System–inspired standards discipline (DR-0016)

[DR-0016](../../_ingest/manifests/decisions.json) adopts a specific engineering culture as the meta-pattern that governs the remaining design work. The user's directive in turn 121 is unusually concrete: for blocker 1 (tool taxonomy), "what would Bell Telephone do? do that here, write an RFC." For blocker 4 (LiteLLM proxy integration), "treat LiteLLM as TCP/IP stack." The Bell System reference is not decorative; it names a specific discipline.

### What the Bell System discipline contributes

The Bell System (AT&T's pre-divestiture engineering organization, plus Bell Labs) ran on a culture in which protocols and interfaces were specified as numbered, normative documents *before* implementation. The relevant elements:

- *Numbered RFCs and standards documents.* Every protocol has a written specification with a number, a status (proposed, draft, normative), and a maintained history. The document is authoritative; the implementation conforms to the document. When the document changes, the change is itself a document.
- *Backward compatibility as a first-class concern.* New versions do not silently break old clients. Compatibility is analyzed up-front; deprecation paths are specified; the document records the analysis.
- *Fault-tree analysis.* Reliability is engineered via systematic enumeration of failure modes. Each component's failure modes are documented; their composition is analyzed; the resulting fault tree drives test coverage and operational procedures.
- *Layered abstractions with stable interfaces.* The OSI model, Bell's earlier seven-layer thinking, and TCP/IP after it all work because each layer presents a stable interface to the layer above and depends on a stable interface below. The layer's internal implementation can change without invalidating its consumers.
- *Documentation precedes implementation.* The spec is written first, reviewed against requirements, and only then handed to implementation. The implementation's job is to satisfy the spec; the spec's job is to be coherent with the rest of the system.

This is uncommon discipline for a small project. It is also exactly what is needed when the unresolved blockers are integration risks at protocol boundaries.

### Why this fits V1 specifically

The remaining blockers are precisely the kind of work that the Bell discipline addresses well:

- *Tool taxonomy is a protocol specification.* Each tool has a name, an input schema, an output schema, error cases, and semantics. That is an RFC's natural shape.
- *Provisioning Claude Code is a procedure.* Procedures are specified, version-numbered, and updated. They are not folklore. A document that specifies environment variables, MCP config layout, system prompt template, and allowed-tool list — with a worked example — is a Bell-style provisioning RFC.
- *Custom message catalog is an interface specification.* The kernel-extension boundary is exactly where Bell-style specs add value: two implementations, one specification, the spec is the contract.
- *Failure-mode analysis is fault-tree analysis.* Cataloguing how each component fails, how failures compose, and what the recovery surface looks like is the Bell discipline applied to the kernel/notebook split locked earlier.
- *LiteLLM as a layered abstraction.* The user's "treat LiteLLM as TCP/IP stack" framing is precise. LiteLLM presents a stable interface (OpenAI-compatible) over a varying lower layer (provider APIs). V1 commits to that interface and does not reimplement provider routing.

### What this changes about the design phase

Adopting the Bell discipline means the design phase ends with documents, not code. Specifically:

- Each remaining blocker becomes one numbered RFC.
- RFCs are written before the corresponding implementation begins.
- RFCs specify schemas, procedures, and failure modes normatively — not aspirationally.
- Backward-compatibility analysis is part of every RFC even if V1 has only one schema version, so the analysis framework exists from the start.
- Fault-tree analysis is part of every RFC that specifies a runtime behavior.
- Implementations conform to RFCs; deviations require RFC updates.

The cost is a week of writing instead of a week of coding. The benefit is that integration risks are surfaced as written ambiguities instead of as runtime surprises in week 4.

## Concrete RFC docket

The four RFCs that need to be written before V1 implementation begins, each corresponding to one of the outstanding blockers from the earlier table:

### RFC-001 — V1 MCP tool taxonomy

*What it specifies:* the complete list of MCP tools the kernel hosts and exposes to agents in V1, with normative schemas.

*Contents:*

- Tool list: `ask`, `clarify`, `propose`, `request_approval`, `report_progress`, `report_completion`, `report_problem`, `present`, `notify`, `escalate`, plus a small set of proxied system tools (`read_file`, `write_file`, `run_command`). Target is roughly 9–12 tools for V1.
- For each tool: name, one-line description, input JSON Schema, output JSON Schema, error cases, semantic notes (idempotence, side effects, expected operator response time), one worked example payload.
- Native vs. proxied designation per tool: native = operator-interaction (kernel implements directly); proxied = system tool (kernel mediates a real implementation).
- Backward-compatibility analysis: what counts as a breaking change to a tool schema (renamed field, type change, removed field, semantic change); what counts as additive (new optional field, new tool); how versions are signaled.

*Consumers:* every renderer in the extension; every agent integration; the run-tracker emitting LangSmith records; the test harness.

*Cost:* one to two days of focused design; half a day of review.

### RFC-002 — Claude Code provisioning procedure

*What it specifies:* the exact recipe for spawning a Claude Code subprocess that participates correctly in the paper-telephone architecture.

*Contents:*

- Required environment variables (Anthropic API key handling, working directory, MCP config path).
- MCP config JSON layout: how the kernel's MCP server is registered, transport (stdio vs. SSE vs. HTTP), tool restrictions if any.
- API base URL configuration: how Claude Code is told to point at the kernel's LiteLLM endpoint instead of api.anthropic.com directly.
- System prompt template: the instructions that bias the agent toward forced tool use, plus the standard agent task framing. The template is itself versioned.
- Allowed-tools restriction policy: which built-in Claude Code tools are disabled in favor of MCP-provided ones.
- Process lifecycle: spawn command, stdin/stdout/stderr handling, restart logic on crash, clean shutdown sequence.
- Worked example: a minimal `provision_claude_code(zone, task)` reference implementation.
- Failure modes: API key missing, MCP server unreachable, LiteLLM endpoint unreachable, agent process crashes, agent emits text despite system prompt — each with a documented response.

*Consumers:* the kernel's agent supervisor; integration tests; the V1 setup documentation; future agent integrations (OpenCode, others) which derive from this RFC.

*Cost:* one to two days of work, including hands-on prototyping with a real Claude Code instance to verify the recipe is correct.

### RFC-003 — Custom message format

*What it specifies:* the envelope and payload schemas for every custom Jupyter message type that crosses the kernel-extension boundary, beyond the standard MCP-shaped tool calls.

*Contents:*

- Envelope: every custom message has a `message_type`, a `direction` (kernel→extension or extension→kernel), a `correlation_id`, and a typed `payload`.
- Message catalog covering at least:
  - *Run lifecycle:* `run.start`, `run.event`, `run.complete` (the LangSmith POST/event/PATCH model from chapter 06's streaming protocol).
  - *Layout:* layout-state update (kernel→extension) and layout-edit command (extension→kernel) for the layout-tree storage structure from [chapter 07](07-subtractive-fork-and-storage.md).
  - *Agent graph:* agent-graph query and response messages.
  - *Operator action:* extension→kernel notification of UI actions that are not themselves MCP tool calls (cell edit, branch switch confirmation, zone selection).
  - *Heartbeat / liveness:* kernel→extension and extension→kernel periodic markers for failure detection (used by the kernel-vs-notebook failure split).
- For each: schema, example, semantics, error handling.
- Versioning: how the catalog evolves; how additive messages stay backward-compatible; how breaking changes are flagged.

*Consumers:* the kernel's protocol layer; the extension's message router; the replay harness (which deserializes these messages from the log).

*Cost:* one day of work.

### RFC-004 — Failure-mode analysis and fault-injection test harness

*What it specifies:* the failure taxonomy for V1 plus the test harness that exercises each failure systematically.

*Contents:*

- Failure taxonomy with hard kernel/notebook split:
  - *Kernel failures:* process crash, LiteLLM endpoint unreachable, MCP server crash, agent subprocess crash, run-tracker desync, file-write failure during snapshot.
  - *Notebook failures:* file corruption, schema-incompatible file, malformed cell output, missing required metadata, git operation failure mid-save.
  - *Cross-boundary failures:* extension-kernel disconnect, message-protocol version mismatch, partial run record (kernel crashed mid-run).
- For each failure: trigger condition, observable symptoms, recovery path, operator-facing surface, log signature.
- Fault-injection harness: a Markov-style test driver that schedules failure injections at random points in a known-good event sequence, asserting that recovery paths produce documented end states.
- Replay harness specification: live replay (against running kernel), dry replay (state simulation only), partial replay (single cell or single agent), output formats (reconstructed `.llmnb`, live UI, JSONL trace).
- Property-based test stubs: invariants that must hold across all event sequences (every `run.start` has a matching `run.complete` or `error`; every `request_approval` has a recorded operator response or timeout; the in-memory state is always reconstructable from the append-only event log).

*Consumers:* the test harness implementation; the operator-facing error documentation; the on-call playbook for V1 dogfooding.

*Cost:* one to two days for the spec; the harness implementation itself is a separate engineering effort tracked alongside V1 development.

Each RFC is short (single-document, 2–6 pages). Together they consume roughly a week of design effort. Together they remove the integration risk that would otherwise surface in week 4 of implementation.

## Layering and LiteLLM

The user's directive "treat LiteLLM as TCP/IP stack" deserves explicit treatment. It is the cleanest example of the Bell System layering discipline applied to V1's architecture.

LiteLLM presents a stable, OpenAI-compatible interface over a varying lower layer of provider APIs (Anthropic, OpenAI, Google, Cohere, Ollama, Bedrock, Azure, dozens more). Its job is to absorb the differences between providers — auth schemes, streaming formats, tool-use conventions, error encodings, rate-limit semantics — and present one shape upward. This is structurally identical to TCP/IP's role: a stable interface (sockets, packet semantics) over a varying lower layer of physical transports (Ethernet, WiFi, fiber, satellite).

The architectural commitment that follows:

- *V1 does not reimplement provider routing.* Whatever LiteLLM does, V1 inherits. New providers come from LiteLLM updates, not V1 code.
- *V1 treats LiteLLM's interface as normative.* The kernel's LiteLLM endpoint exposes exactly what LiteLLM exposes, plus the kernel's logging and modification hooks. Agents see an OpenAI-compatible API and nothing more exotic.
- *V1 does not leak below LiteLLM.* If a feature requires reaching past LiteLLM into provider-specific territory, that feature is not V1. The layer is a contract; honoring it constrains scope productively.
- *LiteLLM updates are tracked but not driven by V1.* V1 pins a version, upgrades deliberately, and treats LiteLLM bugs as upstream issues to file rather than locally patch.

The benefit is the same benefit TCP/IP provides for application code: V1 spends zero engineering time on provider differences, and the project's surface area is correspondingly smaller. The cost is occasional dependence on LiteLLM's velocity for new provider features. The trade-off is correct for V1's scope.

By the same logic, MCP plays the role of a stable interface over a varying lower layer of tool implementations. The kernel's MCP server presents one shape upward (typed tools with schemas); below it, the proxied tool implementations vary (filesystem, shell, search, custom). The layering discipline says: do not leak the implementation differences upward into the agent's view of the world.

V1's architecture stack, viewed through this lens:

```
+---------------------------------------------------------+
| Operator UI (notebook + map + sidebar)                  |  layer 7: presentation
+---------------------------------------------------------+
| Bidirectional MCP between kernel and extension          |  layer 6: session
+---------------------------------------------------------+
| LangSmith run records (POST/event/PATCH)                |  layer 5: structured event format
+---------------------------------------------------------+
| Jupyter messaging protocol with custom message types    |  layer 4: transport
+---------------------------------------------------------+
| LLMKernel as PTY mediator                               |  layer 3: mediation / interception
+---------------------------------------------------------+
| LiteLLM (OpenAI-compatible)        |  MCP (tools)        |  layer 2: stable abstractions
+---------------------------------------------------------+
| Provider APIs (Anthropic, etc.)    |  Tool implementations |  layer 1: varying lower layers
+---------------------------------------------------------+
```

The Bell discipline applied to this stack: each layer has a written specification (an RFC); each layer's interface is normative; each layer's implementation can change without invalidating the layers above. RFC-001 is the layer-6 spec for the kernel-extension MCP surface. RFC-003 is the layer-4 spec for the custom Jupyter messages. LiteLLM is layer 2 and is governed by LiteLLM's own documentation. The stack is small enough to fit on one page and rigorous enough to specify completely.

## What V1 looks like at the end of the design phase

Synthesizing across the whole dev guide, V1 as currently designed is this:

A subtractive fork of `microsoft/vscode-jupyter`, packaged as a VS Code extension that claims `.llmnb` files exclusively. The extension registers a `NotebookController` whose `executeHandler` dispatches each cell's input to an LLMKernel subprocess running in Python. The kernel hosts a standard MCP server (with native operator-interaction tools and proxied system tools), an OpenAI-compatible LiteLLM endpoint, and a Jupyter messaging server with custom message types. Agents — Claude Code in V1 — are subprocesses spawned by the kernel, configured to point their MCP client and their model API base at the kernel's endpoints, with their text channel suppressed by system prompt so that only structured tool calls reach the operator surface. Every agent interaction with anything outside itself flows through the kernel: every model call via LiteLLM, every tool call via MCP. The kernel logs each interaction as a LangSmith-shaped run record using POST/event/PATCH semantics, emits those records to the extension via Jupyter `display_id` messages for in-place cell-output rendering, and persists them as an append-only event log inside the `.llmnb` file alongside the layout tree, the agent graph, and the chat flow. The extension renders structured events with custom MIME renderers (status, tool-call, approval, plan, completion), surfaces a map view of zones and agents in a webview tab, and exposes a sidebar of artifacts. The operator approves, redirects, or annotates agent actions through the same MCP surface; their approvals come back to the kernel as structured tool results that resume the agent's tool call. Branching is git: the operator commits the `.llmnb` file at meaningful checkpoints, branches with `git checkout -b`, and switches branches with the kernel killing running agents and reloading state from the file. Failures split hard between kernel-level (process crash, endpoint unreachable) and notebook-level (file corruption, schema mismatch); each has its own recovery path and operator surface. The whole system is replayable from the event log; the test harness simulates failures by injecting them into known-good event sequences.

That is the V1 hypothesis: bidirectional, mediated, observable, replayable control over agent I/O is more valuable than improvements to agent reasoning, and a VS Code-hosted notebook is the right operator surface to demonstrate that hypothesis.

## Open questions and next moves

The design phase ends here. The implementation phase begins with a focused week-zero of writing the four RFCs and prototyping the two highest-risk integrations.

**Punch list for week zero:**

1. *Write RFC-001 (V1 MCP tool taxonomy).* Lock the schemas; produce worked examples; analyze backward-compatibility classes.
2. *Write RFC-002 (Claude Code provisioning procedure).* Hands-on; spawn a real Claude Code, configure it against a real LiteLLM proxy and a real MCP server, verify a tool call and an LLM call both flow through the kernel and land in the log. Document the recipe verbatim.
3. *Write RFC-003 (custom message format).* Catalog the messages; specify each schema; cover the run-lifecycle, layout, agent-graph, operator-action, and heartbeat families.
4. *Write RFC-004 (failure-mode analysis and fault-injection harness).* Enumerate failure modes per the kernel/notebook split; specify the replay harness; stub the property-based invariants.
5. *Prototype LLMKernel's mediator role end-to-end.* Spawn an agent through the kernel, route a tool call to the operator surface, get an operator response back, see it logged as a LangSmith run, render it in cell output. Minimum-viable paper telephone.
6. *Scaffold the vscode-jupyter fork.* Apply the subtractive cuts from [chapter 07](07-subtractive-fork-and-storage.md); register the `.llmnb` extension; wire the `NotebookController` to LLMKernel via the standard kernel protocol; verify a cell executes end-to-end before any custom rendering work begins.

**What remains genuinely unknown** (and will be answered only by week-zero prototyping):

- Whether Claude Code reliably honors a custom MCP config plus an OpenAI-compatible API base override. Documented behavior versus actual behavior is the central integration risk.
- Whether LiteLLM's proxy mode passes streaming tool-use formats through cleanly for every provider V1 supports.
- Whether VS Code's `display_id` semantics behave as documented under the rapid `update_display_data` rate that LangSmith-style streaming will produce.
- Whether the inherited test infrastructure from vscode-jupyter is salvageable in part, or should be deleted wholesale and rebuilt around `@vscode/test-electron` plus WebdriverIO for webviews.

Each is a half-day of prototyping. Each becomes a closed question or a documented constraint by the end of week zero.

The design conversation ends at this point. The next document in the project's history is RFC-001.

## Source turns

- [00-overview.md](../../_ingest/raw/phase-08-blockers-mediator-standards/00-overview.md)
- [turn-108-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-108-assistant.md) — VS Code extension testing standards (`@vscode/test-electron`, WebdriverIO for webviews).
- [turn-109-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-109-user.md) — "Are those all the blockers?"
- [turn-110-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-110-assistant.md) — initial 15-blocker enumeration with prioritization.
- [turn-111-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-111-user.md) — kernel-as-MCP-server-and-PTY framing, sandbox deferred, branching via git, "we don't care what context does."
- [turn-112-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-112-assistant.md) — three-layer kernel responsibilities, reverse-MCP interpretation, scope tightening implications.
- [turn-113-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-113-user.md) — "paper telephone" naming and LiteLLM as PTY clarification.
- [turn-114-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-114-assistant.md) — paper telephone architecture, full kernel responsibility decomposition, end-to-end flow walkthrough (DR-0015).
- [turn-115-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-115-user.md) — "can't we use langsmith native streaming?"
- [turn-116-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-116-assistant.md) — LangSmith POST/event/PATCH model adopted; simdjson role narrowed.
- [turn-117-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-117-assistant.md) — pre-research note.
- [turn-118-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-118-assistant.md) — full LangSmith streaming design with run-tracker sketch.
- [turn-119-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-119-user.md) — "What blockers remain."
- [turn-120-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-120-assistant.md) — final ten-blocker list, week-zero plan, integration-risk identification.
- [turn-121-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-121-user.md) — "What would Bell Telephone do? do that here, write an RFC. Treat LiteLLM as TCP/IP stack." (DR-0016)
