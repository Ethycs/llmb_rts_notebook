# Chapter 04: Zone isolation primitives and MCP placement

## Purpose

This chapter captures the isolation design and the MCP server placement strategy as they stood at end of phase 04 (turns 029–035). It refines the zone-as-filesystem model from [chapter 03](03-hypergraph-observability.md), enumerates the Linux isolation primitive ladder, and lands the lock-in for where MCP servers live (DR-0004): one set of MCP servers per zone, with a thin commons reserved for cheap shared tools.

## Status

This is the **pre-V1 isolation design**. V1 ships plain chroot or simpler — most of the ladder described here is deferred or cut. See [chapter 05](05-v1-scope-reduction.md) for the contraction. Read this chapter for the conceptual frame the rest of the design refers back to (especially the zone-as-filesystem invariant and the MCP placement reasoning), not as a description of what gets built first.

The lock-in for this phase is **DR-0004**: per-zone MCP server instances as the default. The deeper ladder of isolation primitives is documented but not committed — the actual rung the project sits on is decided as a deployment-time concern, not an architecture-time one.

## Zone-as-filesystem model

The frame inherited from [chapter 03](03-hypergraph-observability.md) is that a zone is a filesystem. An agent runs with its zone directory as `/`. There is no separate "zone object" in memory above the filesystem; the directory and its contents *are* the zone.

This collapses several control problems into ordinary file operations:

