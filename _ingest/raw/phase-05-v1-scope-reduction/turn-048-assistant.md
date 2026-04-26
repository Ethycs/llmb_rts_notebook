---
turn_id: 048
merged_turn_id: 036
role: assistant
phase: 05-v1-scope-reduction
source_lines: [3697, 3937]
source_sha256: 14ca20b74849c51befd19323fa74207e44631fc411608a7abea359cf9b2ca0fa
char_count: 19683
---



## Assistant

Good move. The architecture has accumulated genuine complexity across this conversation — chroot/bubblewrap, Vega/VegaFusion, NATO symbology, ACP/Claude SDK/HTTP adapters, SSH transport, MCP proxies, namespaces, event logs, 3D projection, multi-platform support. All of it earns its place eventually, but a v1 that tries to ship all of it ships nothing.

Let me work through what the simplest credible v1 looks like, on the principle that v1 should prove the core hypothesis with the smallest possible surface area, and make it easy to grow into the full architecture later.

Worth naming, because it determines what's load-bearing and what's decoration:

The hypothesis: An RTS-style spatial/categorical visualization of agent activity, with file-level zone-of-control, gives an operator meaningfully better awareness and control over a fleet of coding agents than existing tools (logs, dashboards, agent-native UIs).

What this hypothesis specifically requires:

What this hypothesis does not require:

Every one of those is interesting and several are required for the good version of the product. None are required for a v1 that tests the hypothesis.

Here's what to cut for v1, in roughly the order I'd cut:

Cut 3D/VR entirely. This was always a v3 feature. 2D map only.

Cut macOS. Linux-only. Mac users wait for v2 or run a Linux VM themselves with no support from you. Don't build the Mac launcher; don't test on Mac.

Cut multi-host and SSH transport. Single host. Local Unix socket between CLI and daemon. Document SSH support as future work.

Cut multi-agent-framework support. Pick one agent framework. Almost certainly Claude Code via the Agent SDK, because (a) richest control surface, (b) you're using it daily, (c) the permission-hook story is real and load-bearing. Don't build the ACP adapter, don't build the OpenCode HTTP adapter. One agent type.

Cut MCP. Agents have whatever built-in tools they have. No MCP servers, no MCP proxy. This is a clean upgrade path — you can add MCP later without invalidating anything.

Cut bubblewrap; use plain chroot. Yes, bubblewrap is better. But chroot is `unshare(CLONE_NEWNS) + pivot_root` (or just `chroot()` for v1) and it's ten lines of Rust. Bubblewrap is a dependency the user has to install. For v1, plain chroot inside a mount namespace is enough — you get filesystem isolation, which is the part that matters for the zone metaphor. Network/PID/etc. namespacing comes later.

Cut the live-editable policy engine. Zone policies are static config files set at zone creation. Changing a zone's policy means recreating the zone. This is fine for v1; live policy editing is a polish feature.

Cut the event log as source of truth. Just have a Postgres or SQLite table for state, append events to a JSONL file for audit. You don't need event sourcing in v1; you need to ship.

Cut NATO symbology as the rendering primitive. It's still the right answer, but milsymbol is one more dependency. For v1, simple colored shapes (circles for agents, rectangles for files, lines for edges) are enough. The categorical language can be added when the UX is settled.

Cut Vega/VegaFusion entirely. Yes, it was a beautiful idea. But for v1's data volumes (tens of agents, thousands of events) you don't need a column-store dataflow engine. A plain React + D3 (or just React with raw SVG) frontend reading from a websocket is fine. Vega comes back when scale demands it.

Cut the magic CLI. Or rather, scope it ruthlessly: just enough to spawn an agent and inspect a zone. No prefix-launcher, no preexec hook, no shell integration. Just `rts-cli new-zone alpha`, `rts-cli spawn alpha 'task description'`, `rts-cli status`.

Cut per-zone SSH servers. Defer the cross-domain story until multi-host is a real concern.

Cut the Plan 9 / Urbit / namespace philosophy from the implementation. Keep it as a guiding philosophy in your head; don't materialize it as `/control/` files synthesized via FUSE. For v1, the RTS daemon owns state in memory and exposes it via a websocket. Files-as-interfaces can be added later without breaking anything.

After all those cuts, here's the v1 system:

A Rust daemon that:

A web UI that:

A CLI with three commands:

That's it. That's v1.

It's worth looking at what falls out of this even with all the cuts:

That's the full hypothesis, validated. The hypothesis is not "the architecture should look like Plan 9 with MCP and 3D and SSH"; it's "RTS metaphor for agent oversight is useful." V1 tests that.

