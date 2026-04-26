---
turn_id: 096
merged_turn_id: 082
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [10165, 10678]
source_sha256: aabceb3e4b59377dc8d8f526b5c29cd383a50e0a5a047064f4771324b1d79009
char_count: 26900
---



## Assistant

Now the storage architecture has a clean shape — three different data structures for three genuinely different kinds of state, each chosen because it matches the structure of what it represents. Let me work through why this decomposition is right, what each structure looks like concretely, and where the integration points sit.

This is a real architectural insight worth naming. Most systems would default to "one storage scheme, applied uniformly" — store everything as JSON, or store everything as a graph, or stuff everything into a database. That fails because different kinds of state have different shapes, and forcing them into one structure either bloats the structure or distorts the data.

Your decomposition matches each data type to its natural shape:

Layout is hierarchical. Zones contain files. Files belong to zones. Workspaces contain zones. The map view itself is a composition of regions and sub-regions. This is a tree — and operations on layout (adding a file to a zone, moving a zone within a workspace, nesting groups) are tree operations. Forcing a tree into JSON or a graph distorts it; trees have native operations (insertion, traversal, subtree manipulation) that JSON and graphs don't express cleanly.

Agent state and config is a graph. Agents have relationships: parent-child (one agent spawned another), peer (two agents collaborating), client-server (one consumes another's output), supervisor (one approves another's actions). Configuration also forms a graph: which tools an agent has, which MCP servers it connects to, which zones it's bound to, which other agents it can communicate with. These relationships have cycles (agent A might depend on B which depends on A). Graphs handle this; trees and JSON don't.

Chat flow is JSON. Conversations are sequences of structured events with optional nesting. LangSmith blobs are already JSON. Streaming protocols are JSON. Persistence as JSON is canonical. Operations on chat (append, query, replay, branch) are sequence/tree-of-records operations that JSON handles natively.

Each structure is the right fit. The architecture is honest about the data's actual shape rather than imposing uniformity for storage convenience.

Let me work through what the layout tree actually looks like, because the choice has implications for how things are addressed and updated.

The natural hierarchy:

This is a tree because:

Concretely, the layout tree as JSON-serializable structure (because storing trees in JSON is fine; the structure is the tree even if the serialization format is JSON):

The format is JSON, but the structure is a tree. Operations on it are tree operations: traverse, find by path, replace subtree, insert child, remove subtree.

Tree-shaped operations the layout system supports:

Tree libraries handle this well. You don't need a database; you need a tree library and JSON persistence.

The layout tree lives in the sidecar file — `.rts.layout.json` next to the notebook, as discussed last turn. The format is what we just sketched: hierarchical JSON with explicit type tags and children arrays.

Workspace state (camera position, current filter) is not in the tree. It's session-ephemeral, in VS Code's workspace memento. The tree captures structure; the memento captures view state.

Updates to the tree happen on debounce (drag a zone → wait 300ms → write tree to disk) or on explicit save. Writes are atomic — write to a temp file, rename. Standard pattern.

When the notebook opens, the fork loads the tree, populates the map view's spatial state. When new entities appear (kernel notifies of new zones), the tree is extended (auto-layout finds a position, adds a node). When entities are removed, the tree is pruned (or the node is marked inactive — debatable design choice, lean toward pruning for cleanliness).

Agents and their configuration are the graph layer. This is where the relationships matter more than hierarchy, where cycles can exist, and where you want graph-native operations.

What's a node, what's an edge:

Nodes in the graph:

Edges in the graph:

This is a multi-typed, multi-relation graph. Some edges have direction (parent_of); some are symmetric (collaborates_with); some have properties (a "has_tool" edge might have permissions metadata).

The right storage for this is some kind of graph store. Options:

Option A: In-memory graph with JSON serialization. Use a library like `graphology` (TypeScript) or `networkx` (Python) for in-memory operations; serialize to JSON for persistence. This is the simplest viable path. A typed graph with named edges, stored as JSON, queried via library APIs.

Option B: Embedded graph database. Something like `kuzu`, `memgraph` embedded mode, or LMDB-backed graph storage. More features (Cypher-like queries, indexing, ACID), more setup cost.

