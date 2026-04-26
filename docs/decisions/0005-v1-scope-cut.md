# 0005. V1 scope reduction: cut 3D/VR, macOS, SSH, MCP, bubblewrap, live policy, event sourcing, NATO, VegaFusion, magic CLI

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** SCOPE-CUT

## Context

Across the prior chapters the architecture had accumulated genuine complexity: a chroot/bubblewrap/namespace ladder, Vega and VegaFusion as the rendering substrate, NATO symbology via milsymbol, ACP/Claude SDK/HTTP adapters for multi-framework support, an SSH transport layer, per-zone MCP servers with a proxy, an event log as source of truth, a 3D/VR projection of the map, multi-platform packaging, a Plan-9-flavored magic CLI. Every item earned its place in some imagined version of the product, but a V1 that tried to ship all of them would ship nothing.

The forcing question was "what is the simplest credible V1 that tests the core hypothesis, and that the full architecture can grow into without repainting?" The hypothesis itself is qualitative: an RTS-style operator interface for multiple coding agents in bounded zones produces meaningfully better oversight than tailing two terminal windows of agent logs side by side. If the simple demo does not feel useful, none of the architectural elaboration matters. If it does, V1 becomes the foundation everything else retrofits onto.

The principle behind the cuts is that V1 should prove the hypothesis with the smallest possible surface area while staying structured to grow. Every cut is a deferral, not a deletion.

## Decision

Strip V1 down to the smallest build that exercises the hypothesis. Specifically, cut the following ten items, each with one-line rationale:

- **3D / VR view.** Cut. Always a v3 feature. The hypothesis is about whether the spatial encoding works at all; 2D answers that and stereoscopic rendering does not.
- **macOS support.** Cut. Linux-only. Chroot, the agent process model, and the daemon's syscall surface all assume Linux; building a Mac launcher and packaging story doubles platform engineering for zero hypothesis value.
- **SSH and multi-host transport.** Cut. Single host, local Unix socket between CLI and daemon. Remote access is "SSH-tunnel it yourself," documented but unsupported.
- **MCP.** Cut entirely. Agents have whatever built-in tools the SDK ships with; no MCP servers, no per-zone instances from DR-0004, no proxy. MCP adds later as a new event type without invalidating anything.
- **Bubblewrap, namespaces, microVMs.** Cut. Plain `chroot()` inside a mount namespace gives the filesystem isolation the zone metaphor needs, in roughly 150 lines of Rust around the syscalls. Bubblewrap is a user-installable dependency; namespace orchestration is a project unto itself.
- **Live policy injection.** Cut. Zone policies are static config files set at zone creation; changing a zone's policy means recreating the zone. Watched-file hot reload, DB-backed policies, and policy-as-code are v2.
- **Event sourcing as source of truth.** Cut. SQLite is authoritative; an optional JSONL audit log sits beside it. No projection from events, no replay-as-recovery. The event-log-as-truth model is preserved as a design aspiration via the stable schema, not as V1 code.
- **NATO symbology / milsymbol.** Cut. The categorical visual vocabulary is still the right answer aesthetically, but milsymbol is one more dependency and a styling exercise that does not affect whether the metaphor works. V1 ships with simple colored shapes.
- **VegaFusion / Vega.** Cut entirely. V1's data volumes (tens of agents, thousands of events) do not need a column-store dataflow engine. A plain frontend reading directly from a websocket is fine.
- **Magic CLI tooling.** Cut. No prefix-launcher, no preexec hook, no shell integration, no SDK skill. Just three subcommands talking to the daemon over a Unix socket.

What survives is five components: a Rust daemon, a frontend, a three-command CLI, a single SQLite file, and a per-agent SDK wrapper subprocess. Each does one thing, each is replaceable later without invalidating the others.

## Consequences

- **Positive:** V1 becomes shippable in roughly three weeks of focused work rather than three months. The hypothesis test gets exercised end-to-end with real agents on real workloads. The build stays opinionated and coherent rather than a half-built tour of every prior idea. The five components have clean seams, so each cut item can be added later as an additive change rather than a retrofit.
- **Negative / cost:** No cross-host story until a future chapter. No second agent framework, no MCP-provided tools, no rich symbolic vocabulary, no live policy edits, no event-replay recovery, no 3D, no Mac packaging. macOS users wait for v2 or run a Linux VM. Several of these features will need to return: MCP comes back in chapter 06 as the extension/kernel transport (different role); SSH and macOS get absorbed by VS Code Remote-SSH in chapter 06; NATO symbology and Vega return as later UX/scale passes; event sourcing flips on once the schema is load-bearing for replay/branching.
- **Follow-ups:** The structural decisions that survive must be done right even in the simple build, because they are expensive to retrofit: stable event schema with `(id, agent_id, zone_id, timestamp, event_type, payload_json)`; daemon-as-server (CLI never reads SQLite directly); zones as first-class entities, not just chroot directories; tool calls as events not as state; permission decisions as recorded events. These constraints feed into DR-0006 (frontend reframe) and the chapter 06 pivot to VS Code as the host platform.

## Alternatives considered

- **Ship the full pre-V1 architecture.** Rejected. Months of work across chroot ladder, MCP placement, NATO symbology, VegaFusion, multiple integrations, 3D/VR, macOS packaging, SSH transport, and a magic CLI — with no shipping path and no validated hypothesis at the end of it.
- **Cut only the visibly expensive items (3D, macOS, multi-host) and keep the rest.** Rejected. The remaining surface (MCP plumbing, bubblewrap dependency, live policy engine, event sourcing infrastructure, Vega substrate, NATO symbology, magic CLI) is still months of work that does not move the hypothesis. The discipline only pays off if the cut is sharp.
- **Build the full vision behind a feature-flag scaffold.** Rejected as premature abstraction. Hardcode Claude Code, hardcode chroot, hardcode the simple map; generality comes later with concrete information about what needs to vary.

## Source

- **Source merged turn:** 036
- **Raw sub-turns:**
  - [turn-048-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-048-assistant.md) — V1 cut catalogue, three-week build plan, hypothesis statement
  - [00-overview.md](../../_ingest/raw/phase-05-v1-scope-reduction/00-overview.md) — phase manifest
- **Dev guide:** [chapter 05](../dev-guide/05-v1-scope-reduction.md)
