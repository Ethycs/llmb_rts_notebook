# Chapter 01 — Vega as RTS rendering substrate

## Purpose

This chapter answers a single question: can the Vega/Vega-Lite visualization grammar serve as the rendering and UI substrate for a real-time strategy game? The short answer is no for a literal RTS, qualified yes for narrower shapes, and the exercise of asking it produced the architectural vocabulary the rest of the project inherits.

## The question, framed

The opening prompt was deliberately unconventional: treat Vega — a declarative grammar of interactive graphics, normally used for charts and dashboards — as a candidate game engine. The interesting variant is Vega the visualization grammar (Vega and Vega-Lite), not the unrelated game console or other namesakes. That clarification was made explicit in [turn 005](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-005-user.md).

The question matters because RTS games are, underneath the visuals, a large reactive system over entity tables. Units have positions, HP, faction, and state; the renderer is a function of that table plus a camera transform. Vega's signal/dataflow model maps cleanly onto that shape — data sources feed transforms feed marks, signals propagate updates automatically, and pan/zoom/select interaction is first-class. If the grammar holds up, you get reactive UI, retained-mode debugging views, and a clean simulation/presentation split essentially for free.

So the evaluation is not "is Vega a game engine" — it obviously is not — but "is the declarative-reactive-grammar-over-entity-state pattern that Vega embodies a viable rendering substrate, and if so, in what configuration?"

## What Vega offers

The design fit is real and worth naming, because the same fit is what motivates the project's later choices around hypergraph-shaped agent state.

- **Reactive dataflow over tables.** A Vega spec is a JSON description of data sources, transforms, scales, marks, and signals. The runtime resolves these into a dataflow graph and propagates updates. For a game whose simulation produces per-tick entity snapshots, this is the natural shape — the renderer is "a view of the table."
- **Multi-view composition.** A minimap is genuinely a second view on the same dataset with a different projection. Vega does this elegantly; most game engines reimplement it as bespoke code each time.
- **Encodings as derived state.** Health bars become derived encodings (`width = hp / hp_max * 20`). Selection state is a predicate on a signal (`indata('selection', 'id', datum.id)`). Faction colors are a scale. Adding a debug heatmap of pathfinding cost is one mark spec, not an engine subsystem.
- **Pan, zoom, box-select for free.** The interaction grammar that RTS HUDs reinvent every time is already in the runtime.
- **Retained-mode introspection.** Because the spec is data, you can render the simulation's interior — influence maps, AI state machines, decision boundaries — in the same grammar as the game itself. This is the part that survives into [chapter 03](03-hypergraph-observability.md) as the observability layer.

A pseudo-Vega sketch of an RTS view appears in [turn 006](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-006-assistant.md): unit symbols keyed on entity tables, fog of war as an image mark, selection as a signal predicate, camera as a pair of linear scales over signals. The grammar fit is genuinely elegant where it applies.

## Where it breaks down

The fatal issues are all on the simulation side and on renderer throughput. Listed in roughly descending order of severity:

1. **Mark-count ceiling.** Vega ships two renderers. SVG creates one DOM node per mark and falls over between one and five thousand nodes — dead on arrival for an RTS. Canvas draws imperatively and tops out near ten thousand simple marks at sixty frames per second, dropping fast as mark complexity (strokes, gradients, text) rises. A modest RTS frame is right at the canvas ceiling before particles: roughly two hundred units multiplied by four marks each (body, selection ring, HP bar, shadow) is eight hundred marks; fifty projectiles is fifty more; a naive per-tile terrain layer on a 256×256 map is sixty-five thousand and dead. Terrain and fog have to be single image marks updated via texture, not per-tile marks.
2. **Tick rate and latency mismatch.** Vega's dataflow runtime is optimized for dataset updates in the tens-to-hundreds of milliseconds range, not 30–60 Hz simulation ticks over thousands of entities. You would be fighting the scheduler constantly.
3. **No spatial indexing primitives.** Pathfinding, collision, line-of-sight, and area-of-effect queries want quadtrees, grids, or navmeshes. Vega transforms do not include these. Bolting them on as external JavaScript reduces Vega to a thin render layer, at which point the grammar buys you very little.
4. **Animation model mismatch.** Vega animates via signal updates and transitions between states. RTS wants continuous interpolation driven by a fixed-timestep simulation. Doable but awkward, and the transition machinery is wrong-shaped for sub-frame motion.
5. **No asset pipeline, no audio, no networking.** Sprites, sounds, lobbies, and rollback would all be hand-built around the grammar.