Option C: Triple store. RDF-style storage where everything is `(subject, predicate, object)` triples. Very flexible; less ergonomic for typed access.

For v1, Option A is right. In-memory graph with JSON persistence. Libraries are mature, no database to manage, queries are just function calls. When you need more (large graphs, complex queries), upgrade to Option B.

Concretely, the graph might look like:

Same JSON serialization as the layout tree, but the structure is a graph. Operations on it are graph operations:

A graph library handles all of these efficiently. You don't need a real database for v1.

This is more interesting than the layout tree, because agent state is runtime state, not persistent state. Agents are alive or dead; their status changes constantly; new edges form as they collaborate.

Two storage layers:

The kernel's in-memory graph: the live, current state. Nodes and edges as agents spawn, configurations change, relationships form. The kernel maintains this; the fork queries it.

Persistent graph snapshots: periodically (or on shutdown), the kernel serializes its graph to a side file (`.rts.agents.json`). This survives kernel restarts. On restart, the kernel restores from the snapshot.

The graph isn't in the notebook file (it's not part of the conversation's identity — agents may be reused across notebooks). It's not in the layout sidecar (different concern). It's its own persistence layer, kernel-owned.

The fork queries the kernel's graph for rendering: "show me all agents in zone X" → kernel walks the graph → returns a list. The fork renders. When the operator drags an agent to a different zone, that's a graph mutation: kernel updates the edge ("in_zone" pointed from agent to old_zone is replaced with one pointing to new_zone).

This separation is clean: the kernel owns runtime agent state; the fork displays it. The graph is a runtime data structure that happens to persist for resilience.

The third leg. Conversations are sequences of LangSmith-shaped run records. JSON is the natural format because:

The structure is fundamentally a sequence with optional tree-shaped nesting (a run can have child runs). JSON handles this natively.

What's stored:

Storage layers for chat flow:

Inside the .rts.ipynb file: cell-level runs. Each cell that's been executed has its outputs as MIME-typed displays. This is what makes the notebook the durable conversation transcript.

A side log (event log): append-only stream of every run, including ones that don't end up in cells (intermediate runs, child runs the cell renderer collapses, etc.). Format is JSONL. This is the kernel's full event history.

The notebook file is curated; the event log is comprehensive. They serve different purposes — the notebook for sharing/reading, the event log for debugging/replay.

Standard event-log structure. Queryable with `jq`. Replayable by reading sequentially. Branchable by reading up to a point and forking.

The interesting part. These three storage systems aren't independent — they reference each other.

Layout tree → agent graph: when the layout renders an agent symbol on the map, it asks the agent graph "what's this agent's status, what zone is it in, what tools does it have?" The graph provides the rendering metadata.

Layout tree → chat flow: when the layout renders a file's "recent activity" indicator, it queries the chat flow "what runs touched this file recently?" The chat flow provides the activity events.

Agent graph → chat flow: when an agent is rendered with its current activity, the graph references the chat flow for the agent's most recent runs.

Chat flow → agent graph: each run record references the agent that produced it. The chat flow is annotated with agent IDs that resolve to nodes in the graph.

Chat flow → layout tree: when a tool call references a file, the renderer wants to show the file on the map — looking up the file's position in the layout tree.

These cross-references mean the three structures are loosely coupled but not independent. They share IDs (agents have stable IDs across all three; files have stable paths; zones have stable IDs). Each structure is the source of truth for its own concern; the others reference it by ID.

The three-structure design works because each concern has a natural data shape, and IDs are the glue that holds them together. No single structure tries to capture everything; each does its part.

Updating the storage taxonomy from last turn with this three-structure decomposition:

The `.rts/` directory becomes a workspace-scoped store for kernel persistence. It's per-workspace (different RTS workspaces have their own agent graphs and event logs). It's not shared across workspaces (each is self-contained). It's gitignored by default but can be checked in if the operator wants version control.

The notebook file and its layout sidecar are file-scoped. Operators share them by sending the files; layout travels with the notebook (optionally) but agent graph and event log are workspace-scoped.

