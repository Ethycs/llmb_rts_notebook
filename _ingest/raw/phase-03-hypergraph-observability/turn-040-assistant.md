---
turn_id: 040
merged_turn_id: 028
role: assistant
phase: 03-hypergraph-observability
source_lines: [2767, 2797]
source_sha256: 14e2a1589a1c391be8c83bbe118afa9697c2bb31fe9cbbbb98eb45f50f2c5e5f
char_count: 3922
---



## Assistant

Reading top-to-bottom, the architecture has six tiers, each with a single clear job:

Operator interfaces — four coexisting front-ends, all reading the same state. The 2D map is the authoring surface. The 3D monitor is the projection-from-2D for comfortable long-session watching. OS handoff drops you into your real editor via `xdg-open`. Agent TUIs (OpenCode's TUI, Claude Code's interactive mode) run alongside as peer clients — neither the RTS nor the TUI is privileged.

RTS core — the Rust service that owns the world. VegaFusion + Arrow for dataflow, an Arrow-native world state with zones/objects/edges tables, an event log as Urbit-style source of truth, live policy objects as editable files, the command dispatcher for zone operations, and the symbol renderer using milsymbol / NATO APP-6 glyphs.

Agent integration adapters — three normalizers feeding into the common schema. ACP is the emerging LSP-for-agents standard (OpenCode, Kiro, Codex all speak it). Claude Agent SDK is special-cased because its `--output-format stream-json` and permission hooks give you the richest observation and control surface. HTTP API is for agents that expose their own server (OpenCode, OpenClaw).

Isolation layer — bubblewrap as "fancier chroot," giving each agent its own mount/PID/network/IPC/user/cgroup namespaces. Zones are real directories with bind-mounted host runtime and per-agent workspaces. The commons region holds shared substrate; transfer is `mv`, share is `ln`, snapshot is overlayfs.

Agent processes — the actual coding agents, each seeing `/` as its zone. Claude Code with permission hooks routed back to the RTS, OpenCode via ACP or HTTP (optionally with its TUI coexisting), any other ACP-speaking agent.

Host platform and substrate — Linux/WSL2 natively, macOS via Linux VM (OrbStack or Apple's `container` CLI) with VirtioFS for file-handoff back to the Mac host. Below that, the real filesystem and external services the agents actually operate on.

Dashed lines mark the isolation boundaries — agents don't see the host directly; they see what bubblewrap mounts into their zone.

A few things worth noting about what's not explicit in the diagram but is implied by it:

This is the full picture we've built across the conversation. Each block has a design rationale rooted in earlier turns — the NATO symbology choice enables the low-mark-count assumption that makes VegaFusion viable; the no-fog-of-war choice justifies full observability across every layer; the zones-as-filesystem choice collapses the permission model into kernel-enforced isolation; the Plan 9 influence shows up in the `/control/` file protocol; the Urbit influence shows up in the event log as source of truth.

Want me to produce a second diagram zoomed into any one layer (the adapter internals, the chroot zone structure, the event flow for a single tool call), or a sequence diagram showing what happens when an operator issues a zone-transfer command end-to-end?

1. Data flow is mostly downward for commands, upward for events. Operator issues a zone op → dispatcher → filesystem operation in the isolation layer → agent sees the change on its next tool call. Agent emits a tool call → adapter normalizes it → event log → VegaFusion → rendered as an edge on the map.
2. The adapter layer is the narrow waist. Every agent framework produces slightly different events; they all normalize to (agent_id, verb, object, timestamp, metadata). Adding a new agent type is writing an adapter, not changing anything else.
3. The event log is the source of truth. World state is a cache derived from it. Crash recovery is replay. Time-scrubbing is reading earlier log positions. Arrow tables are an index, not a database.
4. Policy lives as files inside each zone. The RTS reads and writes /control/policy in each chroot. Agents read their own policy to know their scope. Changes propagate live without restart.