Five components. Each does one thing. Each can be replaced or extended later without breaking the others.

This is small enough to lay out actual steps. Three weeks, generously paced.

Week 1: Core daemon and one agent.

Week 2: Web UI and permission hooks.

Week 3: CLI, polish, real workload.

End of week 3: a thing you can actually use. Single host, single agent type, simple chroot, in-memory state with SQLite persistence, basic SVG map, three CLI commands. That's the v1.

A few things to lock now, because they'll affect the build:

Send-message to agent. Claude Code doesn't have a clean "inject prompt mid-run" via files. The cleanest mechanism in v1 is to use the SDK's `query()` interface: rather than spawning the CLI, embed Claude Code via the Python or TypeScript SDK in a small wrapper that exposes a `send_message` operation. This gives you proper prompt injection. Cost: the wrapper is a Node or Python process per agent rather than the bare CLI. Worth it for the message-injection capability.

Permission hook transport. Claude Code's permission hooks are most cleanly invoked via the SDK's hook callback (synchronous in-process function) or via a callable command. For v1 with the SDK wrapper above, hook callbacks are just function calls in the wrapper that ping back to the daemon over a Unix socket. Sub-millisecond latency.

Map layout. Don't try to be clever in v1. Each zone is a rect at a fixed position on screen (or laid out in a grid). Files inside a zone are listed in a column with their names. Agents are drawn at the top of the zone they're working in. Edges are straight lines. It will look basic. Good. The point is to test the concept, not to ship the final aesthetic.

Persistence model. SQLite, single file. Tables: `zones(id, name, root_path)`, `agents(id, zone_id, status, started_at)`, `events(id, agent_id, timestamp, event_type, payload_json)`. Three tables, queries are obvious. State on restart is "load zones, see which agents were running, mark them as 'lost' (process is gone), let user respawn."

Handling the "agent crashed" case. Just mark the agent as crashed in the UI and show its last events. Recovery is "kill it and spawn a new one." Don't try to be smart about resuming; that's a v2 feature.

Single-user assumption. No auth, no multi-user. Daemon listens on Unix socket and localhost websocket. If you want to access from another machine, SSH-tunnel it manually. Don't build cross-machine support into v1.

No SDK skill. Don't build the magic prefix-CLI. Don't build the chroot engine as a separate library. Don't build the MCP proxy. All of these are v2+.

For honest record-keeping, the things v1 defers and how they fit later:

Every deferred feature is additive — none requires retrofitting the v1's structural decisions, as long as you don't make those structural decisions wrongly.

These are the ones that hurt to change later, so do them right even in the simple build:

These six things are essentially free to do right in v1 and expensive to retrofit. Everything else is fungible.

Imagine the demo:

You open a terminal, run `rts new-zone refactor ~/projects/my-app`. The daemon creates `/var/lib/rts/zones/refactor/` with bind mounts of host system + a bind mount of `~/projects/my-app` as `/workspace`. Then `rts spawn refactor 'Refactor the auth module to use JWT instead of sessions'`. The daemon launches a Claude Code agent in that chroot.

You open `http://localhost:3000`. You see a single colored region labeled "refactor" with the file list inside it. A circle for the agent appears, with its current status. As the agent reads files, edges flash from the agent to those files; you see it's reading auth.py, jwt_helper.py, sessions.py. When it tries to write, a permission prompt pops up: "Agent wants to write `auth.py`. Allow?" You click allow. The map shows a write-edge.

You spawn a second agent in a different zone, working on a different task. Now there are two regions, two agents, working in parallel. You watch them both. One of them goes off track — keeps reading the same file repeatedly. You click its circle, see its recent reasoning, type "stop reading auth.py, look at the test file instead" into the message box, and the agent's next turn picks that up.

When the agents are done, you click on the files they modified to open them in your editor. Standard `xdg-open` flow.

That's the whole product. It's small. It's also, importantly, qualitatively different from "tail two terminal windows showing Claude Code logs," which is the current state of the art. The map view, the permission gates, the cross-agent comparison, the easy intervention — those are the value adds, and they're all in v1.

If this demo doesn't feel useful, none of the architectural elaboration matters. If it does feel useful, you have a base to grow from.

That's a tractable v1. It's small enough to ship in three weeks, opinionated enough to feel coherent, and structured to grow into the larger architecture without repainting.

Want to drill into the daemon's internal API, the Claude Code SDK wrapper specifics, the websocket message schema, or the layout problem for the simple v1 map?

