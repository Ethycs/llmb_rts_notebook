# 0001. Project pivots from Vega-game-engine to RTS-for-agent-orchestration

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** PIVOT

## Context

The prior phase had been evaluating Vega and VegaFusion as the substrate for a literal RTS game built around NATO symbology. That investigation concluded the rendering and dataflow stack was sound, but it left the actual product question unanswered: a symbol-based wargame is a viable game, yet it competes in a crowded, content-heavy genre and does nothing the operator does not already get from existing professional wargaming tools.

The reframe was triggered by a concrete observation: doctrinal symbology is specifically designed to communicate categorical state at a glance under uncertainty, which is the same information-density problem an operator faces watching dozens of autonomous coding agents work concurrently. The RTS affordances — select, group, assign orders, observe, override — are exactly the UX primitives needed to orchestrate a fleet of autonomous workers.

Treating the codebase as a game forced design effort into content (units, terrain, scenarios, balance) that the project had no reason to produce. Treating it as an operator console for agents redirects every existing piece of architecture (Arrow-native state, declarative dataflow, glanceable categorical encoding) at a problem the project actually has.

## Decision

Drop the literal-game framing. Build an operator interface for supervising a fleet of autonomous coding agents. Reuse the rendering and dataflow conclusions from the previous phase as a toolkit, but reattach them to a different product: units are agent processes, objectives are jobs and goals, terrain is the host system the agents act on, the operator is the human supervisor with full observability and pre-emption rights, and the map is a navigation surface rather than the workspace itself. The RTS metaphor is retained as UX vocabulary, not as a genre commitment.

## Consequences

- **Positive:** the project gains a clear product description that matches the author's actual interests (observability, agent control, declarative dataflow). The categorical-encoding work survives, but it now serves a real cognitive-ergonomics problem rather than a content-design problem. Integration targets become real systems (Claude Code, OpenCode, ACP-compliant runtimes) instead of fictional unit rosters.
- **Negative / cost:** the genre-game audience and any sunk design thinking about combat, balance, or scenario authoring is abandoned. The project now lives or dies on whether agent frameworks expose real interrupt and constraint affordances; if they do not, the "control surface" reduces to a monitoring dashboard.
- **Follow-ups:** the spatial-coordinates model for agents inherited from the RTS framing must be re-examined, because tool-call rates break it; this is taken up in [DR-0002](0002-agents-as-hypergraph-authors.md). The dual-view (2D command-post / 3D walkthrough) commitment and the integration adapter contract are downstream of this pivot.

## Alternatives considered

- **Ship the literal NATO-symbol RTS.** Rejected: the genre is well-served by existing professional wargaming tools, and the project had no content pipeline. Building a game would have consumed all available effort on art and balance rather than on the parts the author can do unusually well.
- **Build a generic agent-observability dashboard (Langfuse / Arize / LangSmith shape).** Rejected: that category is crowded and the RTS framing earns its keep only if the operator can actually issue commands mid-run. A pure dashboard discards the command surface that distinguishes this project.
- **Keep the RTS as a presentation layer over a separate observability product.** Rejected as premature: a two-product split would have forced a stable interface between layers before either was understood.

## Source

- **Source merged turns:** 006, 007
- **Raw sub-turns:** [turn-008-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-008-assistant.md), [turn-011-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-011-assistant.md), [turn-013-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-013-assistant.md), [turn-015-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-015-assistant.md)
- **Dev guide:** [chapter 02](../dev-guide/02-agent-orchestration-pivot.md)
