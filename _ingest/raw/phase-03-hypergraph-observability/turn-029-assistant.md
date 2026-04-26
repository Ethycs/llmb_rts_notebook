---
turn_id: 029
merged_turn_id: 020
role: assistant
phase: 03-hypergraph-observability
source_lines: [1745, 1939]
source_sha256: eca7f434b5632298da23f9afbbd8e3c368100e9e4b79a830879a367e9f650093
char_count: 20023
---



## Assistant

Now the design gets interesting in a way it wasn't before. Urbit and Plan 9 aren't decoration here — they genuinely solve problems you're about to hit, and each offers something different. Let me work through what's worth stealing and what you'd want to leave behind.

Plan 9's two load-bearing ideas:

Everything is a file, including interfaces. Processes, network connections, windows, graphics devices — all appear as files in a hierarchical namespace with read/write semantics. Want to know what a process is doing? Read its files. Want to interact with it? Write to its files. No special APIs, no RPC frameworks — the filesystem protocol (9P) is the universal interface.

Namespaces are per-process and composable. Every process has its own view of the filesystem. You don't modify global state to mount something; you modify your namespace. A child process inherits its parent's namespace by default but can diverge freely. Two processes can have completely different views of what "/" contains. Bind mounts layer directories on top of each other; union mounts merge them.

Applied to your RTS, this is immediately concrete:

Zone of control = a namespace. Each agent gets its own namespace. Its zone is literally the paths visible and writable in that namespace. "Transfer object from zone A to zone B" is a bind mount operation in the two namespaces. "Share" is a union mount in both. "Fence" is a namespace restriction. The zone metaphor stops being a policy layer applied at hook-time and becomes a structural property of the agent's environment. This is better than policy because it's enforceable at the OS level and doesn't depend on agent cooperation.

Objects as files, uniformly. Files are files. Services expose themselves as files (read = query, write = command). Agent control surfaces are files (write a message to `/agent/alpha/prompt`, read status from `/agent/alpha/status`, append to `/agent/alpha/interrupt`). The RTS doesn't need per-object-type interfaces — it needs a file browser with live tailing. And "click to open with" becomes trivial: everything the OS already knows how to do with files, your RTS inherits for free.

Event streams as files. The agent's tool-call stream is `/agent/alpha/events`, which you tail. The RTS's world state is `/rts/world/objects`, `/rts/world/zones`, `/rts/world/edges` — all files, all streamable, all introspectable with `cat`. Debugging the system is `ls` and `tail`.

On Linux this is achievable in multiple ways:

Urbit's useful ideas, ignoring the parts you don't want:

Stable identity. Every ship has a permanent, content-addressed identity (the pier), and computations are scoped to that identity. You don't "log in" — you are your ship. Applied to agents: every agent has a persistent, cryptographically-rooted identity, and its state, history, and ownership are all anchored to that identity. Agent reboots, migrations, and reassignments preserve identity. This is actually a real problem for agent fleets — agents are currently ephemeral and indistinct — and Urbit's approach is a clean answer.

Personal namespace addressed through identity. Urbit paths look like `~zod/home/foo`: ship name, desk (application), then path. You address data through its owner. Applied to your RTS: every object lives under some zone's namespace, and the path is `rts://agent-alpha/code/foo.py` or `rts://shared/services/db`. Cross-zone references are explicit in the URL structure. You always know whose territory a thing is in.

Deterministic event log. Urbit's core insight is that the entire system is a pure function over an event log — all state is derivable by replaying events from genesis. This gives you time travel, debugging, and rollback for free, and it's the same idea as event sourcing but taken to its logical conclusion. Applied to your RTS: if every agent action and every zone change is appended to a log, the entire world state at any point is `fold(log[0..t])`. Scrubbing time is a real operation, not a UI illusion. Replaying "what did agent X do" is exact, not approximate.

Single-level store. Urbit erases the distinction between memory and disk. Applied to your RTS: you shouldn't have a "runtime state" vs "persistent state" split. The event log is the persistent state; the in-memory Arrow tables are a cache. Crash recovery = replay. This simplifies a lot of engineering.

What you don't want from Urbit: the whole functional programming stack (Nock, Hoon, the Arvo kernel model) is admirable but orthogonal to your goals. You're borrowing concepts, not adopting the runtime.

Combining the two, plus what you already have:

Everything in this hierarchy is navigable with `ls`/`cat`/`tail`. The RTS UI is one view on this namespace; a power user's terminal with `tmux` is another; a FUSE mount plus VS Code opening `~alpha/code/` is a third. The map on screen is a visualization of the namespace, not an independent state model.

Plan 9's notion that the interface is the filesystem means you don't need to design a separate command protocol. The operator's command "pause agent alpha" is `echo 'pause' > /rts/agents/~alpha/interrupt`. The agent's current status is `cat /rts/agents/~alpha/status`. The RTS's GUI is a thin layer over these file operations.

Policy is a file. Specifically, each agent has `/rts/agents/~alpha/zone-policy`, and its contents are something like:

The operator (or the RTS UI) edits this file. The agent's permission hook reads it on every tool call. Changes propagate live because the hook reads the current file, not a cached policy. Version control for free: the policy file is in git, or in the event log, or both.

"Live policy object" is literally just a file you edit. Plan 9's philosophy collapses what would otherwise be a whole abstraction layer (policy engine, rules, APIs, UI to edit rules) into: a file. The RTS's job is to make editing that file pleasant and to visualize its effects on the map.

This is also where the zone operations from earlier get cleaner:

These are text operations on the policy files. The visual UI for them (drag on map, right-click menu) is surface; the reality is file edits, which means they're scriptable, version-controllable, and observable.

With this model, TUI coexistence becomes straightforward rather than a special case. The OpenCode TUI connects to its HTTP server; your RTS connects to the same HTTP server; both are clients. Plan 9 semantics handle the rest:

This is a legitimately nice property: the RTS isn't privileged. It's one viewer among many, and it can visualize other viewers' interactions alongside the agents'. A pair-programming session with Claude Code appears as two entities (human and agent) both editing files, with the map showing their interaction pattern. That's genuinely new.

Much of Plan 9's magic requires real infrastructure, and you don't need all of it on day one. Here's a staged path:

Stage 1: logical namespace only. The RTS internally treats agent zones as namespaces, exposes them via URI paths (`rts://agent/alpha/code/foo.py`), and applies policy at the permission-hook layer as before. No OS-level namespaces yet. You get the model, the UI, the command vocabulary — all the conceptual benefits. What you don't get is enforcement that survives if the hook is bypassed.

Stage 2: event log as source of truth. Append-only log of all events (tool calls, policy changes, zone operations). Arrow tables are derived. Time scrubbing works. Replay works. This is the Urbit part and it's mostly engineering, not research.