```javascript
┌─────────────────────────┐
                │  Web browser            │
                │  - React + SVG map      │
                │  - Sidebar with agents  │
                │  - Approval buttons     │
                └────────┬────────────────┘
                         │ websocket
                         ▼
   ┌──────────────────────────────────────────┐
   │  rts-daemon (Rust)                       │
   │  - In-memory state                       │
   │  - SQLite persistence                    │
   │  - Spawns agents via chroot              │
   │  - Parses stream-json events             │
   │  - Hosts permission-hook HTTP callback   │
   │  - Websocket server for UI               │
   │  - Unix socket for CLI                   │
   └────────┬───────────────────┬─────────────┘
            │                   │
            │ Unix socket       │ chroot() + fork() + exec()
            ▼                   ▼
   ┌─────────────────┐   ┌─────────────────────────┐
   │  rts CLI        │   │  Claude Code agents     │
   │  - new-zone     │   │  - Each in own chroot   │
   │  - spawn        │   │  - Each its own zone    │
   │  - status       │   │  - --output-format      │
   └─────────────────┘   │    stream-json          │
                         │  - permission hooks     │
                         │    POST to daemon       │
                         └─────────────────────────┘
```

1. Multiple agents, each in a bounded zone
2. Visible activity (operator sees what agents are doing in real time)
3. Spatial/categorical encoding (some map view, some symbolic vocabulary)
4. Operator control (issue commands, intervene)
5. Drill-through to the actual objects

- Multi-host
- VR/3D
- Macos
- Multi-operator
- MCP
- SSH transport
- Permission proxies
- Multiple agent frameworks
- A live-editable policy engine
- An event log as source of truth
- Plan 9 / Urbit aesthetics
- A custom shell prefix CLI

- Runs as the operator's user (no daemon, no privilege drop, no setuid)
- Maintains in-memory state for zones, agents, files, events
- Exposes a websocket for the web UI
- Spawns Claude Code agents in chroot'd subdirectories
- Captures their stdout (the --output-format stream-json event stream)
- Parses tool-use events and emits them on the websocket
- Implements permission hooks as a callback URL the agent's SDK invokes
- Stores everything in SQLite for persistence (rebuild state on restart)

- Connects to the daemon via websocket
- Renders zones as colored regions, files inside as small rects, agents as colored circles
- Shows tool calls as edges (agent → file) that flash on event arrival
- Has a sidebar: list of agents with current activity
- Has a click-to-open-in-editor handoff via xdg-open
- Has a "send message" box per agent for prompt injection
- Has pause / resume / kill buttons per agent

- rts new-zone <name> <path> — creates a zone backed by a directory
- rts spawn <zone> '<prompt>' — launches a Claude Code agent in that zone with that initial prompt
- rts status — lists active zones and agents

- Multiple agents in bounded zones: yes, via chroot per zone
- Visible activity: yes, via the event stream + websocket + map
- Spatial encoding: yes, via the simple map view (zones + files + agents + edges)
- Operator control: yes, via permission hooks (approve/deny each tool call), pause/resume/kill, and prompt injection
- Drill-through: yes, via xdg-open

- Day 1-2: Rust scaffolding. SQLite schema for zones, agents, events. Tokio runtime, websocket server, Unix socket server.
- Day 3: chroot setup. Given a zone name and a workspace directory, create a chroot tree (bind-mount host /usr, /lib, etc., plus the workspace as /workspace), populate /control/prompt and /control/policy files, return a launchable struct. Plain chroot() syscall, run as root, drop to nobody after exec. ~150 lines.
- Day 4: agent spawn. Command::new("claude") with --output-format stream-json --permission-mode plan (or whatever bypass mode), inside the chroot, with stdout piped. Parse the JSONL event stream. ~200 lines.
- Day 5: event handling. For each event from the agent, classify it (tool call, message, init, etc.), insert into SQLite, broadcast on websocket.

- Day 6-7: React frontend skeleton. Vite, TypeScript. Websocket client. Render a list of zones and agents from the state stream.
- Day 8: Map rendering. Zones as colored rounded rects. Files within zones as small rects. Agents as circles positioned... somewhere reasonable. Edges from agents to files when tool calls happen, animating in and fading out. Pure SVG, no D3 yet.
- Day 9: Permission hooks. Configure Claude Code to call back to the daemon's HTTP endpoint for permission decisions. Daemon returns approve/deny based on a simple policy (in v1: any path inside the zone's workspace is allowed; anything else denied). Add a UI toggle for "manual approval mode" where each tool call pauses and waits for operator click.
- Day 10: Action buttons. Per-agent: pause (SIGSTOP), resume (SIGCONT), kill (SIGTERM), send message (write to /control/prompt which... actually we need a slightly different mechanism for Claude Code; see below).

