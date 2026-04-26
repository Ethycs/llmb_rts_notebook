---
turn_id: 006
merged_turn_id: 004
role: assistant
phase: 01-vega-rendering-substrate
source_lines: [118, 195]
source_sha256: 88e58764784e218fd5c44ba73974ef8e93cb79bdab55c3c08293483aaddcead1
char_count: 6001
---



## Assistant

Good — confirms the interesting case. Let me go deeper on the parts that matter, since the high-level sketch I gave is only useful if the numbers and the spec shape hold up.

The binding constraint is renderer throughput. Vega has two backends:

SVG renderer: each mark is a DOM node. Browsers choke somewhere between 1k–5k nodes with any interactivity. Dead on arrival for RTS.

Canvas renderer: marks are drawn imperatively per frame. Realistic ceiling is ~10k simple marks at 60fps on a decent machine, dropping fast as mark complexity (strokes, gradients, text) rises. Vega's own perf demos top out around this range.

For comparison, a modest RTS frame:

So even a small RTS is right at the Canvas ceiling, and that's before you add particles. The math says: Vega's stock renderers are viable for a tactics game (X-COM scale, ~20 units, turn-based or pausable) but not for Dune/Starcraft-scale RTS with hundreds of units and real-time combat.

The honest path for RTS scale is a WebGL/WebGPU renderer that accepts Vega specs but lowers marks to instanced draw calls. This exists in prototype form (vega-webgl was an experiment; never reached parity) but nothing production-grade. You'd be building it.

Here's the shape of the idea — this is pseudo-Vega, not a runnable spec, to show the grammar fit:

This is genuinely elegant for the RTS rendering layer. Selection state is a predicate on a signal. Health bars are derived encodings. Faction colors are a scale. Adding a debug layer — say, rendering the pathfinding cost field as a heatmap — is literally `{"type": "rect", "from": {"data": "pathfind_debug"}, ...}` and done. This is the kind of thing that in Unity takes an afternoon and in a Vega-shaped engine takes five minutes.

The simulation side — which is 80% of an RTS — is nowhere in this spec, and correctly so. Vega was never going to do pathfinding.

Option A: Actual Vega + small tactics game. Skip the fight. Build a turn-based or slow-paced tactics game (think Into the Breach or FTL-style) where entity counts stay under 100 and updates are event-driven rather than tick-driven. Vega holds up here. This is a real shipping path.

Option B: Vega as debug/observability layer, real engine does the game. Bevy/Godot/custom Rust runs the sim and renders. Vega runs in a side panel rendering everything you'd normally hide: influence maps, unit AI state machines, pathfind queries per frame, projected economy curves, the whole attack surface of the AI director. This is the boring correct answer and plays directly to your `cat_scanner` / telemetry-to-graph instincts. RTS research tools basically don't exist at this quality, and the Vega-over-game-telemetry pattern would be publishable.

Option C: Vega-grammar-inspired custom engine. You implement a Vega-like declarative renderer on top of WebGPU or wgpu, lowering mark specs to instanced draws and compute shaders for transforms. Simulation is ECS (Bevy or hand-rolled), and the presentation layer speaks a Vega dialect. This is the research-interesting path and aligns with your existing GPU compute shader and unified pipeline work, but it's a 1–2 year side project, not a weekend.

Option B is the one I'd actually push you toward, because it's undervalued and in your wheelhouse. A Bevy RTS with a live Vega dashboard showing per-tick influence maps, unit LOD distributions, eBPF-observed GPU kernel times for the AI, and catastrophe-germ-adjacent visualizations of decision boundaries for the game AI's value function — that's a genuinely novel tool, and the RTS is almost a pretext. The telemetry-to-graph compiler you already have is already most of the infrastructure for this.

Option C is the one that will actually tempt you, because it's where the interesting math lives. If you go that way, the thing to prototype first is not the renderer but the scale + transform layer over GPU buffers — can you express Vega's scale/encoding grammar as a compute shader compilation target? That's the load-bearing question and either answers yes-this-works or no-stop-now in about a week of spike work.

Which of these directions would you like to pull on — the Bevy+Vega telemetry architecture, the WebGPU compilation sketch for Option C, or the tactics-game scoping for Option A?

```json
{
  "data": [
    {"name": "units", "source": "sim://entities/units"},
    {"name": "projectiles", "source": "sim://entities/projectiles"},
    {"name": "selection", "source": "sim://ui/selected_ids"},
    {"name": "fog", "source": "sim://visibility/player_0"}
  ],
  "signals": [
    {"name": "camera_x", "value": 0, "on": [{"events": "drag", "update": "..."}]},
    {"name": "camera_zoom", "value": 1.0},
    {"name": "box_select", "on": [{"events": "mousedown, mousemove, mouseup", "update": "..."}]}
  ],
  "scales": [
    {"name": "world_to_screen_x", "type": "linear",
     "domain": {"signal": "[camera_x - viewport_w/camera_zoom, camera_x + viewport_w/camera_zoom]"},
     "range": "width"}
  ],
  "marks": [
    {"type": "image", "from": {"data": "fog"}, "encode": {...}},
    {"type": "symbol", "from": {"data": "units"},
     "encode": {
       "update": {
         "x": {"scale": "world_to_screen_x", "field": "pos.x"},
         "y": {"scale": "world_to_screen_y", "field": "pos.y"},
         "shape": {"field": "unit_type"},
         "fill": {"field": "faction", "scale": "faction_color"},
         "stroke": {"signal": "indata('selection', 'id', datum.id) ? 'yellow' : null"}
       }
     }},
    {"type": "rect", "from": {"data": "units"},
     "encode": {"update": {"width": {"signal": "datum.hp/datum.hp_max * 20"}, ...}}}
  ]
}
```

- 200 units × (body + selection ring + HP bar + shadow) = 800 marks
- ~50 projectiles in flight = 50 marks
- Terrain: if you naively mark-per-tile on a 256×256 map, 65k marks — dead. You'd need a pre-baked terrain layer outside Vega.
- Fog of war: same problem, needs to be a single image mark updated via texture, not per-tile marks.
- UI/HUD: 50–200 marks, fine.

