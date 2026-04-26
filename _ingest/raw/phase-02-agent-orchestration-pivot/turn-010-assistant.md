---
turn_id: 010
merged_turn_id: 006
role: assistant
phase: 02-agent-orchestration-pivot
source_lines: [309, 330]
source_sha256: 31e10fc2524c6e0d3ee4653dfe0b517f01c5bcd963be001c082c0ec379ec0cc3
char_count: 2740
---



## Assistant

OK, the picture is much better now. Let me reframe.

VegaFusion is a three-part system — Planner, Runtime, Middleware — all written in Rust, compilable to native or WebAssembly arXiv, that in the 2.0 architecture implements Vega transforms directly against the DataFusion DataFrame API Vegafusion. The 1.0 architecture targeted the gap where the stock browser-side Vega runtime fails to scale past hundreds of thousands of rows Medium; 2.0 simplified the core substantially by leaning on modern DataFusion capabilities Vegafusion.

The critical insight for your question: VegaFusion moves the dataflow out of the browser and into an Arrow/DataFusion pipeline. That is exactly the layer an RTS simulation needs to be fast. Your entity state is already a table. Your transforms (visibility, LOD selection, selection predicates, fog-of-war derivation, unit-group aggregation for stacked symbols) are all SQL-shaped operations. DataFusion runs them at columnar speed.

This flips my earlier verdict on the simulation/presentation split. Before, Vega's dataflow was the bottleneck; with VegaFusion, the dataflow is the strength. The only remaining bottleneck is the final rendering step.

NATO joint military symbology (APP-6 / MIL-STD-2525) is almost pathologically well-suited to Vega-Lite, in ways that matter:

It's compositional. A symbol is a frame (affiliation: friend=blue rectangle, hostile=red diamond, neutral=green square, unknown=yellow quatrefoil), plus a main icon, plus modifiers, plus text fields (unit designation, strength, task). That composition is literally Vega-Lite's mark grammar. An APP-6 symbol is a layered mark spec over a row of entity data.

It's low mark count. A real-world RTS inspired by command-post displays doesn't have 400 units on screen — it has 30–80 symbols representing platoons, companies, battalions. Each symbol is ~5–15 sub-marks. You're at 500–1500 marks total, comfortably inside even stock Canvas Vega, and laughably easy for a VegaFusion-backed pipeline that pre-aggregates the entity tables.

It's already a data visualization. This is the key philosophical point — a military map display is a dataviz. Commanders are not looking at sprites; they're looking at a categorical/ordinal encoding of entity attributes (affiliation, echelon, function) onto position. That's Vega's native problem domain. You're not bending Vega to do something foreign; you're using it for what it was built for, applied to a domain that happens to be a game.

It dodges the animation problem. Military symbols don't walk-cycle. They translate, rotate (optionally), and change state. Smooth position interpolation between tick snapshots is all you need, and that's a straightforward encode update.

