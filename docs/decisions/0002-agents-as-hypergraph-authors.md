# 0002. Agents modeled as hypergraph edge authors, not spatial entities

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** PIVOT

## Context

The first agent-orchestration design (see [DR-0001](0001-rts-as-agent-orchestrator.md)) inherited an "agents have positions" model from the RTS framing. Agents were placed on a terrain (filesystem layout, service graph) at the location of whatever they were currently touching, with trails for recent activity.

That model failed on contact with real agent behavior. A coding agent that issues tens of tool calls per second across many files has no coherent (x, y) position; it teleports every tick. Either the display smooths so aggressively that position lags reality, or it does not smooth and the screen becomes jitter. Embedding-based projections fared no better — UMAP/PCA over agent state updates per tick and clusters reform constantly, so spatial memory cannot anchor anywhere. The deeper observation was that the information operators actually need — what an agent is touching, whether it is blocked, how confident it is — is categorical state on the agent, not motion through space.

What agent telemetry actually emits is `(agent, verb, object, timestamp, metadata)` events. That is an edge, not a position. Synthesizing position from edges added a lossy abstraction layer that the rest of the design had to fight.

## Decision

Treat each agent as the author of a typed, timestamped edge stream over a shared object graph. The agent's current "location" is its set of recent edges; its history is its accumulated subgraph; its plan, when it has one, is a subgraph projected forward. Movement is edge accumulation; jumping does not exist as a primitive. The world state is a multiplex graph with shared object nodes (files, services, APIs, data stores) and per-agent edge colors; the union is the full operational picture, per-agent views are filter predicates on edge color. Terrain and units stop being different kinds of thing — they differ in role, not in representation. Object nodes still get stable layout positions so operators can build a mental map, but the live thing on screen is edge events, not entity motion.

## Consequences

- **Positive:** the model matches the shape of telemetry directly, eliminating a synthesis step. It inherits the existing visualization literature for multiplex networks, temporal graphs, and hypergraphs rather than inventing one. Per-agent isolation falls out as a trivial filter-by-color in VegaFusion. Graph-invariant computations (cycle detection, drift detection, path-efficiency) become cheap glanceable signals. "Scope" becomes a graph constraint ("edges only allowed to this node set"), which is more natural than the layout-dependent spatial version.
- **Negative / cost:** the system inherits the hairball problem at scale. Edge bundling, temporal decay, per-agent filtering, and rate-windowed aggregation all become mandatory rather than optional. Incremental graph layout under node churn is a real engineering problem that must be solved for the display to feel stable. The edge ontology becomes a load-bearing schema decision that, if wrong, forces rewrites.
- **Follow-ups:** the rendering target becomes temporal multiplex graph visualization with categorical node and edge types; this is taken up in [chapter 03](../dev-guide/03-hypergraph-observability.md). Layout stability, edge-rate windowing, and the edge ontology itself become first-class design surfaces. The 3D walkthrough view from DR-0001 acquires a clearer brief — edge-dense graphs are the canonical case where 3D camera motion disambiguates occlusion that 2D cannot.

## Alternatives considered

- **Keep spatial coordinates with aggressive temporal smoothing.** Rejected: smoothing strong enough to suppress tool-call jitter also suppresses the activity the operator is trying to watch. The smoothed signal lags reality and the unsmoothed signal is unreadable.
- **Embedding-projected positions (UMAP/PCA over agent state).** Rejected: re-projection per tick destroys spatial memory. Clusters reform constantly and operators cannot anchor a mental map.
- **Hybrid: physical position when it exists, semantic position otherwise.** Rejected as premature complexity. The hybrid model layers the failure modes of both inputs and was identified at decision time as something to grow into, not start from.

## Source

- **Source merged turns:** 009, 010
- **Raw sub-turns:** [turn-015-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-015-assistant.md), [turn-017-assistant.md](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-017-assistant.md)
- **Dev guide:** [chapter 02](../dev-guide/02-agent-orchestration-pivot.md)