- **Spawning a zone** is creating a directory and populating it (bind-mounted system, a `workspace/` for the agent's working files, a `control/` for RTS-managed surfaces).
- **Destroying a zone** is removing the directory.
- **Snapshotting** is filesystem-level (btrfs snapshot, zfs snapshot, or a copy).
- **Transferring an object between zones** is `cp`, `mv`, or `ln` between two paths on the host.
- **Inspecting a zone's state** is `ls` and `cat`.

The control surface lives inside each zone as a small set of files. The canonical layout:

```
/                         (chroot root for the zone)
├── usr/, lib/, ...       (bind-mounted host system)
├── workspace/            (zone's working files)
├── shared/               (cross-zone substrate)
├── control/              (RTS-managed)
│   ├── prompt            (operator's current prompt to the agent)
│   ├── policy            (live policy file)
│   ├── events            (append-only event log for this zone)
│   ├── mcp.json          (MCP server config, generated from policy)
│   └── credentials/      (scoped secrets)
├── mcp/                  (MCP-related)
│   ├── servers/          (per-zone MCP server processes if any)
│   ├── sockets/          (Unix sockets for MCP IPC)
│   └── shared-bridge/    (bind-mount to host's shared MCP services)
└── tmp/
```

The agent reads from and writes to these files. The RTS reads from and writes to the same files from outside the chroot. There is no API between operator and agent that is not a filesystem operation. This is the Plan 9 / `/proc`-style choice: state is files, ops are file ops, policy is a file.

Live policy edits are picked up because the agent (or a small in-zone watcher) re-reads `control/policy` on change. Live `control/prompt` edits inject new operator instructions into the agent's stream. The event log appends as the agent works. None of this requires a custom protocol; it is just files.

## The isolation primitive ladder

The zone-as-filesystem invariant is independent of *how* the filesystem boundary is enforced. The rung you choose is a deployment-time trade-off between safety, weight, and operational complexity. The phase enumerates the ladder so that "upgrade isolation" later is a matter of swapping the launcher, not redesigning the system.

**chroot.** The minimum: change the apparent filesystem root for a process. The agent sees only its zone directory. No process, network, or user-namespace separation; root inside the chroot is root on the host. Cost: essentially zero — `chroot()` is one syscall. Security: weak against a malicious or escalated agent. Promote past chroot when the agent might run untrusted code or you need to constrain side effects beyond filesystem visibility.

**pivot_root.** A stronger filesystem-root change that swaps the mount tree rather than redirecting `/`. Required inside mount namespaces; preferred over chroot once you are doing namespace-based isolation at all. No real cost over chroot once you are already setting up namespaces. Promote when you start using `unshare` so that the new root is properly anchored.

**Linux mount/PID/network namespaces (`unshare`).** The kernel primitives that compose into a sandbox. Mount namespace gives the agent its own view of mounts. PID namespace makes the agent PID 1 in a private process tree, unable to see or signal host processes. Network namespace gives the agent its own network stack — its own loopback, its own routing, no access to host interfaces unless explicitly bridged. User namespace lets "root" inside the zone be a non-privileged UID outside. Cost: mostly setup complexity; runtime overhead is small. Promote when filesystem-only isolation is not enough — when the agent should not see other processes, should not see host networks, should not be host-root even if it tries.

**bubblewrap (`bwrap`).** Flatpak's user-space wrapper around the namespace primitives. A single command that takes a long argv describing the desired isolation and execs the target. Adds: ergonomic composition of all the namespace flags, sane defaults, careful handling of bind mounts and /dev. Cost: ~5–30 ms of setup per launch (bubblewrap is unusually cheap among sandboxes); a runtime dependency. Promote here from raw `unshare` once you are tired of writing the same setup code twice. This is the sweet spot for personal-scale agent isolation.

**systemd-nspawn.** systemd's lightweight container launcher. Adds: cgroup integration, journald logging, network bridging, reboot-style lifecycle, treats the zone as a "machine" with `machinectl`. Cost: requires systemd on the host; heavier than bwrap; conventions that may not match what you want for agent zones. Promote when zones need to look like full machines (init, services, persistent identity) rather than command-launchers.

**Container runtimes (Docker, Podman).** Full container ergonomics: image layers, registries, networking with overlay drivers, volume management, an API. Cost: a daemon (Docker) or rootless-but-still-substantial setup (Podman); image build pipeline; concepts (image, container, volume, network) layered on top of the underlying namespaces. Promote when you need image distribution, when other tools in your stack already speak Docker, or when operators expect `docker ps`-style introspection. For agent zones specifically, the image-per-zone pattern is overkill — you usually want a long-lived mutable filesystem, not an immutable image.

**microVMs (Firecracker, Kata Containers).** Hardware-virtualized isolation. Each zone is a VM with its own kernel; KVM is the boundary. Cost: hundreds of MB RAM per zone minimum, multi-second boot, an entire kernel and init per agent. Security: very strong — kernel exploits do not cross the boundary. Promote when you are running genuinely untrusted code, multi-tenant isolation matters, or compliance requires hardware-level separation. For a personal RTS this is dramatically more isolation than the threat model justifies.

The ladder is *additive* in the sense that every rung includes the filesystem-isolation behavior of the rungs below it. Upgrading from chroot to bubblewrap to a microVM does not require rewriting the agent or the RTS — only the launcher.

## The default rung

The default for the project's trajectory is **chroot**, with a documented upgrade path to bubblewrap (and beyond) as needs sharpen.

Chroot is the right default because:

- The threat model is operator-trusted agents on the operator's own machine. The agent is not an adversary; it is a tool that occasionally makes mistakes. The thing chroot prevents — the agent reading or writing files outside its workspace by accident — is the thing that actually goes wrong.
- The zone-as-filesystem invariant only requires filesystem-root isolation. PID and network namespaces are nice-to-have, not load-bearing for the model.
- chroot is one syscall. There is no daemon, no image, no kernel. The launcher is a few lines of code. Failure modes are obvious.
- Every Unix has it. There is no "supported on Linux only" footnote.
- The upgrade path is mechanical. Replace `chroot()` with `bwrap --bind ... --proc ... --dev ... --unshare-pid --unshare-net ... -- agent`, and the rest of the system does not notice.

Chroot is *boring and correct* rather than insufficient. The phase explicitly resists the temptation to ship the most secure possible isolation and instead ships the simplest one consistent with the threat model, while keeping the architecture trivially upgradable.

The promotion criteria documented for the project:

- Promote to bubblewrap (or unshare) when an agent runs code from sources the operator does not vouch for, or when noisy host processes start showing up in the agent's view in ways that confuse the model.
- Promote to systemd-nspawn or a container runtime if the project gains an image-distribution story that operators demand.
- Promote to a microVM only if the product's threat model changes — for example, hosted multi-tenant deployment.

## MCP placement options

MCP is the protocol agents use to reach tools and data sources beyond their built-in tool set. From the architecture's perspective: agents are MCP clients; MCP servers are processes that expose tools, resources, and prompts; the transport is stdio (local) or HTTP/SSE (remote). The placement question is *where do the MCP servers live*, and that question has two axes — instance multiplicity (per-zone vs shared) and locality (inside the zone vs outside it).

The phase enumerated seven plausible placement options and worked through their trade-offs:

1. **Per-zone, in-zone, stdio.** Each zone runs its own copy of each MCP server as a stdio subprocess of the agent, inside the chroot. Strong isolation; per-zone credentials; crashes contained. Resource cost is N zones × M servers, but most MCP servers are cheap. No shared state — two zones cannot transparently share a cache or index.
2. **Host-shared, single-tenant.** One set of MCP servers on the host, used by all zones, with no per-tenant scoping. Resource-efficient and simple, but everything an agent can do, every other agent can do — isolation collapses through the shared servers.
3. **Host-shared, multi-tenant.** One set of MCP servers on the host, where each server enforces per-client scoping based on identity. Theoretically clean. Practically rough: most ecosystem MCP servers are not built for multi-tenancy, and retrofitting authorization is harder than running multiple instances.
4. **Hybrid (per-zone for stateful, shared for stateless).** Per-zone instances for MCP servers that touch credentials, files, or zone-specific state (filesystem, git/GitHub, database, shell). Shared instances for stateless or read-only utilities (web fetch, public docs lookup, time service). The decision rule: if it would be a security or correctness problem for two zones to share this server's state, give each zone its own; otherwise share.
5. **Out-of-zone with controlled bridge.** MCP server runs on the host, agent reaches it through a Unix socket bind-mounted into the zone or a localhost port forwarded into the zone's network namespace. Server runs with whatever permissions it needs independent of zone constraints; lifecycle is independent of the agent. The bridge is a hole in the chroot's isolation — the server's authority becomes the agent's authority for that capability.
6. **Per-agent proxy with shared backends.** A thin per-zone proxy mediates MCP calls to a shared set of real backends. The proxy enforces authorization, scopes calls, and emits events. Backends stay shared (efficient), but every agent's interaction with them is policy-checked.
7. **Operator-side MCP server (RTS exposes itself).** The RTS itself runs an MCP server that exposes zones, events, agents, and dispatch as MCP tools. The operator's own LLM (Claude.ai, a local model, etc.) connects to it. Not an agent-zone placement at all — a meta-layer that gives the operator an LLM-driven view over the whole RTS.

These are not mutually exclusive. Options 1, 4, 5, 6 are different placements for *agent-facing* MCP; option 7 is a separate operator-facing MCP surface that sits on top of whatever placement the agents use.

## MCP placement decision (DR-0004)

**Default: per-zone MCP server instances (option 1), with a small commons of shared servers (option 4) reserved for cheap stateless tools.**

The reasoning, locked in as DR-0004:

- **Isolation by construction.** Two zones cannot accidentally see each other's MCP-mediated state because they do not share servers. No multi-tenancy code in the MCP server is required — running N copies costs less developer effort than auditing one server for multi-tenant correctness.
- **Per-zone credentials.** Each zone's git/GitHub/database MCP server holds the credentials appropriate for that zone. Compromise of an agent in one zone does not yield credentials for another zone.
- **Per-zone configuration.** An experimental zone gets the dangerous tools; a production zone does not. The capability set of a zone is now a function of its policy, not a function of which servers happen to be running on the host.
- **Crash containment.** A misbehaving MCP server affects one zone, not all of them.
- **Standard transport just works.** stdio MCP inside the chroot is exactly what the spec is designed for: agent spawns server as a subprocess, server inherits the chroot, agent talks JSON-RPC over stdin/stdout. No bridge needed.

The trade-off paid is process count and lack of shared state. Both are accepted. For tools where shared state is genuinely beneficial and isolation is genuinely irrelevant — a public-doc search index, a generic URL fetcher, a clock — the commons-server model (option 4) is the explicit fallback. The commons is meant to be small and to contain only stateless or read-only utilities; anything that holds credentials or per-zone state belongs in the zone.

Tool-level policy is the right granularity. MCP servers tend to expose broad capability surfaces (the GitHub MCP can do everything its token allows); the zone's `control/policy` declares per-tool decisions: `allow`, `deny`, `require_approval`. The agent's `control/mcp.json` is generated from this policy on zone creation/update; live policy edits regenerate it.

A logical extension — **the MCP proxy** — was designed but not committed in this phase: a transparent JSON-RPC proxy between the agent and its MCP servers that applies policy uniformly across all MCP servers, regardless of which agent framework the agent is using. The proxy is the natural enforcement and audit checkpoint for tool-level policy and is the place where MCP tool calls become events on the map. It is sketched here and revisited in [chapter 06](06-vscode-notebook-substrate.md) when MCP returns in a different role.

## What carries forward, what gets cut

The cuts in [chapter 05](05-v1-scope-reduction.md) take a hard line on this phase. Roughly:

- **Carries forward.** The zone-as-filesystem invariant survives. chroot survives in spirit — the simplest isolation rung that does the job is the rung V1 sits on. The control-surface-as-files pattern (`control/prompt`, `control/policy`, `control/events`) survives. The promotion-path framing (you can upgrade the launcher without rewriting anything else) survives as a design principle even though V1 does not exercise it.
- **Cut for V1.** Bubblewrap, namespaces, systemd-nspawn, container runtimes, microVMs — none ship in V1. The MCP proxy as an enforcement layer is cut. Per-zone MCP server proliferation is cut. The shared commons is cut. SSH-as-substrate (the cross-domain bridging discussion that filled most of turn 032) is cut. The `magic` CLI sketched in turns 029–030 is cut.
- **MCP itself returns, but in a different role.** In this phase MCP is *agent integration plumbing* — the way an agent reaches tools beyond its built-ins. In [chapter 06](06-vscode-notebook-substrate.md), MCP returns as the *primary chat protocol* between the operator and the agent (DR-0008). The operator becomes an MCP server; the agent talks to the operator via MCP tool calls (`clarify`, `request_approval`, `notify`) instead of free text. The placement question (per-zone vs shared) is moot in that role because there is one operator and the protocol surface is between operator and agent, not between agent and tool.

The reader should treat this chapter as background for the conceptual model — zones are filesystems, isolation is a ladder, MCP composes with the architecture in well-understood ways — rather than as a description of what V1 builds.

## Source turns

- [turn-041-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-041-user.md) — prompt about wrapping a "magic" prefix command for OS-level control.
- [turn-042-assistant.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-042-assistant.md) — the `magic` CLI design: prefix-launcher vs activate-based, shell preexec hook, controls applicable per invocation.
- [turn-043-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-043-user.md) — prompt about SSH for cross-domain bridging.
- [turn-044-assistant.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-044-assistant.md) — SSH as substrate: cross-host transport, macOS-VM access, multi-operator authentication, `command=`-restricted authorized_keys as agent control plane.
- [turn-045-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-045-user.md) — prompt to fold MCP connectivity into zones.
- [turn-046-assistant.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-046-assistant.md) — MCP placement options (per-zone, host-shared, hybrid), in-zone vs out-of-zone transport, MCP proxy design, operator-facing RTS-MCP server. Lock-in for DR-0004.
- [turn-047-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-047-user.md) — pivot to "consider the simplest build for V1," opening the contraction in [chapter 05](05-v1-scope-reduction.md).
