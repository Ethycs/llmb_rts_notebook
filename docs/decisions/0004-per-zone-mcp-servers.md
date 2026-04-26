# 0004. Per-zone MCP server instances chosen over host-shared servers

- **Status:** Accepted (V1 cuts MCP-as-integration-layer per DR-0005; MCP returns in different role per DR-0008)
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

In phase 04, MCP was treated as the load-bearing integration tier between agents and everything beyond their built-in tools — filesystems, git/GitHub, databases, web fetch, search, and so on. Agents are MCP clients; MCP servers are processes that expose tools, resources, and prompts; the transport is stdio for local servers and HTTP/SSE for remote ones.

The placement question had two axes:

- **Instance multiplicity:** one shared set of servers vs one set per zone.
- **Locality:** server runs inside the zone (subprocess of the agent, inheriting the chroot) vs outside the zone (reachable via a bind-mounted Unix socket or a port forwarded into the zone's network namespace).

Zones are filesystems with the agent's directory as `/`. The whole point of the zone abstraction is to bound what an agent can access. MCP's whole point is to be a uniform interface for accessing things. Where the MCP servers live decides whether the zone boundary survives that uniformity, or whether MCP becomes a tunnel under the boundary.

Seven plausible placement options were enumerated and worked through (see the dev guide chapter and turn-046 for the full trade-off discussion). The decision had to settle the default for agent-facing MCP and leave a reasonable fallback for tools where statelessness is structural.

## Decision

**Per-zone MCP server instances by default (option 1), with a small "commons" of shared servers (option 4) reserved for cheap stateless tools.**

Each zone gets its own copies of the MCP servers it uses. They run as stdio subprocesses of the agent inside the chroot. Each per-zone server holds the credentials appropriate for that zone (alpha's GitHub token, alpha's database DSN, alpha's filesystem root) and has a lifecycle tied to the zone.

The commons is an explicit fallback, not a default: it exists only for servers where shared state is genuinely beneficial and isolation is genuinely irrelevant — public-doc search indexes, generic URL fetchers, time services. The decision rule is: if it would be a security or correctness problem for two zones to share this server's state, give each zone its own; otherwise the commons is allowed.

Tool-level policy (`allow` / `deny` / `require_approval`) is the granularity, declared in each zone's `control/policy` and compiled into `control/mcp.json`. Live policy edits regenerate the config and the agent reloads its MCP connections.

## Consequences

- **Positive: isolation by construction.** Two zones cannot accidentally see each other's MCP-mediated state because they do not share servers. No multi-tenancy code in the MCP server is required — the ecosystem is overwhelmingly single-tenant, and running N copies costs less developer effort than auditing one server for multi-tenant correctness.
- **Positive: per-zone credentials.** Each zone's MCP server holds the credentials appropriate for that zone. Compromise of an agent in one zone does not yield credentials for another zone.
- **Positive: per-zone capability scoping.** An experimental zone gets the dangerous tools; a production zone does not. The capability set of a zone is a function of its policy, not a function of which servers happen to be running on the host.
- **Positive: crash containment.** A misbehaving MCP server affects one zone, not all of them.
- **Positive: standard transport just works.** stdio MCP inside the chroot is exactly what the spec is designed for. The agent spawns the server as a subprocess, the server inherits the chroot, both talk JSON-RPC over stdin/stdout. No bridge needed.
- **Negative: process count.** N zones x M servers means more processes to manage. Most MCP servers are cheap Node or Python, so the overhead is real but not catastrophic.
- **Negative: duplicated work.** Indexing, caching, and connection pooling happen per-zone. Tools where this matters belong in the commons.
- **Negative: credential sprawl.** A zone with ten MCP servers has ten credentials to plumb. Per-zone credential vaulting becomes a real concern.
- **Follow-ups:**
  - DR-0005 cuts MCP-as-integration-layer from V1 entirely. The phase-04 design — per-zone MCP, the proxy as enforcement layer, the commons, ecosystem-server policy — does not ship in V1. The placement reasoning above is what the design *would* be if/when MCP returns in this role.
  - DR-0008 brings MCP back, but as the bidirectional protocol between the operator and the agent (operator hosts an MCP server exposing `clarify`, `request_approval`, `notify`; the agent calls those tools). In that role the placement question is moot — there is one operator and the surface is operator/agent, not agent/tool.

## Alternatives considered

- **Host-shared, single-tenant (option 2).** One set of MCP servers on the host, used by all zones, no per-tenant scoping. Resource-efficient and simple, but every capability any zone has, every zone has — isolation collapses through the shared servers. Rejected.
- **Host-shared, multi-tenant (option 3).** One set of MCP servers on the host, each enforcing per-client scoping based on identity. Theoretically clean. Rejected because the ecosystem is single-tenant by default and retrofitting authorization to existing servers is harder than running multiple instances; trust is also concentrated in a single shared process whose vulnerabilities cross zones.
- **Out-of-zone with controlled bridge (option 5).** MCP server runs on the host, agent reaches it via a Unix socket bind-mounted into the zone or a localhost port forwarded into its network namespace. The server runs with whatever permissions it needs independent of zone constraints. Rejected as a default because the bridge punches a hole in the chroot — the server's authority becomes the agent's authority for that capability, and audit has to consider both the zone's filesystem boundary and the server's own access scope. Retained as a building block for the commons.
- **Per-agent proxy with shared backends (option 6).** A thin per-zone proxy mediates calls to a shared set of real backends; the proxy enforces authorization, scopes calls, and emits events. Backends stay shared (efficient) but every interaction is policy-checked. Not selected as the placement default — the proxy is orthogonal to placement, and is sketched as the natural enforcement point regardless of where the real servers live. Cut from V1 along with the rest of the integration layer.
- **Operator-side MCP server (option 7).** The RTS exposes itself as an MCP server so the operator's own LLM can drive it. Not an agent-zone placement at all — a separate operator-facing surface. Lives alongside whatever placement agents use. This shape is what DR-0008 ultimately revives, repurposed as the operator/agent channel.

## Source

- **Source merged turn:** 034 (phase 04)
- **Raw sub-turns:**
  - [turn-045-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-045-user.md) - prompt to fold MCP connectivity into zones.
  - [turn-046-assistant.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-046-assistant.md) - the placement enumeration (per-zone, host-shared single/multi-tenant, hybrid, out-of-zone bridge, per-agent proxy, operator-side), in-zone vs out-of-zone transport, MCP proxy design, operator-facing RTS-MCP server. Lock-in for DR-0004 sits here.
  - [turn-047-user.md](../../_ingest/raw/phase-04-isolation-and-mcp-placement/turn-047-user.md) - the pivot to "consider the simplest build for V1" that opens the contraction in chapter 05.
- **Dev guide:** [chapter 04](../dev-guide/04-isolation-and-mcp-placement.md)