This separation is clean: per-file content (notebook, layout sidecar) for things specific to one conversation; per-workspace state (`.rts/` directory) for things spanning multiple conversations in the same workspace; per-operator state (VS Code Mementos) for preferences and session ephemera.

Each structure has its own version field and migration path. They don't have to evolve in lockstep.

Independent versioning means you can evolve schemas independently. Add a field to the layout tree without touching the agent graph. Standard pattern for federated schemas.

For v1, lock simple schemas. v1 layout tree has zones, files, agents, viewpoints. v1 agent graph has nodes (agents, zones, tools, operator) and edges (spawned, in_zone, has_tool, supervises). v1 chat flow uses LangSmith schema v1 (whatever the canonical version is at v1 ship date).

Future versions add fields. Migration code lives in the kernel and the fork; it reads old versions and converts to current.

A few operations touch all three:

Spawning an agent:

All three structures updated by one operation.

Transferring a file between zones:

Three structures, one operation.

Branching a conversation:

The most complex operation. Three structures plus filesystem operations.

These multi-structure operations need transactional consideration: if step 3 fails after steps 1-2 succeed, the structures end up inconsistent. For v1, you can rely on best-effort with operator-visible errors (something failed, please retry). For v2, real transactions across structures matter.

The other interesting case: queries that span structures.

"Show me every agent that touched auth.py":

"Show me the full state at time T":

Cross-structure queries are real but tractable. The kernel can serve these by orchestrating across its data sources.

LLMKernel's job expands. It's now the source of truth for:

The fork's job:

The kernel does data work; the fork does presentation work. The two communicate via the kernel protocol (with custom RTS-specific messages for graph queries and updates) and via shared filesystem (the kernel writes `.rts/agents.json`, the fork reads it; the fork writes the layout sidecar, the kernel reads it for context).

To make this concrete, here are starter schemas for each structure:

Layout tree v1:

Agent graph v1:

Chat flow v1 (LangSmith-shaped JSONL):

Three schemas, three storage locations, one coordinated system.

To keep this practical:

Layout tree: no library needed. JSON is fine. Tree operations are 50 lines of TypeScript or Python (find, walk, insert, remove, move).

Agent graph: `graphology` (TypeScript) for the fork's in-memory queries; `networkx` (Python) in the kernel. Both serialize to JSON.

Chat flow: no library needed. JSONL is fine. Append, read, parse.

Optional: a lightweight JSON schema validator for each structure (`ajv` in TypeScript, `jsonschema` in Python). Validates loaded files; catches schema drift early.

No databases. No SQL. No graph databases. Just three data structures with JSON persistence and library support for in-memory operations.

Pulling together:

Stepping back: this three-structure decomposition gives you a system where each kind of state has the right representation. Not forcing a tree into a graph, not forcing a graph into a tree, not flattening either into JSON-as-bag-of-fields.

The result:

This is the kind of decomposition that pays compound interest. Each new feature you build will fit in one of these structures (with maybe some IDs in the others). Schema evolution is local. Bugs are contained. Refactoring is bounded.

Concrete v1 work for the storage layer:

Layout tree (~2-3 days):

Agent graph (~2-3 days):

Chat flow (~1-2 days):

Cross-structure coordination (~2-3 days):

Total v1 storage layer: ~1.5 weeks of focused work, parallelizable between fork (layout tree) and kernel (graph + chat flow).

Three structures, three storage choices, three sets of operations. Each fits the data's natural shape. JSON is the persistence format for all three (so tooling is uniform), but the in-memory representations are what matters: tree for hierarchy, graph for relationships, sequence for events.

The decomposition is right because it respects what the data actually is. A layout is a tree. Agent state is a graph. Chat flow is a sequence. Forcing any of them into the wrong shape would create friction; matching them to their right shape produces a clean system.

For v1, no databases. Just JSON files with in-memory libraries. Total ~1.5 weeks for the storage layer. Scales naturally to v2+ with more sophisticated needs (real graph database, real time-travel for layouts, etc.) without architectural rework.

Decisions to lock:

Want to dig into the specific tree operations for layout, the graphology API design for the agent graph, the LangSmith JSONL schema details, or the cross-structure ID conventions?

```javascript
Workspace (root)
├── Visual configuration (theme, defaults, render settings)
├── Map regions (top-level layout containers)
│   ├── Zone "refactor"
│   │   ├── Position (centroid, hull, color)
│   │   ├── Files (children of the zone)
│   │   │   ├── auth.py (position relative to zone)
│   │   │   ├── tokens.rs (position)
│   │   │   └── ...
│   │   ├── Agents anchored to this zone
│   │   └── Sub-zones (if you want nesting)
│   ├── Zone "tests"
│   │   └── ...
│   └── Commons (unclaimed territory)
│       └── Files not yet in any zone
├── Saved viewpoints (named camera + filter states)
│   ├── "auth area"
│   ├── "yesterday's incident"
│   └── ...
└── Annotations (operator-authored content)
    ├── "this is where the bug was found" at (x, y)
    └── ...
```

```json
{
  "version": 1,
  "type": "workspace",
  "id": "root",
  "config": {
    "theme": "dark",
    "default_render": "default"
  },
  "children": [
    {
      "type": "zone",
      "id": "zone_refactor",
      "name": "refactor",
      "position": { "centroid": [100, 200] },
      "render": { "color": "#3b82f6", "hull_style": "smooth" },
      "children": [
        {
          "type": "file",
          "id": "file_auth_py",
          "path": "src/auth.py",
          "position": { "x": 110, "y": 210 },
          "render": { "size": "medium" }
        },
        {
          "type": "file",
          "id": "file_tokens_rs",
          "path": "src/auth/tokens.rs",
          "position": { "x": 130, "y": 220 }
        }
      ]
    },
    {
      "type": "viewpoint",
      "id": "viewpoint_auth_area",
      "name": "auth area",
      "camera": { "x": 110, "y": 210, "zoom": 1.5 },
      "filters": { "zones": ["zone_refactor"] }
    }
  ]
}
```

```json
{
  "version": 1,
  "nodes": {
    "agent_alpha": {
      "type": "agent",
      "name": "alpha",
      "model": "claude-sonnet-4.5",
      "status": "running",
      "config": { ... }
    },
    "agent_beta": {
      "type": "agent",
      "name": "beta",
      "model": "claude-haiku-4.5",
      "status": "idle"
    },
    "zone_refactor": {
      "type": "zone",
      "name": "refactor",
      "policy": { ... }
    },
    "operator_main": {
      "type": "operator",
      "name": "main"
    },
    "tool_request_approval": {
      "type": "tool",
      "name": "request_approval",
      "schema": { ... }
    }
  },
  "edges": [
    { "from": "operator_main", "to": "agent_alpha", "type": "spawned", "at": "2026-04-25T10:00:00Z" },
    { "from": "agent_alpha", "to": "zone_refactor", "type": "in_zone" },
    { "from": "agent_alpha", "to": "tool_request_approval", "type": "has_tool" },
    { "from": "agent_alpha", "to": "agent_beta", "type": "spawned", "at": "2026-04-25T10:15:00Z" },
    { "from": "agent_beta", "to": "zone_refactor", "type": "in_zone" }
  ]
}
```

```jsonl
{"id": "run_001", "trace_id": "trace_001", "type": "agent", "name": "alpha", "start": "...", "inputs": {...}}
{"id": "run_002", "trace_id": "trace_001", "parent_run_id": "run_001", "type": "tool", "name": "request_approval", "inputs": {...}, "outputs": {...}, "end": "..."}
{"id": "run_003", "trace_id": "trace_001", "parent_run_id": "run_001", "type": "llm", "name": "claude_call", "inputs": {...}, "outputs": {...}}
...
```

```json
{ "version": 1, "type": "workspace", ... }   // layout tree
```

```json
{ "version": 1, "nodes": {...}, "edges": [...] }   // agent graph
```

```jsonl
{"version": 1, "id": "run_001", ...}   // each event has version
```

