# Chapter 03: Hypergraph observability architecture

## Purpose

This chapter captures the architecture as it crystallized in turns 018–028: agents modeled as authors of edges in a temporal multiplex graph, rendered through an RTS-style operator surface, with real coding-agent integrations and filesystem isolation stacked underneath. It is the pre-V1 high-water mark of the design — the shape of the system before the V1 contraction in [chapter 05](05-v1-scope-reduction.md).

## Status

This is the **pre-V1 high-water-mark architecture**. It is not the shipping plan. The V1 cuts strip out 3D/VR, NATO symbology, MCP, bubblewrap, live policy objects, event sourcing as the source of truth, and multiple agent integrations. The hypergraph model survives; most of the rendering and isolation stack does not. Read this chapter for the conceptual frame the rest of the design refers back to, then read [chapter 05](05-v1-scope-reduction.md) for what actually ships.

The lock-in for this phase is **DR-0003**: the six-tier architecture diagram. That diagram is the load-bearing artifact — every later phase either refines a tier, replaces a tier, or cuts a tier.

## The hypergraph model

The model inherited from [chapter 02](02-agent-orchestration-pivot.md) (DR-0002) frames agents as edge authors rather than spatial entities. This phase takes that frame and works out the consequences.

**Nodes.** Two role-typed node populations share one representation:

- *Object nodes* — files, directories, services, APIs, data stores. Positioned by a terrain layout that is stable across ticks; nodes do not jitter when an agent looks at them.
- *Agent nodes* — the agents themselves. Each agent is a node, but it is also (implicitly) a subgraph: its current locus plus the history of edges it has authored. The agent has no single (x, y); it has a set of edges.

The distinction between objects and agents is a role, not a representation. Both are nodes in the same graph, which simplifies layout and lets cross-agent interactions render as ordinary edges.

**Edges.** Every agent action becomes an edge. Concretely, the canonical event shape is:

```
(agent_id, verb, object, metadata, timestamp)
```

A `Read` tool call from Claude Code and a `read_file` method call from OpenCode normalize to the same edge tuple — the adapter layer (described below) is responsible for that normalization. Edges carry a verb (read, write, edit, exec, call), an object reference, a timestamp, and arbitrary metadata (tokens consumed, cost, result status).

Hyperedges enter when one event touches multiple objects at once: an `Edit` that moves content from file A to file B is a single hyperedge with two endpoints. A `Bash` call that touches an entire subtree is a hyperedge spanning that subtree. The graph is a hypergraph rather than a plain multigraph because the underlying agent operations are not always binary.

