---
turn_id: 094
merged_turn_id: 080
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [9839, 10158]
source_sha256: 6b8af9a194fa179a046fc0177b193de3e4dbd44fff9eae109082e29e7de3eb86
char_count: 20457
---



## Assistant

Good question to surface now, because layout storage is the kind of thing that's easy to get wrong in a way that compounds — and it has architectural implications that touch the file format, the daemon's responsibilities, and how the map view loads.

Let me work through what "RTS mode layout" actually means, what needs persistence, and where each piece of state should live. There are several distinct things bundled together in the question and they want different storage strategies.

Worth decomposing because not all of it is the same kind of state:

Spatial layout — positions of zones, agents, files, services on the 2D map. Where things are drawn. This is the geometry of the visualization.

Camera state — pan, zoom, current focus, selected items. The operator's current view of the map. This is the "where am I looking" state.

Visual configuration — color schemes, symbol styles, edge rendering options, what's visible vs hidden, label sizes, themes. The operator's display preferences for the map.

Filter and query state — which agents are highlighted, which time range is shown, which event types are surfaced. The operator's "what am I looking at" state.

Workspace organization — multiple maps open simultaneously, split-screen arrangement, which notebook is paired with which map. The operator's "how am I working" state.

Saved viewpoints / bookmarks — "show me the auth refactor area," "show me everything from yesterday's incident." Named spatial+temporal+filter snapshots.

Annotations — operator's notes on the map, highlighted regions, drawn arrows, manual labels. Operator-authored content layered on the map.

Replay state — when scrubbing time, the current scrub position. Ephemeral but worth being explicit about.

These are seven distinct kinds of state with different persistence properties. Lumping them all into "layout" is the trap; treating them separately gives clean answers.

Each kind of state belongs in one of four places, and the choice of place is the architectural decision:

Inside the .rts.ipynb file — for state that's part of the conversation's identity. If you share the file, this travels with it.

Alongside the file (sidecar) — for state that's session-specific but tied to the conversation. If you share the file, this can be stripped or shared optionally.

In VS Code workspace state — for state that's per-operator-per-workspace. Survives reloads, doesn't travel with files.

In VS Code global state — for state that's per-operator across all workspaces. The user's preferences.

Here's how I'd map the seven kinds of state to the four storage places:

This gives you a clear story: the conversation file stays clean (it's the transcript), the sidecar file holds spatial/saved-views (sharable when you want), workspace state holds the operator's session ephemeral state, global state holds preferences.

Let me work through each in more depth.

The notebook file is the conversation transcript. It's already standardized as Jupyter-shaped JSON. The temptation is to stuff layout state into the notebook's metadata field, since `.ipynb` allows arbitrary metadata.

Resist this for most layout state. Reasons:

What should go in the notebook file's metadata:

Conversation identity: zone IDs referenced by the conversation, the agent ID(s) that are part of this conversation, the kernel version. Stuff that's intrinsic to "what this conversation is."

Annotations that are conversation content: if the operator annotated a spot on the map as part of the conversation ("this is where the bug was found"), that's part of the conversation. But operator's general doodles or drawings while exploring? Those go in the sidecar.

Saved structural state: "this conversation is paired with these zones" — yes. "I had the camera zoomed to 1.5x at coordinates (340, -120)" — no.

The principle: notebook metadata is for things that, if stripped, would change what the conversation is. Layout doesn't change what the conversation is; it changes how it was viewed.

A sidecar file is the right home for the bulk of layout state. The pattern: notebook is `auth_refactor.rts.ipynb`; sidecar is `auth_refactor.rts.layout.json` (or `.rts.ipynb.layout`, your choice).

What goes in the sidecar:

Spatial positions of all entities in the conversation's scope: zones (their hulls/centroids), agents (their positions), files (their positions in the workspace map), edges and their styling, service nodes, etc. This is the "geometry" of the visualization.

Saved viewpoints: named camera positions with optional filters and time ranges. "Auth area," "yesterday's incident," "before the refactor." Operator-curated.

Persistent annotations: text notes, drawn arrows, highlighted regions. Stuff the operator wants to keep but isn't part of the conversation's content.

Layer visibility: which optional overlays are on (heatmap, edges-by-recency, etc.) for this specific notebook.

Sidecar files are nice because:

A simple convention: the sidecar lives next to the notebook (`<name>.rts.ipynb` and `<name>.rts.layout.json`). When the notebook opens, the fork looks for the sidecar; if absent, generates a default layout. When the notebook is closed, the fork writes the sidecar if layout state changed.

VS Code provides workspace state via its `Memento` API — key-value storage scoped to the workspace. Use this for:

Camera state per notebook: where each open map was looking when last viewed. Restored on reopen. Doesn't travel with the file (different operators want different views).

Filter and query state: which agents the operator was highlighting, what time range they were filtering to, which event types were on. Per-session preference.

Recently-used viewpoints: which saved viewpoints from the sidecar the operator has been using.

Per-notebook UI state: which sidebar sections are expanded, which artifacts are pinned, what panel layout the operator has.

Workspace state is the right place for "operator's session preferences for this workspace." It's persistent (survives VS Code reloads) but local (different operators on the same files have different preferences). VS Code's API handles the storage; you just call `context.workspaceState.get/update`.

This is also the right place for things you might want to invalidate selectively: if your map data model changes in a way that breaks old camera positions, you bump a version key and start fresh. The user's preferences don't survive a schema break, but the conversation does.

VS Code provides global state via `context.globalState`. Use this for:

Visual preferences: theme choice (dark/light/custom), color schemes, default symbol styles, default zoom level. Things the operator decides once and applies everywhere.

Default layouts: a "default visual configuration" that applies to new conversations.

Operator identity: name, default agent preferences, default zone behavior. Per-user metadata that shouldn't be per-file.

Recently opened RTS files: a recent-files list scoped to RTS notebooks specifically.

Global state is small, stable, and operator-scoped. Keep it small; don't put per-conversation things here.

The storage taxonomy is clear; the loading sequence is where the work is. When the operator opens an RTS notebook:

Step 4 is the interesting one because layout might lag behind notebook content. The notebook references zones and agents that might not be in the layout sidecar (newly created since last save). Your fork needs to gracefully extend the layout when new entities appear (auto-place new zones in available space, etc.) and write back the updated layout when the notebook closes.

This isn't hard but it's worth being deliberate. The layout sidecar is partial — it stores known positions, defaults are computed for unknown ones. Don't error when sidecar entries are missing; fill them in.

Subtle but important: layouts will evolve. The fields in your layout schema will change as features are added. Operators will have layout files from old versions.

The standard answer is a `version` field at the top of the layout sidecar:

When the fork reads a layout file, it checks the version. If older, it migrates (best-effort) to current; if newer, it warns and falls back to defaults. Standard schema-evolution pattern.

For v1, lock the schema deliberately. Don't get clever; pick simple structures for spatial positions, viewpoints, annotations. You can always add fields; removing or changing existing fields is hard.

A reasonable v1 layout schema (just for sketching):

Simple, extensible, versioned. v1 ships with this; future versions add fields.

Operators open a new RTS notebook. There's no sidecar. What does the map look like?

You have to compute a default layout from the notebook's content. This is auto-layout, and it's a real algorithm:

For zones: arrange by relationship — zones that share files are placed near each other. Force-directed layout works here. Default zone shape is a hull around its files.

For files: hierarchical layout based on filesystem path. Files in the same directory cluster. Subdirectories nest visually.

For agents: positioned at their current locus of activity. If an agent is touching files in zone X, the agent appears near zone X. If multiple agents are working, spread them so they don't overlap.

For edges: drawn as straight lines initially. Bundle later if density warrants.

For camera: zoom to fit, with all zones visible.

The default layout is computed once when no sidecar exists, then saved as the initial sidecar. From there it's user-modifiable.

The default layout is genuine engineering work. Plan for it as a v1 task in itself — maybe a few days. Force-directed layout libraries exist; you don't have to invent the algorithm.

When the operator drags a zone, moves an agent, or saves a viewpoint, the change has to flow back to storage. The pattern:

The debounce is important — every drag event shouldn't trigger a disk write. Wait for the user to pause (300ms), then write. Or write only on notebook save.

Workspace-state-level changes (camera position) update on a different cadence — VS Code's `Memento.update()` is fine to call on every camera change; it's a fast in-memory update that VS Code persists in the background.

For viewpoints (named saved positions), the operator explicitly creates them. "Save current view as 'auth area'" → fork captures camera + filter state, writes to layout sidecar with the chosen name.

A real concern: as a conversation runs for hours or days, more zones, agents, files appear. The layout has to grow with the conversation without operator intervention.

Auto-place new entities: when a new zone is created mid-conversation, auto-position it (force-directed layout, finding empty space). Operator can drag it later.

Auto-resize zone hulls: as files move into a zone, the hull updates to encompass them. This happens continuously, not just on save.

Don't move existing entities without permission: if the operator has positioned a zone at a specific spot, don't auto-move it on each new entity. Stability is important; layouts should feel stable.

Periodic compaction: as entities are removed (zone closed, agent terminated), positions can be reclaimed. Don't shrink the canvas continuously; offer a "compact layout" command that re-runs auto-layout for active entities.

These are continuous-update behaviors that the layout system has to handle. They're not trivial but they're standard auto-layout territory.

The operator opens two notebooks side by side. Each has its own layout sidecar; the maps are independent.

But they might overlap in content (same zones, same files referenced by multiple notebooks). What happens?

Independent layouts: each notebook's map is its own world. Same zone might appear at different positions in different notebooks. This is honest — different conversations have different focuses.

Cross-notebook reference: a notebook can reference a "global" layout file that's workspace-scoped, not file-scoped, providing common positions for entities that recur. Optional, advanced.

For v1, independent layouts. Cross-notebook coordination is a v2+ feature. Notebook A's map and notebook B's map are independent; if both reference zone X, they each have their own position for it. Less elegant but simpler.

There's an interesting framing worth considering: the layout file is not just position storage but a visualization spec. It says how the conversation should be rendered, including positions, but also potentially:

Treating layout as a richer spec means the same notebook content can be rendered differently for different purposes:

These can be saved as different viewpoints within the layout sidecar, or as separate layout files (`auth_refactor.rts.layout.code-review.json`, etc.).

For v1, I'd hold this in reserve — implement basic spatial layout + saved viewpoints. The richer "layout-as-visualization-spec" comes later as you understand what operators actually want.

The kernel doesn't store layout. The kernel manages live state — zones, agents, events, conversation history. Layout is presentation, not data.

But the kernel emits events that imply layout updates: "zone X created," "agent Y spawned," "file Z added to zone X." The fork's layout system listens for these and updates the layout accordingly (auto-placing new entities, updating zone hulls).

The kernel can have an opinion about initial placement (e.g., "this agent belongs to zone X" → place near zone X), but the layout itself is the fork's responsibility. The kernel exposes facts; the fork renders them.

This separation is clean. Kernel state is the truth about the world; layout is the truth about how the operator chooses to view it.

Pulling it all together:

To keep this tractable, v1 only implements:

Sidecar storage: the JSON file with the v1 schema (spatial positions, named viewpoints, simple annotations). Read on open, write on save.

Workspace state: camera position per notebook. Filter state. Just two or three Memento keys.

Global state: theme preference, default zoom. Maybe two or three keys.

Auto-layout: a simple force-directed implementation for zones; hierarchical for files within zones; agents anchored to zones. Works "well enough."

No annotations in v1: defer the drawing/annotation UI. Layout is positions only.

No multiple layouts per notebook: one sidecar per notebook, one current layout. Multi-layout is v2.

No cross-notebook coordination: each notebook is independent.

That's tractable in maybe 3-4 days of focused work for a v1 layout system. Plus maybe 2-3 days for auto-layout if you don't pull in a library.

Layout storage decomposes into seven distinct kinds of state, mapping to four storage locations: notebook file (minimal), sidecar JSON (most spatial state), VS Code workspace state (session ephemera), VS Code global state (preferences). Each is the natural home for its kind of state.

The notebook stays clean. The sidecar holds the geometry. Workspace state holds session memory. Global state holds preferences. Versioning lets schemas evolve. Auto-layout fills gaps when state is missing.

For v1, lock simple JSON schemas, implement basic auto-layout, write sidecars on save, store camera state in workspace memento. This is a few days of work; it scales to the full layout vision over time without architectural rework.

Decisions worth committing:

Want to dig into the auto-layout algorithm specifically, the JSON schema for the sidecar in more detail, the migration strategy for schema evolution, or how the layout system communicates with the map view's webview?

```json
{
  "version": 1,
  "spatial": { ... },
  "viewpoints": { ... },
  "annotations": [ ... ]
}
```

```json
{
  "version": 1,
  "spatial": {
    "zones": {
      "zone_id_1": {
        "type": "polygon",
        "points": [[x1, y1], [x2, y2], ...],
        "color": "#abc",
        "label_offset": [dx, dy]
      },
      "zone_id_2": { ... }
    },
    "agents": {
      "agent_id_1": { "x": 100, "y": 200, "anchor": "zone_id_1" }
    },
    "files": {
      "/path/to/file.py": { "x": 50, "y": 60 }
    },
    "edges": {
      "rendering": "default" | "bundled" | "hidden"
    }
  },
  "viewpoints": {
    "viewpoint_name": {
      "camera": { "x": 0, "y": 0, "zoom": 1.0 },
      "filters": { "agents": ["agent_id_1"], "time_range": [...] },
      "description": "..."
    }
  },
  "annotations": [
    {
      "id": "uuid",
      "type": "note" | "arrow" | "region",
      "position": [x, y],
      "content": "...",
      "created_at": "..."
    }
  ]
}
```

- The notebook file is small and clean; it shouldn't bloat with display state
- Sharing the notebook (git, collaborator) shouldn't force them to inherit your camera position
- Layout-as-metadata is a leak — what's "the conversation" gets entangled with "how I was viewing it"
- Notebook diffs become noisy if camera state changes every save

- They're optional. The notebook works without them; the operator just gets a default layout.
- They're shareable selectively. Send a colleague the notebook + sidecar; they get your layout. Send just the notebook; they start fresh.
- They're git-friendly. Commit them or don't, your choice. They diff well as JSON.
- They don't bloat the notebook.
- They're independently editable. Layout-management tools can update them without touching the conversation.

1. Notebook editor opens the .rts.ipynb file — VS Code's standard pipeline, with your fork as the editor for this file type.
2. Kernel starts up — LLMKernel launches, connects, reports ready.
3. Map view opens (if the operator triggers it) — webview panel in a tab.
4. Layout sidecar is loaded — your fork reads <name>.rts.layout.json if present; populates the map view's spatial state.
5. Workspace state is consulted — last camera position, filter state restored.
6. Global state applied — visual preferences, theme.
7. Live state subscribed — kernel emits updates; map view receives them.

1. Operator interaction in the map view
2. Webview message to the extension host: "user moved zone X to (a, b)"
3. Extension updates in-memory layout state
4. On save (or after debounce): write layout sidecar to disk

- Which event types to show (filter)
- How to bundle edges (rendering hint)
- What labels to display (display config)
- What time range is the "default view" for this conversation
- Color encoding choices (categorical vs activity-based)

- "Code reviewer's view": time range filtered to recent changes, agents hidden, only zones and edits shown
- "Debug view": all events shown, time scrubbing enabled
- "Presentation view": clean labels, no internal events, focused camera

1. Notebook file (.rts.ipynb): minimal layout metadata — zone references, agent IDs in the conversation. No camera, no positions, no annotations.
2. Sidecar file (<name>.rts.layout.json): spatial positions, saved viewpoints, persistent annotations. Optional; auto-generated default if absent. Versioned schema.
3. VS Code workspace state: per-notebook session state — camera position, current filters, pinned artifacts, panel arrangement.
4. VS Code global state: visual preferences, themes, default styles, recently opened files.
5. In-memory only: replay/scrub position, hover states, transient selection.
6. Auto-layout for new entities: force-directed for zones, hierarchical for files, anchored for agents. Stable on existing positions.
7. Sidecar updates on save and on debounce: not on every drag.
8. Workspace state updates frequently: camera position is fine to update on each pan.
9. Versioned schemas with migration paths: especially for the sidecar.
10. Independent layouts per notebook in v1: cross-notebook coordination deferred.
11. Layout as visualization spec is a future direction: v1 just does positions and viewpoints.
12. Default layout is auto-computed when no sidecar exists; saved as initial sidecar.

1. Sidecar JSON file for spatial state, named viewpoints, annotations.
2. Simple v1 schema, versioned, with migration support.
3. VS Code workspace state for camera/filter/session.
4. VS Code global state for preferences.
5. Auto-layout for new entities with stability for existing ones.
6. Layout writes debounced on save; workspace-state updates frequent.
7. No annotations or multi-layout in v1; defer to v2.
8. Independent layouts per notebook in v1; cross-notebook coordination deferred.
9. Layout-as-visualization-spec is a future direction; v1 just does positions and saves.