The honest scaling path for RTS-class entity counts is a WebGL or WebGPU renderer that accepts Vega specs but lowers marks to instanced draw calls. A `vega-webgl` experiment existed but never reached parity. Anyone serious about this is building it.

## The three options that emerged

By the end of [turn 006](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-006-assistant.md) the design space had collapsed to three coherent shapes. None were locked in this phase, but they framed every later choice.

### Option A — Vega plus a small tactics game

Skip the fight with the runtime. Build a turn-based or slow-paced tactics game (Into the Breach or FTL scale) where entity counts stay under one hundred and updates are event-driven rather than tick-driven. Vega holds up here as-is. **Verdict:** A real shipping path, but it answers a question the project does not actually want to ask. Set aside.

### Option B — Vega as a debug and observability overlay on a real engine

A real engine (Bevy, Godot, custom Rust) runs the simulation and renders the game. Vega runs in a side panel rendering the things you would normally hide: influence maps, unit AI state machines, pathfind queries per frame, projected economy curves, the AI director's decision surface. **Verdict:** The undervalued correct answer. RTS research tools at this quality essentially do not exist, and the Vega-over-game-telemetry pattern is the one that maps cleanly onto the project's existing telemetry-to-graph instincts. This shape — Vega-as-observability — is what survives the Vega-specific pivot and reappears in [chapter 03](03-hypergraph-observability.md) as the hypergraph observability layer.

### Option C — Vega-grammar-inspired custom engine

Implement a Vega-like declarative renderer on top of WebGPU or wgpu. Lower mark specs to instanced draws and compute shaders for transforms. Simulation is ECS (Bevy or hand-rolled), and the presentation layer speaks a Vega dialect. **Verdict:** The research-interesting path. Aligns with the GPU compute and unified pipeline interests behind the project, but it is a one-to-two-year side project, not a weekend. The load-bearing prototype question is not the renderer but the scale and transform layer over GPU buffers — can Vega's scale and encoding grammar be expressed as a compute shader compilation target? That spike either answers yes-this-works or no-stop-now in about a week. As a V1 commitment it is too expensive. Set aside as future work.

### Why not just use VegaFusion

A late prompt in [turn 007](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-007-user.md) raised VegaFusion (server-side dataflow acceleration for Vega specs, typically with Arrow). It does not change the analysis above: the renderer ceiling is in the browser, not the dataflow stage, and the simulation-side gaps (spatial indexing, tick rate, animation model) are not what VegaFusion accelerates. VegaFusion-the-product is dropped explicitly during the V1 scope cut later in the project; see [chapter 05](05-v1-scope-reduction.md).

## What this phase concluded

This phase concluded by reframing the question rather than answering it. The user pivoted away from Vega-specific design entirely and toward an unrelated framing: an RTS-style operator interface for autonomous coding agents, with NATO-style symbology and integration targets in the agent-orchestration space rather than in entertainment. The literal-game framing was abandoned.

The Vega-grammar analysis still leaves three usable artifacts behind:

- The Option B observability shape — declarative views over telemetry — survives directly into the hypergraph observability layer in [chapter 03](03-hypergraph-observability.md).
- The reactive-dataflow-over-entity-tables vocabulary frames how agents are later modeled (as authors of edges in a temporal multiplex graph, not as spatial entities).
- The mark-count ceiling and animation-model results are reused as concrete constraints when later chapters consider what to render and where.

The pivot decision itself (DR-0001) is recorded and detailed in [chapter 02](02-agent-orchestration-pivot.md). This chapter does not restate it.

## Source turns

- [Phase overview](../../_ingest/raw/phase-01-vega-rendering-substrate/00-overview.md)
- [turn 001 — user, opening prompt](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-001-user.md)
- [turn 002 — assistant, initial fit-and-failure analysis](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-002-assistant.md)
- [turn 003 — assistant, Vega-disambiguation aside](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-003-assistant.md)
- [turn 004 — assistant, simulation-side gaps and architecture sketch](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-004-assistant.md)
- [turn 005 — user, confirms Vega visualization grammar](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-005-user.md)
- [turn 006 — assistant, throughput numbers and three options](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-006-assistant.md)
- [turn 007 — user, VegaFusion and NATO-symbol RTS prompt (pivot trigger)](../../_ingest/raw/phase-01-vega-rendering-substrate/turn-007-user.md)