Stage 3: FUSE filesystem for the RTS namespace. The logical namespace becomes a real filesystem you can `cd` into. Agent control surfaces become real files. Operators can use their normal tools (`grep -r` through an agent's event log, `tail -f /rts/agents/~alpha/events`). This is where the Plan 9 philosophy starts paying off practically — tool interop for free.

Stage 4: real per-agent mount namespaces. Each agent runs in its own Linux mount namespace with bind-mounted zones. Enforcement becomes structural, not policy-based. An agent can't escape its zone because the paths outside it literally don't exist in its namespace. This is operationally heavy but gives you real isolation.

Stage 5: optional 9P server. Expose the RTS over 9P for the committed Plan 9 aesthetic. Mostly for fun, but gives you remote filesystem access with great semantics.

Stages 1 and 2 are the essential ones. 3 is high-value. 4 is a research arc. 5 is a hobby project. I'd target 1+2 in the initial build and 3 as the first real milestone past that.

Combining Urbit's identity model with Plan 9's namespace model changes what the RTS is, in a useful way:

Previously: "RTS" as a UI over agent telemetry, with a policy engine bolted on.

Now: the RTS is the namespace that coordinates agents; the UI is one of several views on it. The namespace is the product. The map is the marketing. The command line is the power-user interface. FUSE-mounted filesystems are the "advanced" user interface. Other tools (editors, grep, scripts, future agents) integrate by speaking to the namespace.

This is architecturally more honest, because the namespace outlives any particular UI. If someone wants to build a Blender-style 3D viewer for the RTS, they read the same namespace. If someone wants a Slack bot that reports on agent activity, it tails the event log file. The RTS becomes a substrate, and the question "what does the RTS do" answers cleanly: it provides a shared namespace for agents and operators to work in.

A few places this bites:

Object identity is Plan 9-style paths, not database IDs. `rts://agent/alpha/code/src/foo.py` is the identifier, and it's a path, and path arithmetic works. Move an object = rename. Share an object = link/bind. This is structurally simpler than an ID-based schema because the name is the location.

Zones are real, not notional. A zone has a namespace root. Membership is computed by namespace contents. The hull-drawing problem on the map becomes "draw a hull around the paths visible in this namespace." Layout follows the hierarchical structure of the namespace naturally.

Cross-zone edges are cross-namespace references. When agent alpha's event log mentions a path from beta's zone, that's a cross-namespace reference, and the graph visualization renders it as a cross-zone edge exactly because the paths tell you which zones they belong to. The edge type information comes from the path structure for free.

Agents can introspect each other through the namespace. If your policy allows, agent alpha can read `rts://agent/beta/events` and know what beta is doing. This enables coordination patterns that are complicated in other models — a supervisor agent watches its workers by reading their event streams. This is good and you should lean into it.

The event log needs real design. If it's the source of truth, its format matters. You want append-only, structured (Arrow record batches are fine), chunked for efficient range scans, content-addressed if you want Urbit-level determinism. A lakeFS-backed parquet store is already in your wheelhouse and does most of this.

The updated two-week spike:

Week 1: namespace + event log, no OS-level magic yet.

Week 2: FUSE mount of the namespace + TUI coexistence.

End state: you have a namespace-backed RTS with Plan 9-style file interfaces, Urbit-inspired event log as source of truth, TUI coexistence working, and multiple agents integrated. That's the foundation; everything else is mechanics on top.

The thing that's interesting about this version of the project — and why it probably ends up being what you build — is that it collapses several things that were separate:

That kind of collapse is what good architecture does. You were heading toward it anyway (the telemetry-to-graph compiler, canonical schemas, dataflow thinking all point here), but Urbit and Plan 9 give you the specific vocabulary and precedents for the collapse. Both of those systems are niche partly because they were built as replacements for all of computing, which is too much. Applied narrowly — as the internal architecture of a specific tool — their ideas are much more tractable, and they earn their keep.

The project now has a shape I'd describe as: a namespace-structured substrate for agent work, with a strategy-game-style UI as one of several views, realized through event sourcing and Plan 9-style file interfaces. That's a cleaner sentence than "RTS for agents," and it's a better product description for what you're actually building.

Worth settling next:

Want to drill into the event log design, the namespace schema specifically, FUSE implementation, or the identity/naming question?

```javascript
Every agent owns a ship (Urbit-style identity)  ──┐
                                                   │
  ~alpha/                                          │
    code/             <- bind-mounted from $HOME/proj-a  (Plan 9 namespace)
    services/         <- FUSE filesystem projecting service endpoints
    events            <- the agent's event stream as a readable file
    prompt            <- writable; messages here reach the agent
    interrupt         <- writable; signal-style interruption
    status            <- readable; current state
    log               <- readable; stderr tail
    zone-policy       <- readable/writable; live policy object
                                                   │
  ~beta/                                           │
    code/             <- bind-mounted from $HOME/proj-b
    services/
    ...
                                                   │
  ~shared/                                         │  (overlay/union mount)
    common/           <- union-mounted into multiple agents' namespaces
    services/         <- globally visible service endpoints
                                                   │
  /rts/                                            │  (RTS's own synthetic FS)
    world/
      objects         <- all objects, as streamed table
      zones           <- zone membership, as streamed table
      edges           <- live interaction edges
    event-log         <- authoritative append-only log (Urbit-style)
    commands          <- writable; operator commands go here
    agents/
      ~alpha/         <- links to agent-alpha's root
      ~beta/
```

```javascript
read:
  - ~alpha/**
  - ~shared/**
  - ~beta/code/api/*.md   # explicit cross-zone reads
write:
  - ~alpha/**
exec:
  - ~alpha/bin/*
  - ~shared/bin/test
services:
  allow: [db-readonly, cache, logging]
  deny: [payments, admin]
```

- Mount namespaces (kernel native, via unshare(CLONE_NEWNS)) — per-process filesystem views, with bind mounts and overlayfs. This is the kernel's direct Plan 9 descendant. The primitives are there.
- FUSE for synthesizing filesystems where things aren't really files (services, agent control). Write the agent-control-as-files mapping once, every tool that speaks files can interact with your system.
- 9P itself via v9fs / diod — Linux kernel can speak 9P, and exposing your RTS state via a 9P server gives you actual Plan 9 semantics. Probably overkill but beautifully clean.

- Transfer = move a path from ~alpha's policy to ~beta's
- Share = add the same path to both policies (with appropriate read/write split)
- Fence = restrict a policy to a subset
- Merge zones = union the two policies
- Split zone = partition one policy into two

- Both clients observe the same event stream (it's a file, both are tailing it).
- Both clients can send commands (they write to the same control files; the agent serializes them).
- The RTS sees the TUI's interactions as events on the map, because they flow through the same tool-call stream. Watching the operator's human interaction with OpenCode's TUI is just another edge on the graph — the "operator" becomes a pseudo-agent whose zone is its own.

1. Mount namespaces are Linux-only and add operational complexity. macOS doesn't have them; the per-agent filesystem-isolation story is Linux-first and possibly Linux-only. For a research/personal tool this is fine; for broad adoption it's a constraint to name upfront.
2. FUSE has overhead and edge cases. Syscall round-trips through userspace, occasional weird behaviors with certain tools (vim's swap files, editors that expect specific stat results). Worth prototyping a trivial FUSE namespace early to feel the friction.
3. Plan 9 aesthetics can seduce you into over-engineering. The temptation to make everything a file leads to places where it actually doesn't fit (synchronous RPC, stream multiplexing, structured data that needs transactions). Be willing to have ordinary APIs alongside the namespace when the namespace is the wrong abstraction. The goal is to use Plan 9 where it's clearly better, not to recreate it.
4. Urbit's event-log-as-truth is expensive at agent velocities. A Claude Code session at full speed emits hundreds of events per second. Replaying a long session to recover state is slow without snapshotting. You'll want periodic state snapshots with the log as the authoritative delta — this is how every serious event-sourced system works, and it's fine, just not as pure as Urbit's formulation.
5. Naming is a research problem. Urbit ship names are a whole thing (phonetic, pronounceable, content-addressed). You probably don't need that but you do need a stable, human-readable, globally-unique identifier scheme for agents and zones. UUIDs are ugly and unmemorable; sequential names collide; content-addressed hashes are stable but unreadable. This is more design work than it sounds.
6. The namespace-as-UI metaphor has limits. Some operations don't fit the file model well: atomic multi-file transactions, complex queries across many entities, things that want a database. Don't contort the namespace to avoid a real query layer when one is needed. VegaFusion/DataFusion still has a role; it operates on the tables that are derived from the namespace, not the namespace directly.

- Rust service. Every agent event appends to an Arrow-format log file. The "namespace" is a logical structure built by replaying the log into in-memory tables.
- Expose the namespace via a REST API (GET /rts/agents/alpha/events, etc.). Logical paths, real responses, no actual filesystem yet.
- One agent: Claude Code, launched with a wrapper that sets its identity (RTS_AGENT_ID=alpha) and routes its hooks through your service.
- Zone policy as a JSON file, read fresh on every hook.
- Frontend: the map view, but also a sidebar showing the namespace as a tree — operators can drill in by navigation, not just clicking on the map.

- FUSE filesystem that exposes the REST API as a real filesystem (there are good Rust crates — fuser). cat /mnt/rts/agents/alpha/events works. echo 'message' > /mnt/rts/agents/alpha/prompt sends a message.
- Run Claude Code via its CLI alongside your RTS observing it. Both work simultaneously. The map shows agent activity; the TUI shows the agent's perspective; they're coherent because both tap the same event stream.
- Add a second agent (OpenCode via ACP) to prove the adapter-layer abstraction holds with different event sources feeding the same namespace.

- The zone of control, the permission policy, and the agent's namespace are the same object from different angles.
- The event log, the state database, and the audit trail are the same object from different angles.
- The map visualization, the CLI interface, and the FUSE mount are the same object from different angles.

1. Event log format — Arrow record batches in parquet? A custom binary format? JSONL for the v1 to defer optimization?
2. Naming scheme — UUIDs with human aliases? Urbit-style generated names? Just let the user name their agents?
3. FUSE or HTTP-first — FUSE is the real Plan 9 experience but HTTP is easier to build and debug. I'd argue HTTP first, FUSE as a second interface atop the same API.
4. Identity persistence — does ~alpha survive restarts? Across machines? What's in the pier analogue?

