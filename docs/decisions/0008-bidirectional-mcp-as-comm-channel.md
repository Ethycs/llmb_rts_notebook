# 0008. MCP used bidirectionally as primary agent communication channel

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

MCP returns in V1, but in a fundamentally different role than it had pre-V1. In phase 04, DR-0004 placed MCP as the integration layer between agents and the world beyond their built-in tools — filesystems, git/GitHub, databases, web fetch, search — with per-zone server instances and a small commons. DR-0006 then cut MCP-as-integration-layer from V1 entirely as part of the scope reduction. That role is gone.

DR-0008 reintroduces MCP in a different role: **the protocol the operator and agent use to talk to each other.** The tools the operator's MCP server exposes are not capability extensions (filesystem, fetch, search). They are conversation primitives — `clarify`, `request_approval`, `propose`, `present`, `notify`, `report_progress`, `escalate`. The agent's outbound tool calls *are* the messages to the operator; the tool results *are* the operator's replies. This is a different layer of the stack from DR-0004's integration role and a different shape: one operator, one channel, structured turns instead of capability injection.

The forcing function is the operator surface. Free-text agent output is unparseable for the rich, multi-affordance UI V1 needs. Approval blocks, diff buttons, progress bars, artifact links, question cards with discrete options — these are properties of typed schemas, not interpretations of prose. Building reliable extraction from free text is an LLM-parsing problem with an unbounded failure mode. Structured tool calls give the renderer a switch on tool name with no parsing at all. The agent already knows how to call tools: every modern coding model is heavily tool-use trained. When the model would have produced "Hey, should I do X?" as text, having `clarify("Should I do X?", ["yes", "no", "wait"])` visibly available gets it called instead. No custom agent framework is required.

## Decision

**The operator daemon hosts an MCP server. The agent connects to it as a client. Agent-to-operator communication is exclusively MCP tool calls; the chat surface renders those tool calls.**

- The operator-MCP-server exposes a curated tool vocabulary (`ask`, `respond`, `clarify`, `request_approval`, `propose`, `present`, `report_progress`, `notify`, `escalate`, …) targeted at ~9–12 tools for V1. The exact taxonomy and schemas are RFC-discipline (deferred to chapter 08).
- Each tool has a dedicated MIME renderer in the cell-output pipeline. `clarify` is a radio picker. `request_approval` is an approval card with an inline "Show diff" button that hands off to VS Code's diff editor. `present` lifts an artifact to the sidebar. `report_progress` is a progress widget.
- Tool results carry the operator's response back to the agent in typed form (`Approved | Denied | ApprovedWithModification(text)` and so on). The same JSON-RPC channel carries both directions.
- Bidirectionality is symmetric: the operator can also initiate by calling tools the agent exposes (its inbox, status query, intent injection). MCP is treated as a general communication substrate, not a one-way capability channel.
- Per-tool policy is the right granularity: `notify` accumulates silently; `clarify` always pops; `request_approval` auto-approves in low-risk zones and pauses in high-risk ones. Policy attaches to tool name, not to free-text classification.

## Consequences

- **Positive:**
  - Structured intent — the agent commits to a category (question, status, proposal, approval) before emitting; the renderer dispatches without parsing.
  - Attributable, queryable, replayable conversation log — every operator-facing event is a typed JSON-RPC call.
  - UI affordances are properties of schemas, not interpretations of prose; consistent rendering across agents and zones.
  - Multi-agent supervision becomes operable: three agents in three zones using the same vocabulary produce one queue with three sources.
  - No custom agent framework needed — a stock Claude Code subprocess connected to the operator-MCP-server does this naturally.
- **Negative / cost:**
  - Tool taxonomy design becomes the new UX work. Get it wrong and the agent struggles to express what it wants to say.
  - Per-call JSON-RPC roundtrip latency. Invisible at human-in-the-loop pacing; would matter for high-frequency reasoning, so batching becomes a concern.
  - Conversational warmth and free-form reasoning are no longer in the operator's view by default (this consequence is fully realized in DR-0010, which suppresses the text channel entirely).
  - The operator daemon now owns an MCP server's lifecycle, schema versioning, and backward compatibility — a real engineering surface.
- **Follow-ups:**
  - DR-0009 — the cell paradigm with VS Code's `NotebookController` is the natural rendering target for tool-call streams; cells are the conversation turns.
  - DR-0010 — the maximally aggressive form of this decision: suppress the agent's free-text channel at the prompt level so MCP tool calls are the *sole* operator-facing surface.
  - DR-0011 (chapter 08) — pin the exact tool taxonomy, the system-prompt boilerplate that enforces tool-only output across model versions, and per-zone policy.

## Alternatives considered

- **Free-text + parsing.** Rejected — unreliable. Extracting structured intent from agent prose is an unbounded LLM-parsing problem with no ceiling on failure modes; the renderer would need its own model just to dispatch on output type.
- **Structured JSON without MCP (custom protocol).** Rejected — reinventing a protocol the agent already speaks. MCP is a JSON-RPC tool-call schema with mature SDKs and tool-use-trained model behavior. Building a parallel structured channel duplicates the work and costs the model's native tool-use competence.
- **MCP one-way agent→operator only.** Rejected — the operator needs to drive the UI on the agent's side too (inject intent, query status, deliver typed approvals back as tool *results*). Symmetric MCP is what makes the whole pattern hang together; one-way would force a second channel for operator→agent.
- **Reuse DR-0004's per-zone integration MCP servers as the comm channel.** Rejected — different role, different shape. The integration servers expose capabilities (filesystem, git, fetch); the operator-MCP-server exposes conversation primitives. Conflating them would re-couple decisions DR-0006 deliberately decoupled.

## Source

- **Source merged turn:** 060 (phase 06)
- **Raw sub-turns:**
  - [turn-072-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-072-assistant.md) — bidirectional MCP locked: operator-as-MCP-server, tools as conversation primitives, the inversion of the standard "agent extends capabilities" model, the symmetric communication substrate insight.
  - [turn-074-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-074-assistant.md) — MCP as context provider; the operator-MCP-server as the agent's universe; the three interpretations of "take over context."
  - [turn-078-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-078-assistant.md) — naming the architecture "chat over MCP"; tools as messages, results as responses, schemas as conversational grammar.
- **Dev guide:** [chapter 06](../dev-guide/06-vscode-notebook-substrate.md)
