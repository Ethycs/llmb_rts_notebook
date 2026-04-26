# 02 — Agent orchestration pivot

## Purpose

This chapter fixes the project identity. The codebase is not an RTS game; it is an operator interface for supervising a fleet of autonomous coding agents, and the RTS metaphor is the UX vocabulary that shape borrows.

## The pivot

The project is an operator console for autonomous coding agents. The literal-game framing from [chapter 01](01-vega-rendering-substrate.md) is dropped. What the previous phase proved — that NATO symbology composes well in Vega-Lite, that a tabular entity model is fast enough on commodity rendering paths, that the renderer can stay dumb if the data model is right — survives as the rendering toolkit. What it was rendering changes.

The metaphor maps cleanly:

- **Units** are agent processes. They have identity, status, role, current activity, and confidence. They are the things on the map.
- **Objectives** are jobs and goals. They are what the operator hands to agents.
- **Terrain** is the host system the agents act on: filesystems, services, repositories, databases.
- **Operator** is the human supervisor. The operator is fully informed (no fog of war) and always wins on conflict — clicking through to an object pre-empts the agent that holds it.
- **The map** is a navigation surface, not the workspace. Real work happens in real tools (editors, terminals, service consoles) reached by handoff from the map.

The reframe was triggered by the observation that doctrinal symbology is designed to communicate categorical state at a glance under uncertainty, which is exactly the information-density problem of watching dozens of agents work concurrently. It is not a stylistic choice; it is a load-bearing claim about cognitive ergonomics.

This pivot is recorded as **DR-0001** (see [docs/decisions/](../decisions/)).

## The dual-view model

The interface presents two synchronized views over a single authoritative state:

- **2D command-post view** — the strategic surface. High information density, everything on one screen, fast categorical scanning, precise mouse and keyboard control, multi-select and box-drag, hotkeys. Authoring of the workflow structure (zone assignment, scope constraints, priority changes, interrupts) happens here. This is where the operator decides.
- **3D walkthrough view** — the ambient monitoring surface. Lower information density, higher presence and context. Used for long-session observation: watching activity pulse across the fleet, getting peripheral awareness of where work is happening, scrubbing time as embodied trajectory. This view is inspection-only.

These are not two renderers over the same data behind the scenes; they are two cognitive tools sharing one state backend. The commitment is **2D layout is authoritative; 3D is a view transform of it.** The 3D scene reads the same Arrow tables and the same cached 2D layout, then applies a projection that lifts each entity into a third axis derived from state — typical candidates are activity level, hierarchy depth, recency, or resource cost. There is no path from 3D back to 2D. Interaction authoring happens in the 2D view, full stop.

This eliminates a class of synchronization problems that bidirectional spatial systems generate, and it gives the 3D view an honest brief: it is for sitting back and watching the fleet work, not for setting up the workflow.

## NATO symbology

NATO joint military symbology (APP-6 / MIL-STD-2525) provides a ready-made categorical visual vocabulary that maps onto agent state with little adaptation:

- **Affiliation frame** — whose agent: operator's own, third-party, adversarial, unknown. Friend/hostile/neutral/unknown is already encoded in frame shape and color.
- **Echelon modifier** — scope of work: single tool call, task, multi-step plan, long-running program. The same bar/dot notation military doctrine uses for platoon/company/battalion.
- **Function icon** — agent role: retrieval, synthesis, execution, monitor, critic, planner.
- **Status modifier** — operational state: running, blocked, waiting-for-approval, errored, completed.
- **Strength modifier** — confidence or progress.
- **Intel-quality modifier** — telemetry confidence: confirmed, assumed, suspected. This maps directly onto attribution confidence when ingest sources disagree.

A symbol is compositional: a frame plus a main icon plus modifiers plus text fields. That composition is literally Vega-Lite's mark grammar — an APP-6 symbol is a layered mark spec over a row of entity data, and `milsymbol` can render a thousand symbols as SVG inside a 60 fps frame budget. Mark counts stay low because a command-post view shows tens of agents, not thousands of sprites.

The system buys roughly seventy years of human-factors iteration on glanceable categorical encoding. It is not a stylistic choice; it is the cheapest route to a display that an operator can scan without conscious decoding.

**V1 drops NATO symbology** along with several other features. See [chapter 05](05-v1-scope-reduction.md) for the scope cut and its rationale. The symbology is part of the long-term design but not part of the first ship.

## Integration targets

The interface is a control surface; it has no agents of its own. It targets external agent frameworks:

- **Claude Code** — Anthropic's coding agent. Exposes a tool-call stream that the interface taps for telemetry. Mid-run command injection is limited; the integration is monitor-leaning, with steering via approval gates rather than free-form interrupts. Becomes a primary integration target because it is the project's collaborator.
- **OpenCode** — open-source coding agent in the same family. Targeted as a second integration so the design does not silently couple to one vendor's tool surface.
- **OpenClaw** — companion agent runtime treated as a third integration target; included to keep the framework adapter generic rather than special-cased.
- **ACP (Agent Communication Protocol)** — the standardization layer to converge on. The interface speaks ACP where possible so that any compliant agent runtime is reachable through the same adapter rather than through bespoke per-vendor glue.