```json
{
  "version": 1,
  "type": "workspace",
  "id": "root",
  "config": { "theme": "dark" },
  "children": [
    {
      "type": "zone" | "file" | "agent" | "viewpoint" | "annotation",
      "id": "...",
      "position": { ... },
      "render": { ... },
      "children": [ ... ]
    }
  ]
}
```

```json
{
  "version": 1,
  "nodes": {
    "<id>": {
      "type": "agent" | "zone" | "tool" | "operator" | "mcp_server",
      "data": { ... }
    }
  },
  "edges": [
    {
      "from": "<id>",
      "to": "<id>",
      "type": "spawned" | "in_zone" | "has_tool" | "supervises" | "collaborates_with",
      "data": { ... }
    }
  ]
}
```

```jsonl
{"version": 1, "id": "run_001", "trace_id": "trace_001", "parent_run_id": null, "type": "agent" | "tool" | "llm" | "chain" | "retriever", "name": "...", "start_time": "...", "end_time": "...", "inputs": {...}, "outputs": {...}, "error": null, "tags": [], "metadata": {}}
```

- Every node has exactly one parent (a file belongs to one zone, a zone belongs to one workspace)
- Operations like "move file from zone A to zone B" are subtree-rooted (cut from one parent, paste to another)
- The hierarchy expresses real containment (zones contain files, workspaces contain zones)
- Traversal patterns are natural: "render this zone's contents" is "walk the subtree from this zone"

- Find: locate a node by ID or path (workspace.zones[refactor].files[auth.py])
- Walk: traverse the tree to render or query
- Insert: add a child to a parent (new file in zone)
- Remove: cut a subtree (zone deleted)
- Move: change a node's parent (file transfers from zone A to zone B)
- Update: modify a node's properties (change zone color)
- Diff: compute what changed between two layout trees

