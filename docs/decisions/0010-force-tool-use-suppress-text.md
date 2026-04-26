# 0010. Agent text output suppressed; tool calls become sole communication

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

DR-0008 establishes bidirectional MCP as the chat protocol: the operator daemon hosts an MCP server, the agent is its client, and the tools it exposes (`ask`, `clarify`, `request_approval`, `report_progress`, `propose`, `present`, `notify`, `escalate`, `respond`) are conversation primitives rather than capability extensions. That alone does not settle what happens to the agent's free-form text channel. If structured tool calls and prose can coexist in the operator surface, two failure modes remain:

- **Parser-vs-renderer ambiguity.** A renderer that dispatches on tool name has nothing to say about a paragraph of agent narration that arrives outside any tool call. Either the renderer parses prose for intent (LLM-based parsing in the UI layer — unreliable, slow, defeats the protocol) or it shows raw text alongside structured cards (visually inconsistent, loses every benefit of the structure).
- **Half-and-half is worse than either pole.** Chat-shaped messages sitting next to typed events look weird, leak the agent's filler thinking ("Let me think about this..."), and pull the operator back into reading prose instead of acting on events. The "is this AI talking?" feeling returns and the supervisor framing collapses.

The honest commitment, given DR-0008, is "if it's not a tool call, the operator does not see it." Modern instruct-tuned coding models follow tool-use directives well when alternatives are clearly available, and the operator-MCP-server provides a tool for every category of communication the agent might want to produce — including the catch-all `respond(content, kind="explanation")` for cases where prose really is the right shape. The discipline is enforceable at the system-prompt level.

## Decision

**At the system-prompt level, suppress the agent's free-form text channel; structured MCP tool calls are the sole agent-to-operator communication.**

The system prompt enforces:

> All communication with the operator must occur through the provided MCP tools. Do not produce free-form text intended for the operator. Reasoning may be expressed in your internal monologue, which is not surfaced.

The agent's text channel either does not exist (suppressed by configuration), contains only internal scratchpad reasoning that nothing renders, or is captured separately for opt-in debugging. The operator's surface — the cell output, the activity feed, the approval cards — is rendered tool calls. Reasoning is the agent's process; tool calls are the agent's outputs; the operator only deals with outputs.

## Consequences

- **Positive: no parsing.** The renderer never has to extract structure from prose. It dispatches on tool name. Every operator-facing artifact has a typed schema.
- **Positive: no leaked filler thinking.** "Let me think about this..." stays internal. The operator sees outcomes of reasoning, not the reasoning process.
- **Positive: predictable affordances.** Every approval looks like an approval; every question looks like a question. UI consistency is a property of the protocol, not the renderer's interpretation.
- **Positive: the supervisor framing holds.** Operators interacting with structured events feel like they are operating equipment, not chatting with an AI. That framing keeps the operator in the supervisor role.
- **Positive: exact audit and replay.** The full operator-facing transcript is a structured event log — queryable, filterable, diffable — instead of LLM-parsed prose.
- **Positive: multi-agent supervision becomes operable.** Three agents in three zones produce one queue with three sources, all using the same event shapes. Reading three chat streams in parallel is unmanageable; reading one queue of typed events is straightforward.
- **Negative: agent must learn to call tools for everything.** Early hallucinations (calls to nonexistent tools, malformed args) and a real training cost in system-prompt engineering before the agent reliably commits. Tool-call discipline varies by model.
- **Negative: tool taxonomy is now load-bearing UX work.** Get the taxonomy wrong and the agent struggles to express what it wants to say. Get it right and the conversation is crisp.
- **Negative: tool-call latency.** Each call is a JSON-RPC roundtrip. Invisible at human-in-the-loop pacing, real for high-frequency reasoning.
- **Negative: reasoning is invisible by default.** Mitigation: an opt-in "reasoning view" surfacing the suppressed text on demand for debugging.
- **Negative: no warmth.** The agent cannot ramble, rapport-build, or preamble. Every output is typed. Acceptable for a supervision tool; would be wrong for a companion product.
- **Follow-ups:**
  - Chapter 08 pins the exact tool taxonomy (~9–12 tools), the per-zone tool policy, and the system-prompt boilerplate that enforces tool-only output reliably across model versions.
  - The hypergraph observability model (chapter 03) is unchanged and benefits — the structured tool-call log is the cleanest possible input, every event already a typed edge.

## Alternatives considered

- **Allow free text but parse it post-hoc into structured events.** Considered as the obvious "have it both ways" path. Rejected — LLM-based parsing in the renderer layer is unreliable, slow, and defeats the protocol-level structure that DR-0008 establishes. Adds a second source of truth that can disagree with the first.
- **Allow text but route it to a separate "stream" view, alongside the structured queue.** Considered as a half measure. Rejected — chat-shaped messages sitting next to structured events look weird, two surfaces means double the operator attention, and the supervisor framing collapses the moment the agent narrates. There is no fall-back-to-chat path that is not worse than committing fully.
- **Configure tool-only at the framework level (Claude Code flags) rather than the prompt level.** Considered. Rejected as the primary mechanism — framework configuration is brittle across versions and across agent runtimes (Claude Code, OpenCode, etc.). The prompt-level discipline is portable; framework configuration is supplementary belt-and-braces.
- **Keep a "free message to operator" tool but make it the default.** Considered. Rejected — defaults shape behavior. If a free-text-message tool is the default, every other tool is a special case the agent has to be steered toward. Keep `respond(content, kind="explanation")` as the explicit catch-all but discourage it.

## Source

- **Source merged turn(s):** 075, 076 (in phase 06)
- **Raw sub-turns:**
  - [turn-074-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-074-assistant.md) — MCP as context provider, operator-MCP-server as the agent's universe, the three interpretations of "take over context" that prepare the ground for forced tool use.
  - [turn-076-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-076-assistant.md) — forced tool use locked: the agent has no native communication surface, all output is structured events, the chat panel disappears or becomes a debug surface. Architecture lock for DR-0010.
  - [turn-078-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-078-assistant.md) — naming the architecture "chat over MCP"; tools as messages, results as responses, schemas as conversational grammar.
- **Dev guide:** [chapter 06](../dev-guide/06-vscode-notebook-substrate.md)
