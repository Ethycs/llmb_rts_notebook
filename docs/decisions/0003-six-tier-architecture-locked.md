# 0003. Six-tier architecture diagram committed

- **Status:** Accepted (substantially superseded by DR-0005 V1 scope cut and DR-0007/0008/0009 substrate re-decision)
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

By the end of phase 03, the design conversation had accumulated three independently developed sub-models that had not yet been reconciled into a single picture:

- A *state* model (the hypergraph: agents as edge authors, multiplex layers, temporal decay), inherited from DR-0002 and worked out across turns 018–022.
- An *integration* model (three adapters: ACP, Claude Code stream-json, OpenCode HTTP), articulated in turns 023 and 027 once the SDK landscape had been surveyed.
- An *isolation* model (chroot now, bubblewrap-on-namespaces later), surfaced via the Plan 9 / Urbit detour in turns 028–031 and concretized into a primitive ladder in turn 033.

Each sub-model was internally coherent, but the seams between them were not pinned down. Where exactly does the agent's permission hook live relative to the isolation engine? Is the process supervisor part of the RTS Core or a layer beneath it? Does the operator surface talk to the world state directly or through the command dispatcher? The implementation plan ("two weeks, week 1 Claude Code, week 2 ACP") could not be sequenced honestly until those interfaces were named.

A single stack diagram was needed to make the sub-models cohere and to give the rest of the design conversation a stable vocabulary for referring to layers.

## Decision

The architecture is committed as six tiers, each with a single responsibility. Top-down:

1. **Tier 6 — Operator Surface.** Multiplex graph rendering, command input, click-to-open via host OS handoff (xdg-open). 2D primary; 3D/VR aspirational.
2. **Tier 5 — RTS Core (Rust).** Arrow-backed world state, the zone/membership/edge data model, the event log as authoritative history, the map renderer driver, and the command dispatcher.
3. **Tier 4 — Agent Adapters.** ACP, Claude Code stream-json, OpenCode HTTP. All normalize to the canonical `(agent_id, verb, object, metadata, timestamp)` event schema; the rest of the architecture is adapter-agnostic.
4. **Tier 3 — Process Supervisor.** Spawns agents, tracks PIDs and subprocess trees, captures stdio and log streams, exposes signal control (pause/resume/cancel/kill), and tags agents with cgroups on Linux.
5. **Tier 2 — Isolation Engine.** Per-agent zone as a filesystem root (chroot today, bubblewrap/namespaces tomorrow), bind-mounts of host runtime read-only, control files (`/control/prompt`, `/control/policy`, `/control/events`), zone ops as filesystem ops.
6. **Tier 1 — Agent Processes.** The actual coding-agent CLIs (claude, opencode serve, opencode acp, openclaw, any future ACP-compliant agent) running inside their zones.

The full ASCII stack diagram and the detailed top-down/bottom-up event walks live in [chapter 03](../dev-guide/03-hypergraph-observability.md) and are not reproduced here.

## Consequences

- **Positive — shared vocabulary.** The tier numbers became a shorthand for the rest of the design conversation. "Tier 4 normalization", "Tier 2 upgrade path", "Tier 6 re-host" were all subsequently used as load-bearing phrases. The diagram earned its keep as a thinking artifact even where it did not survive as an implementation plan.
- **Positive — explicit cross-tier interfaces.** The diagram forced the question of what crosses each boundary. The canonical event schema between Tiers 4 and 5, the permission hook callback between Tiers 4 and 5, the filesystem-as-control-surface between Tiers 2 and 1 — each became a named contract rather than an implicit assumption.
- **Positive — single-responsibility per tier.** Each tier ended up with one job. Process lifecycle is not mixed with isolation; isolation is not mixed with adapter normalization; adapters are not mixed with state. This makes each tier independently replaceable, which turned out to matter.
- **Negative — completeness pressure.** The tiered model encouraged "design every tier before shipping anything." Most of Tiers 1–4 turned out to be overkill for V1 and were cut in DR-0005: bubblewrap collapsed back to chroot or simpler, the three-adapter strategy collapsed to a single Claude Code integration, the bespoke supervisor became thinner.
- **Negative — wrong scope for V1.** The locked architecture was a high-water mark, not a shipping plan. Reading the phase-03 transcript, the two-week sequencing was already optimistic; the V1 contraction in DR-0005 effectively conceded that the locked stack was the right shape for *eventually* and the wrong shape for *first*.
- **Survives in spirit.** The layering principle — a renderer above a state core above an adapter layer above process and isolation primitives — outlives the specific tier contents. Tiers 4 and 5 in particular survive the V1 cut and the VS Code re-host: there is still a normalization boundary, and there is still a state core that owns the event log.
- **Follow-ups:** DR-0005 (V1 scope cut, which removes most of Tiers 1–4 and 6 from the shipping plan), DR-0007 (VS Code as host, which re-decides Tier 6), DR-0008 (bidirectional MCP, which re-decides what Tier 4 is for), DR-0011 (subtractive fork, which carves Tiers 5–6 down further inside the chosen host).

## Alternatives considered

- **Flat module list (no tiering).** Rejected. Cross-cutting concerns — event flow, state ownership, who calls whom on a permission decision — were precisely the things the conversation kept getting confused about. A flat list does not name the boundaries those concerns cross.
- **Three-tier (UI / Core / Agents).** Considered and rejected as too coarse. The adapter layer and the isolation layer are the load-bearing complexity of the system; collapsing them into "Core" or "Agents" hides exactly the work that needs doing. The three-tier picture is what an architecture review would draw at the end; the six-tier picture is what the implementer needs.
- **Microservices / network-segregated services.** Wrong tool. The system is a single-host operator console for one user driving local agents. Network overhead, service-discovery, and deployment topology would dominate a problem that does not need them.
- **Container-per-tier (Docker/Podman).** Considered as part of the isolation ladder discussion in turn 033 and rejected at that level: containers solve image distribution and orchestration problems the project does not have. Bubblewrap-on-namespaces gives the isolation properties without the container-runtime baggage. (The whole isolation tier was further simplified in V1 anyway.)

## Source

- **Source merged turn:** 028 (architecture coalesced across raw turns 018–028 in phase 03)
- **Raw sub-turns:**
  - [`turn-023-assistant.md`](../../_ingest/raw/phase-03-hypergraph-observability/turn-023-assistant.md) — agent integration landscape, three-adapter strategy, first-cut tier diagram with RTS Core on top
  - [`turn-027-assistant.md`](../../_ingest/raw/phase-03-hypergraph-observability/turn-027-assistant.md) — consolidated SDK / adapter writeup with the canonical RTS-Core-on-top tier diagram
  - [`turn-031-assistant.md`](../../_ingest/raw/phase-03-hypergraph-observability/turn-031-assistant.md) — chroot as the boring-and-correct simplification of the Plan 9 namespace direction; Tier 2 commits
  - [`turn-033-assistant.md`](../../_ingest/raw/phase-03-hypergraph-observability/turn-033-assistant.md) — isolation primitive ladder up to bubblewrap; Tier 2 upgrade path
- **Dev guide:** [chapter 03 — Hypergraph observability architecture](../dev-guide/03-hypergraph-observability.md)