- Agents (each agent is a node)
- Zones (zones are nodes too — they're entities agents reference)
- MCP servers (the daemon, external MCP servers)
- Tools (each tool an agent can call is a node)
- Files (when files are referenced by agents, they're nodes — but careful, files are also in the layout tree)
- The operator (yes, the operator is a node — they connect to agents)

- (agent_a, parent_of, agent_b) — A spawned B
- (agent, in_zone, zone) — agent is bound to a zone
- (agent, has_tool, tool) — agent has access to this tool
- (agent, connects_to, mcp_server) — agent is an MCP client of this server
- (operator, supervises, agent) — operator-agent relationship
- (agent_a, collaborates_with, agent_b) — peer relationship
- (agent, has_capability, capability) — what the agent can do
- (agent, configured_with, config_object) — links to configuration data

- Neighbors: find all agents in a zone (query by edge type "in_zone" with that zone)
- Path: find the spawn lineage of an agent (walk parent_of edges)
- Subgraph: extract everything connected to an agent within N hops
- Filter: find all agents with status="running"
- Mutate: add a new edge, remove a node and its incident edges

- LangSmith already specifies JSON schemas
- Streaming agent output is JSON
- .ipynb cell outputs are JSON arrays
- Append-only logs are JSONL (newline-delimited JSON)

- Each cell's executed runs (LangSmith blobs, including inputs, outputs, errors, hierarchy)
- The conversation metadata (which agents are in this conversation, which zone, etc.)
- Branching information (if a cell creates a branch, that's metadata in the cell or in a separate branch index)

1. Kernel creates a new agent node in the graph
2. Kernel adds edges (spawned-by-operator, in_zone, has_tools)
3. Kernel emits a run record (chat flow) marking the spawn event
4. Layout tree gets a new agent node (auto-positioned in the spawn's zone)
5. Map view rerenders to show the new agent

1. Layout tree: file node moves from zone A's children to zone B's children
2. Agent graph: agents bound to zone A might lose access; agents bound to zone B might gain access (depending on policy)
3. Chat flow: emit a run record marking the transfer

1. Chat flow: snapshot the event log up to the branch point; create a new trace_id for the branch
2. Notebook file: copy cells up to the branch point into a new notebook
3. Layout tree: new layout sidecar for the new notebook (initially copied from current)
4. Agent graph: agents may need to be cloned for the branch (zone snapshot)

1. Chat flow: find all runs whose inputs reference auth.py
2. Resolve those runs to agent IDs
3. Agent graph: resolve agent IDs to current agent state
4. Layout tree: find each agent's current position to render highlights

1. Chat flow: replay event log up to time T to derive state at that moment
2. Agent graph: derive what agents existed at T (the kernel can reconstruct from the event log if needed, or store snapshots periodically)
3. Layout tree: layout at T — this is harder; the layout tree is "current" not "historical." For time-travel, you'd need historical layout snapshots, which is v2+.

1. The agent graph (live and persistent)
2. The chat flow event log (live and persistent)
3. Coordination between cells (which produce notebook-resident chat flow) and full event log

1. Layout tree management (read, modify, write the sidecar)
2. Rendering the map view from the agent graph + layout tree
3. Rendering cells from the chat flow's cell-level outputs
4. UI for layout edits (drag zones, save viewpoints)

1. Layout tree in <notebook>.rts.layout.json next to the notebook. JSON-serialized hierarchical structure with zones containing files, workspaces containing zones, etc.
2. Agent graph in .rts/agents.json (workspace-scoped). JSON-serialized typed multigraph. Kernel-owned. Periodically snapshotted; live state is in-memory in the kernel.
3. Chat flow (cells) in <notebook>.rts.ipynb. Standard Jupyter notebook format. Cell outputs are LangSmith-shaped JSON blobs.
4. Chat flow (full log) in .rts/events.jsonl (workspace-scoped). Append-only JSONL. Comprehensive event history including non-cell-level runs.
5. VS Code workspace state for camera, filters, session UI ephemera.
6. VS Code global state for theme and preferences.
7. .rts/ directory is the workspace-scoped store. Per-workspace, gitignored by default.
8. Cross-structure references via stable IDs (agent IDs, zone IDs, file paths, run IDs).
9. Independent versioning per structure, with migration code.
10. No databases for v1. JSON files plus in-memory data structure libraries (graphology, etc.).

- Layout operations are tree operations (clean, well-understood)
- Agent operations are graph operations (clean, well-understood)
- Chat operations are sequence/log operations (clean, well-understood)
- Each can evolve independently
- Each can be debugged by examining its own representation
- Cross-structure coordination is via IDs and queries, not entanglement

- TypeScript module in the fork: LayoutTree class with find/walk/insert/remove/move operations
- JSON schema definition
- Serialization to/from sidecar file
- Auto-layout for new entities
- Integration with the map view

- Python module in LLMKernel: AgentGraph using networkx
- JSON schema definition
- Serialization to .rts/agents.json
- Operations: add agent, remove agent, query by relationship, snapshot
- Custom kernel messages to expose queries to the fork

- LangSmith schema definition for v1
- Append-only writer in LLMKernel for .rts/events.jsonl
- Notebook cell output integration (LangSmith blobs as MIME-typed displays)
- Reader/replayer for branching and time-travel (basic version)

- ID schemes (agent IDs, zone IDs, run IDs)
- Reference resolution (when layout tree references an agent, query the graph)
- Update propagation (when agent state changes, the layout tree's render hints update)

1. Three storage structures: tree for layout, graph for agents, JSON for chat flow.
2. Tree storage: sidecar JSON file per notebook.
3. Graph storage: workspace-scoped .rts/agents.json, kernel-owned.
4. Chat flow storage: notebook for cells, .rts/events.jsonl for full log.
5. No databases for v1: in-memory libraries with JSON persistence.
6. Stable IDs as cross-references: agent IDs, zone IDs, file paths, run IDs.
7. Independent versioning: each structure has its own schema version.
8. VS Code Mementos for ephemera: camera, filters, theme.
9. .rts/ directory for workspace-scoped state: gitignored by default.
10. Library choices: graphology (TS), networkx (Python), ajv/jsonschema for validation.

1. Three storage structures, with the data shapes that match the data.
2. Sidecar layout tree, workspace-scoped agent graph, file-scoped + workspace-scoped chat flow.
3. JSON serialization throughout; in-memory libraries for operations.
4. Stable IDs as the glue between structures.
5. v1 schemas locked, with versioning for evolution.