- Day 11: CLI. clap-based, talks to daemon via Unix socket. Three commands.
- Day 12: xdg-open handoff. Click a file in the UI → daemon resolves to host path → spawn xdg-open. Handles the OS-level "open with" trivially.
- Day 13: Real workload test. Spawn an agent in a zone with an actual coding task. Watch the map. Iterate on visual issues that emerge.
- Day 14-15: Polish. Better layout. Persistent state across daemon restarts. Error handling for agent crashes. Documentation.

- Multiple agent frameworks: add an adapter trait, second adapter for ACP. Easy in v2 because the event handling already abstracts over event sources.
- Bubblewrap: replace chroot with bwrap invocation in the launch path. Same shape, more isolation.
- MCP: add as a new event type in the existing event pipeline, plus a proxy server. Doesn't disturb anything.
- Live policy: replace static policy with a watched file or DB row, recompute on change. Internal refactor.
- Event log as truth: switch SQLite from authoritative storage to a derived index over the event log file. Internal refactor.
- 3D / VR: orthogonal. Reads same websocket data.
- macOS: package the daemon for Linux VM, build a Mac launcher. No architectural change.
- SSH / multi-host: add an "RTS daemon address" config to the CLI; add SSH-aware transport. CLI-level change.
- Multi-operator: add auth and audit. Daemon-level change.
- NATO symbology: replace simple shapes with milsymbol rendering. UI-level change.
- Vega / VegaFusion: replace direct websocket-to-React with a Vega-driven view. UI-level change, only when scale demands it.

1. Events have a stable schema. (id, agent_id, zone_id, timestamp, event_type, payload) with payload being JSON. Versioning on event_type. This becomes the foundation of everything.
2. The daemon is a server, not a library. Web UI and CLI both go through it. Don't be tempted to make the CLI directly read SQLite — that's a single-user shortcut that becomes a pain.
3. Zones are first-class entities, not just chroot directories. They have IDs, metadata, lifecycle. The chroot is an implementation detail of how a zone is realized.
4. Tool calls are events, not state. A tool call happens, it's logged, it modifies state if successful. Don't model "agent is currently doing X" as a state field; derive it from "most recent tool-call event without completion."
5. Permissions are decisions, recorded. Every tool call's permission decision (auto-allowed by policy, manually approved, auto-denied, manually denied) is logged with reason. Even in v1 this discipline pays off because the UI can show it and you can audit it.
6. One agent = one OS process tree, fully isolated. Don't share state between agents in the daemon's memory in ways that would be hard to untangle later. Each agent's events flow through the same pipeline but are tagged with agent ID throughout.

1. The simple visual might be too simple. Two zones with file lists and circles might not feel like a meaningful visualization. You might need to invest in the layout/encoding earlier than v1 plans. Mitigation: do a half-day prototype of the rendering first, make sure it doesn't feel like a debug dashboard.
2. Permission interruptions might be too disruptive. If every tool call requires approval, the agent stalls and the operator gets fatigued. Mitigation: default to "auto-allow inside zone, deny outside zone, ask only for unusual cases." Manual mode as opt-in.
3. chroot setup time per agent is non-trivial. Bind-mounting host + setting up /proc etc. takes ~1-2 seconds. For v1 this is fine but it's a hint that v2 should cache rootfs templates.
4. Claude Code's permission hook semantics need to be understood deeply. This is the load-bearing integration point and v1 depends on it working cleanly. Spend the time to understand the exact event stream and hook protocol before committing to the architecture. (You probably already have, given prior turns, but it's the thing to verify first.)
5. Risk of premature abstraction. Even after these cuts, it's tempting to introduce traits and indirection "for v2 flexibility." Resist. Hardcode Claude Code in v1. Hardcode chroot in v1. Hardcode the simple map. Generality comes later, with concrete information about what needs to vary.

1. Rust + TypeScript, daemon + browser frontend, SQLite, websockets, Unix socket for CLI. No surprises in the stack.
2. Claude Code via the Agent SDK as the only agent integration. TypeScript SDK probably easiest to embed for the message-injection mechanism. Rust daemon spawns a Node subprocess wrapper.
3. Plain chroot() for v1, with bind-mounts for host runtime. No bubblewrap.
4. No 3D, no VR, no Mac, no SSH, no MCP, no multi-host, no live policy, no event-log-as-truth, no Vega.
5. Simple SVG map, no NATO symbols yet.
6. 3-command CLI, no shell integration.
7. Single-user, single-host, localhost only.

