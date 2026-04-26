# 0016. Bell System-inspired standards discipline: RFC-driven tool specs and provisioning

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

By the close of phase 08 the architecture is substantially settled. Sixteen decisions cover host substrate, fork strategy, kernel role, communication protocol, storage model, failure split, and streaming semantics. What remains are not architectural questions but integration risks at protocol boundaries: the exact MCP tool taxonomy, the procedure for provisioning Claude Code against the kernel, the kernel-extension custom message catalog, and the fault-injection harness. Each is a writable specification; each, if left as folklore, becomes a runtime surprise in week four of implementation.

A meta-question sits underneath: what discipline governs how those pieces get specified? The user's directive in turn 121 is unusually concrete — "what would Bell Telephone do? do that here, write an RFC" for blocker 1 (tool taxonomy), and "treat LiteLLM as TCP/IP stack" for blocker 4 (provider abstraction). The Bell System reference is not decorative. It names a specific engineering culture: numbered RFCs as normative documents, written before implementation; backward-compatibility as a first-class concern; fault-tree analysis for reliability; layered abstractions with stable interfaces; documentation precedes code. This is uncommon discipline for a small project. It is also exactly what V1's remaining work needs, because every outstanding blocker is an interface contract between two implementations.

This is the project's META-decision. It does not add architecture; it specifies the *process* under which all remaining design work — and the boundary between design and implementation — happens. Every other decision describes what V1 is. This one describes how V1 gets built.

## Decision

**Adopt Bell System engineering discipline as the meta-pattern for the rest of the design phase. Each remaining integration-risk blocker becomes a numbered RFC, written before the corresponding implementation begins. RFCs are normative, reviewable artifacts; implementations conform to RFCs; deviations require RFC updates.**

The discipline has five concrete elements, all imported from Bell System / Bell Labs / IETF practice:

- *Numbered RFCs as normative documents.* Each protocol or procedure has a numbered specification with a status (proposed, draft, normative) and a maintained history. The document is authoritative; implementations conform.
- *Backward compatibility as first-class.* Every RFC includes a backward-compatibility analysis even when V1 has only one schema version, so the analysis framework exists from the start. Breaking changes versus additive changes are explicitly classified.
- *Fault-tree analysis.* Every RFC that specifies runtime behavior enumerates failure modes, composes them, and drives test coverage and operational procedures from the resulting tree.
- *Layered abstractions with stable interfaces.* LiteLLM is treated as the V1 equivalent of TCP/IP — a stable, OpenAI-compatible interface over a varying lower layer of provider APIs. The kernel's MCP server plays the same role over varying tool implementations. V1 does not reach below either layer; the layer is a contract and honoring it constrains scope productively.
- *Documentation precedes implementation.* Specifications are written first, reviewed against requirements, and only then handed to implementation. The implementation's job is to satisfy the spec.

The concrete RFC docket for week zero:

- *RFC-001 — V1 MCP tool taxonomy.* Complete tool list (~9–12 tools) with normative input/output schemas, error cases, semantic notes, native-vs-proxied designation, worked example payloads, and backward-compatibility analysis.
- *RFC-002 — Claude Code provisioning procedure.* Environment variables, MCP config JSON, API base URL configuration, system prompt template, allowed-tool restriction policy, process lifecycle, worked reference implementation, and failure-mode catalog.
- *RFC-003 — Custom message format.* Envelope, message catalog (run lifecycle, layout, agent graph, operator action, heartbeat), schemas, semantics, versioning policy.
- *RFC-004 — Failure-mode analysis and fault-injection test harness.* Failure taxonomy aligned with the kernel/notebook split, fault-injection harness specification, replay-harness modes, property-based invariants.

V1's architecture stack, viewed through the layering lens, is a seven-layer diagram in the dev guide where each layer has a written specification and each layer's implementation can change without invalidating the layers above. The stack is small enough to fit on one page and rigorous enough to specify completely.

## Consequences

- **Positive: integration risk reduced.** Ambiguities surface as written contradictions during review instead of as runtime surprises in week four.
- **Positive: specifications are reviewable artifacts.** RFCs can be circulated, critiqued, version-controlled, and diffed. Folklore cannot.
- **Positive: future contributors have a clear contract.** New agent integrations (OpenCode and others) derive from RFC-002 rather than reverse-engineering Claude Code's setup. New renderers conform to RFC-001 rather than guessing.
- **Positive: backward-compatibility framework exists from day one.** Even with one schema version, the analysis machinery is in place for the second.
- **Positive: layering discipline keeps scope small.** "Treat LiteLLM as TCP/IP stack" means V1 spends zero engineering time on provider differences. New providers come from LiteLLM updates, not V1 code.
- **Positive: failure-mode analysis is systematic, not ad hoc.** RFC-004 gives the test harness a normative target.
- **Negative: week-zero spec work delays the first implementation milestone.** Roughly a week of writing instead of a week of coding before any cell executes end-to-end.
- **Negative: writing discipline is uncommon at small-project scale.** The team has to actually write the documents, review them, and conform to them. Skipped reviews defeat the purpose.
- **Negative: RFC-update friction.** Deviations from a normative spec require updating the spec, not just the code. This is the cost of having a spec at all and is worth paying.
- **Follow-ups:**
  - Write RFC-001 through RFC-004 before V1 implementation begins. The design conversation ends; the next document in the project's history is RFC-001.
  - Prototype LLMKernel's mediator role end-to-end alongside RFC-002 to verify the Claude Code recipe is correct (documented behavior versus actual behavior is the central integration risk).
  - Establish the RFC index, numbering scheme, and template under `docs/rfcs/` (placeholder; structure deferred to RFC-001's authorship).

## Alternatives considered

- **Implement first, document later.** Rejected — lossy. Designs reconstructed from code after the fact lose the rationale, the alternatives considered, and the backward-compatibility analysis. The integration risks the discipline is meant to surface stay buried until week four.
- **Ad-hoc design notes (markdown scratchpads, GitHub issues).** Rejected — not reviewable as contracts. Notes can disagree with code without anyone noticing; issues close; chat scrolls. RFCs are numbered, normative, and persistent precisely because contracts must be.
- **Single combined design document covering all remaining blockers.** Rejected — couples unrelated concerns and makes review unwieldy. Each RFC has different consumers (renderers vs. agent supervisor vs. message router vs. test harness) and different review surfaces. Numbered, separate documents map cleanly onto the work.
- **Skip the layering discipline and reach into LiteLLM / provider APIs as needed.** Rejected — leaks provider differences into V1 code, expands scope, and breaks the contract that makes the LiteLLM dependency worthwhile. The same logic applies to MCP: do not leak proxied-tool implementation differences upward into the agent's view.
- **Treat the Bell discipline as aspirational rather than normative.** Rejected — discipline that is optional is not discipline. The point of writing things down is that what is written is what is built.

## Source

- **Source merged turns:** 103, 104, 105 (in phase 08; the conversation ENDS at turn 105)
- **Raw sub-turns:**
  - [turn-119-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-119-user.md) — "What blockers remain" — the prompt that surfaces the outstanding integration-risk list.
  - [turn-120-assistant.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-120-assistant.md) — final ten-blocker list, week-zero plan, integration-risk identification; the docket that the RFC discipline targets.
  - [turn-121-user.md](../../_ingest/raw/phase-08-blockers-mediator-standards/turn-121-user.md) — "What would Bell Telephone do? do that here, write an RFC. Treat LiteLLM as TCP/IP stack." The directive that locks DR-0016 and ends the design conversation.
- **Dev guide:** [chapter 08](../dev-guide/08-blockers-mediator-standards.md)