Each integration is implemented behind a single ingest/dispatch adapter contract. Ingest produces `(agent_id, verb, object, timestamp, metadata)` events; dispatch translates operator commands (interrupt, scope change, goal assignment, approval response) into framework-specific directives. Frameworks that do not support live retasking degrade the dispatch side to suggestion-and-observation; the ingest side still works.

## Agents as hypergraph authors

The spatial-coordinates model from the early pivot does not survive contact with real agent behavior. An agent making ten tool calls per second across ten files has no coherent (x, y) position; it teleports every tick, and the spatial metaphor breaks before any layout work can save it.

The model that replaces it: **an agent is the author of a typed, timestamped edge stream over a shared object graph.** Its current "location" is its set of recent edges. Its history is its accumulated subgraph. Its plan, when it has one, is a subgraph projected forward. Movement is edge accumulation; jumping does not exist as a primitive.

Three properties make this the right model:

1. **It matches what telemetry actually emits.** Agents emit events of the form (agent, verb, object, metadata) — which is an edge. The interface renders edges directly rather than synthesizing position from them.
2. **The world state is a multiplex graph.** Objects are shared nodes. Each agent contributes its own edge color. The union is the full operational picture; per-agent views filter to one color. Terrain (files, services) and units (agents) are the same kind of thing — they differ in role, not in representation.
3. **It inherits real visualization theory.** Multiplex networks, temporal graphs, and hypergraphs have well-developed rendering literatures. The interface specializes a known visual grammar to ops, rather than inventing one.

Spatial encoding is preserved as a layout tool — objects still get stable positions so operators can build a mental map — but the live thing on screen is edge events, not entity motion. Pulses travel along edges; recent edges are bright and thick, older edges fade, stale edges prune. Per-agent selection becomes a filter predicate on edge color, which is trivial in VegaFusion. Cycle detection, drift detection, and efficiency become graph-invariant computations the operator can read at a glance.

This pivot is recorded as **DR-0002** (see [docs/decisions/](../decisions/)). It is the first place in the project where an architecturally significant assumption from earlier in the same phase gets cleanly retired in favor of a better-fitting one.

## Why not spatial coordinates

The "agents have positions" model was the obvious starting point, and the chapter notes it because the rejection is load-bearing for understanding the rest of the design.

The model fails on three specific points:

- **Tool-call rate breaks coherence.** Agents move through files faster than any temporal-smoothing scheme can render. Either you smooth so hard that position lags reality, or you don't smooth and the display is jitter.
- **Synthetic projections drift faster than operators track.** Embedding-based positions (UMAP/PCA over agent state) update every tick and clusters reform constantly. Spatial memory cannot anchor anywhere.
- **Status, not position, is where the action is.** The information operators need — what an agent is touching, whether it is blocked, how confident it is — is categorical state on the agent, not motion through space.

The graph model fixes all three: edges are events with a natural temporal lifetime, positions are stable terrain coordinates rather than a function of the agent, and status remains a glanceable categorical encoding on the node and edge style.

## What carries forward, what gets cut

**Carries into [chapter 03](03-hypergraph-observability.md):**

- The hypergraph model of agents as edge authors.
- Multiplex / temporal / per-agent-color visualization as the rendering target.
- Edge bundling, temporal decay, and per-agent filter predicates as the standard transforms.
- The tabular Arrow-native state shape (nodes table, edges table, event log).
- The integration-target list and the adapter contract that flattens them.
- The dual-view model as a long-term design intent.
- Zones-of-control as a layout principle, which becomes the foundation for filesystem isolation in [chapter 04](04-isolation-and-mcp-placement.md).

**Cut by [chapter 05](05-v1-scope-reduction.md):**

- The 3D / VR walkthrough view. Removed for V1; the cognitive-tools argument survives as a forward design note.
- NATO symbology rendering. The categorical-encoding instinct survives in V1 as plain icon plus status pill, without APP-6 fidelity.
- VegaFusion as the dataflow runtime. Becomes optional under V1 scope.
- Per-zone bubblewrap isolation, eBPF-level attribution, live policy injection, event sourcing as a core primitive, and several other features that the early-phase architecture took for granted.

The pivot from chapter 01's renderer-evaluation framing to this chapter's operator-interface framing is the load-bearing reframe of the whole project. Everything downstream is design over the agents-as-edge-authors model under the operator-supervisor metaphor; everything upstream is the rendering substrate that survives the pivot.

## Source turns

- [00-overview](../../_ingest/raw/phase-02-agent-orchestration-pivot/00-overview.md)
- [turn-008](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-008-assistant.md)
- [turn-009](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-009-assistant.md)
- [turn-010](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-010-assistant.md)
- [turn-011](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-011-assistant.md)
- [turn-012](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-012-user.md)
- [turn-013](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-013-assistant.md)
- [turn-014](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-014-user.md)
- [turn-015](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-015-assistant.md)
- [turn-016](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-016-user.md)
- [turn-017](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-017-assistant.md)
- [turn-018](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-018-user.md)
- [turn-019](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-019-assistant.md)
- [turn-020](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-020-user.md)
- [turn-021](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-021-assistant.md)
- [turn-022](../../_ingest/raw/phase-02-agent-orchestration-pivot/turn-022-user.md)