**Multiplex layer.** Each agent contributes its own edge color. The world state is a multiplex graph: one shared set of nodes, one edge layer per agent. The union is the full picture; filtering to a single layer is the per-agent view; intersection is shared interaction. Multi-agent collaboration patterns (two agents both editing the same file, a supervisor reading a worker's stream) are visible as overlap between layers, not as something the architecture has to model separately.

**Temporal dimension.** Edges are events, not durable connections. They have a timestamp; they fade. The map at time *t* is the projection of the edge set onto a recency window — recent edges are visible and bright; older edges decay into history but remain queryable through the event log. The agent's "position" at *t* is well-defined as the set of edges it has authored within the window, which dissolves the position-jitter problem from earlier framings.

## Temporal multiplex visualization

The rendering problem is **temporal multiplex graph visualization** with categorical node types, categorical edge types, and a live update stream. The visualization layer presents:

- A stable terrain — object nodes laid out by force-directed or structural positioning, refreshed slowly. Operators can navigate the map without things sliding underneath them.
- A live edge stream overlaid on the terrain. As an agent makes a tool call, an edge appears between the agent node and the object node, colored by the agent's layer, weighted by recency. Recent edges pulse; older edges thin out.
- Per-agent filtering. Toggle one layer at a time to see what a single agent has touched. Toggle them all to see fleet-wide activity.
- Status as primary, position as secondary. The earlier discussion (phase 02) flagged that semantic position drifts faster than operators can track. The resolution: position changes slowly, status changes fast, and status is where the action is. Edges carry status; layout does not need to chase it.

Agents' actions become visible as **edge-creation events**. The visualization is fundamentally a stream-rendering problem rather than a state-rendering problem. Token-delta noise (hundreds of stream events per second from a working Claude Code session) is aggregated at the ingest layer into a "thinking" status; only tool calls become visible edges. Hook-driven approval prompts surface as a distinct edge state ("pending"), letting the operator approve or deny visually before the edge commits.

The literature for this kind of view exists — multiplex networks, temporal graphs, and hypergraph visualization are all well-developed. The phase commits to specializing a known visual grammar to an ops tool rather than inventing one from scratch.

## Real-agent integration

The phase verifies that the three target agent runtimes are integrable, then lands on a three-adapter strategy. Most of this gets re-decided in [chapter 06](06-vscode-notebook-substrate.md) once VS Code becomes the host, so the recap is intentionally brief.

**Claude Code.** The cleanest integration surface. Spawn `claude -p "..." --output-format stream-json --verbose --include-partial-messages` and parse newline-delimited JSON off stdout. The Claude Agent SDK exposes a permission hook API so every tool call can be intercepted before execution — this is the load-bearing feature, because it is the mechanism that turns the RTS from observability into control. Run agents with `--permission-mode bypassPermissions` so the only decision-maker is the RTS hook.

**OpenCode.** Runs an HTTP server with the Golang TUI as one of many possible clients. The RTS is just another client. A Stainless-generated SDK gives type-safe access. There is also an `opencode acp` subcommand exposing the same agent over the Agent Client Protocol via stdio.

**ACP (Agent Client Protocol).** Emerging LSP-equivalent for coding agents: JSON-RPC 2.0 over stdio with symmetric bidirectional requests. Speakers include OpenCode, Kiro, Zed, codex-acp, JetBrains plugins, Neovim clients. Building one ACP client gets the long tail for free.

The three adapters all normalize into the canonical `(agent_id, verb, object, metadata, timestamp)` event schema. The rest of the architecture is adapter-agnostic.

OpenClaw is treated as orthogonal — either another peer agent the RTS commands, or an upstream orchestrator that feeds events in. The decision is deferred past V1.

## Filesystem isolation introduction

Zone-of-control becomes structural rather than purely policy-based when the agent's filesystem view is restricted at the OS level. The phase introduces `chroot` as the minimum primitive that makes zones real:

- Each agent runs with its zone directory as `/`. Paths outside the zone do not exist from the agent's perspective; access failures look like ordinary file-not-found errors, which agent tooling already handles.
- Zone operations are filesystem operations: transfer is `mv`, share is `ln`, fence is removing subtrees, snapshot is `cp -r` or a btrfs snapshot.
- The control surface inside the zone is also files: `/control/prompt` (operator writes here), `/control/policy` (live-readable zone policy), `/control/events` (agent appends events the RTS tails). This is the surviving Plan 9 idea — interfaces as files — without the rest of the Plan 9 infrastructure.
- Chroot is acknowledged as a structural convenience, not a security boundary. Friendly coding agents are not trying to escape; the goal is making zone semantics enforceable so the rest of the model is real.

The full ladder of stronger primitives (pivot_root, full Linux namespaces via `nix::sched::unshare`, bubblewrap, systemd-nspawn, container runtimes, microVMs) is mapped out in this phase but the deep argument lives in [chapter 04](04-isolation-and-mcp-placement.md). What this phase commits to is: filesystem isolation is part of the architecture, the agent's zone is a directory, and the upgrade path from `chroot` to namespace-based isolation does not change the zone model.

## The 6-tier architecture (DR-0003)

This is the load-bearing artifact of the phase. The full design stack as committed at the end of phase 03 fits into six tiers, each with a single responsibility.

```
+------------------------------------------------------------+
| Tier 6: Operator Surface                                   |
|   - Map view (multiplex graph rendering)                   |
|   - 2D primary, 3D/VR aspirational                         |
|   - Click-to-open via host OS handoff (xdg-open)           |
+------------------------------------------------------------+
| Tier 5: RTS Core (Rust)                                    |
|   - World state in Arrow tables                            |
|   - Zone, membership, edge data model                      |
|   - Map renderer driver, command dispatcher                |
|   - Event log as authoritative history                     |
+------------------------------------------------------------+
| Tier 4: Agent Adapters                                     |
|   - ACP adapter (JSON-RPC over stdio, generic)             |
|   - Claude Code stream-json adapter (permission hooks)     |
|   - OpenCode HTTP adapter (generated SDK client)           |
|   - All normalize to canonical event schema                |
+------------------------------------------------------------+
| Tier 3: Process Supervisor                                 |
|   - Spawns agents, tracks PIDs and subprocess trees        |
|   - Signal control: pause, resume, cancel, kill            |
|   - Captures stdio and log streams                         |
|   - Cgroup tagging on Linux                                |
+------------------------------------------------------------+
| Tier 2: Isolation Engine                                   |
|   - chroot today, bubblewrap/namespaces tomorrow           |
|   - Per-agent zone as filesystem root                      |
|   - Bind-mounts host runtime read-only                     |
|   - Control files: prompt, policy, events                  |
|   - Zone ops as filesystem ops                             |
+------------------------------------------------------------+
| Tier 1: Agent Processes                                    |
|   - claude CLI                                             |
|   - opencode serve / opencode acp                          |
|   - openclaw                                               |
|   - any future ACP-compliant agent                         |
+------------------------------------------------------------+
```

The same content as a table:

| Tier | Name | One-line responsibility |
| ---- | ---- | ----------------------- |
| 6 | Operator Surface | Multiplex graph rendering, command input, click-to-open via host OS |
| 5 | RTS Core | Arrow-backed world state, zone/edge model, event log, command dispatcher |
| 4 | Agent Adapters | Translate Claude Code, OpenCode, ACP events into the canonical edge schema |
| 3 | Process Supervisor | Spawn, track, signal, and capture I/O from agent subprocesses |
| 2 | Isolation Engine | Per-agent filesystem zones via chroot (bubblewrap upgrade path) and control files |
| 1 | Agent Processes | The actual coding-agent CLIs running inside their zones |

Read top-down, the operator clicks the map (Tier 6), the RTS Core (Tier 5) consults its world state and dispatches a command, the matching adapter (Tier 4) translates it into the agent's protocol, the supervisor (Tier 3) signals the process if needed, the isolation engine (Tier 2) mediates filesystem access, and the agent process (Tier 1) does the actual work. Read bottom-up, an agent action emits an event, the isolation engine sees it as a tool call within the zone, the supervisor captures the I/O, the adapter normalizes it, the RTS Core appends it to the event log and updates the relevant tables, and the operator surface re-renders the affected edges.

The two-week shape committed at the end of the phase is: week 1 covers Tiers 1–3 plus the Claude Code adapter; week 2 covers the ACP adapter, a second agent in its own zone, and the operator surface refinements that prove the architecture is adapter-agnostic.

## What carries forward / what gets cut

**Carries forward into V1 and beyond:**

- The hypergraph model itself — agents as edge authors, the canonical `(agent_id, verb, object, metadata, timestamp)` schema, the multiplex layering. This is the most durable artifact of the phase.
- The "interfaces as files" idea, narrowed: the agent's control surface (prompt, policy, events) is files inside the zone. The Plan 9 generalization (everything everywhere is a file, 9P, FUSE) does not survive.
- Zone-as-directory mental model. Even after V1 cuts the bubblewrap-based isolation, the zone is still conceptually a directory the agent works in.
- The adapter layer's normalization principle. Even when the integration count drops, the canonical event schema persists.
- Event sourcing as a debugging and replay aid. Not always as the source of truth (V1 demotes it), but the log structure stays.

**Gets cut in V1 ([chapter 05](05-v1-scope-reduction.md)) and after:**

- 3D/VR rendering and NATO/SIDC symbology. Tier 6 ships as a 2D map only.
- bubblewrap, mount namespaces, full Linux namespace isolation. Tier 2 collapses to plain chroot or simpler.
- macOS support, SSH operation, multi-host orchestration.
- MCP as designed in this phase (it returns in a different role in [chapter 06](06-vscode-notebook-substrate.md), as the chat protocol rather than as an integration layer).
- The "live policy object" as a separately edited live file. Policy is mostly absorbed into the structural chroot in V1.
- VegaFusion and the magic CLI ideas hanging around the rendering tier.
- Most of the agent integrations. V1 picks one agent (Claude Code) and defers ACP/OpenCode/OpenClaw.

**Re-decided rather than cut:**

- Tier 6 (operator surface). The decision in [chapter 06](06-vscode-notebook-substrate.md) replaces the bespoke web/desktop UI with a VS Code extension and a notebook substrate, which is a substantial reshape. The hypergraph model still feeds whatever UI sits on top, but the surface is no longer a custom map renderer — it is cells in a notebook augmented by a graph view.
- Tier 4 (adapters). MCP becomes the bidirectional communication protocol in [chapter 06](06-vscode-notebook-substrate.md) (DR-0008), and the adapter layer's job changes from "normalize three agent dialects" to "expose an MCP surface and let the agent call tools."

The headline: keep the model and the schema, cut most of the rendering and isolation stack, re-host the operator surface inside VS Code.

## Source turns

- [00-overview](../../_ingest/raw/phase-03-hypergraph-observability/00-overview.md)
- [turn-023 — agent integration landscape, adapter strategy, first-cut tier diagram](../../_ingest/raw/phase-03-hypergraph-observability/turn-023-assistant.md)
- [turn-024](../../_ingest/raw/phase-03-hypergraph-observability/turn-024-assistant.md)
- [turn-025](../../_ingest/raw/phase-03-hypergraph-observability/turn-025-assistant.md)
- [turn-026](../../_ingest/raw/phase-03-hypergraph-observability/turn-026-assistant.md)
- [turn-027 — consolidated SDK/adapter writeup with the canonical RTS-Core-on-top tier diagram](../../_ingest/raw/phase-03-hypergraph-observability/turn-027-assistant.md)
- [turn-028 — TUI coexistence, live policy, Urbit/Plan 9 pointer](../../_ingest/raw/phase-03-hypergraph-observability/turn-028-user.md)
- [turn-029 — Plan 9 namespaces, Urbit identity, namespace-as-substrate framing](../../_ingest/raw/phase-03-hypergraph-observability/turn-029-assistant.md)
- [turn-030](../../_ingest/raw/phase-03-hypergraph-observability/turn-030-user.md)
- [turn-031 — chroot as boring-and-correct simplification of Plan 9 namespaces](../../_ingest/raw/phase-03-hypergraph-observability/turn-031-assistant.md)
- [turn-032](../../_ingest/raw/phase-03-hypergraph-observability/turn-032-user.md)
- [turn-033 — isolation primitive ladder up to bubblewrap](../../_ingest/raw/phase-03-hypergraph-observability/turn-033-assistant.md)
- [turn-034](../../_ingest/raw/phase-03-hypergraph-observability/turn-034-user.md)
- [turn-035 — Linux/WSL2/macOS path, Mac as Linux-VM](../../_ingest/raw/phase-03-hypergraph-observability/turn-035-assistant.md)
- [turn-036](../../_ingest/raw/phase-03-hypergraph-observability/turn-036-user.md)
- [turn-037](../../_ingest/raw/phase-03-hypergraph-observability/turn-037-assistant.md)
- [turn-038](../../_ingest/raw/phase-03-hypergraph-observability/turn-038-assistant.md)
- [turn-039](../../_ingest/raw/phase-03-hypergraph-observability/turn-039-assistant.md)
- [turn-040](../../_ingest/raw/phase-03-hypergraph-observability/turn-040-assistant.md)
