---
turn_id: 046
merged_turn_id: 034
role: assistant
phase: 04-isolation-and-mcp-placement
source_lines: [3327, 3690]
source_sha256: ff6402519c3dc24b1dcabc49de7c48a00796b73f28d9310b08210ea96e104d4e
char_count: 23180
---



## Assistant

Good addition, and it changes the architecture in subtle ways that are worth working through carefully — because MCP and zones interact in some non-obvious ways. Specifically: MCP's whole point is to be a uniform interface that an agent uses to access tools and data sources, and a zone's whole point is to bound what an agent can access. These are in productive tension. The way you resolve it shapes the tool's whole capability story.

Let me work through it.

MCP is JSON-RPC over a transport (stdio for local, HTTP/SSE for remote), where servers expose tools, resources, and prompts to clients. From your architecture's perspective, the relevant facts:

For your zones model, the question becomes: where do MCP servers live, and who do they serve?

There are several plausible architectures and they each have different properties. Let me walk them.

Each zone runs its own copy of each MCP server. Agent in zone alpha has alpha's filesystem MCP server (configured to serve only alpha's workspace), alpha's git MCP server (configured for alpha's repos), alpha's database MCP server (with credentials only for alpha-allowed DBs), etc.

Pros:

Cons:

This is the cleanest model and probably the right default. Most MCP servers are cheap and stateless enough that the resource cost is negligible.

A single set of MCP servers run outside any zone, on the host. Each zone connects to them, but the connection is mediated through some authorization layer that constrains what each zone can see.

The MCP servers themselves enforce per-client scoping based on identity.

Pros:

Cons:

This model is theoretically nicer but practically rough. Most real MCP servers in the ecosystem aren't built for multi-tenancy, and retrofitting it is harder than running multiple instances.

The pragmatic middle. Per-zone instances for MCP servers that touch credentials, files, or zone-specific state. Shared instances for stateless or read-only utilities (a generic "fetch URL" tool, a "search docs" tool over public corpora).

This is what I'd actually recommend. Most MCP servers are zone-scoped by nature; a few are genuinely shared utilities.

The decision rule: if it would be a security or correctness problem for two zones to share this MCP server's state, give each zone its own. Otherwise share.

Independent of A/B/C, there's a separate question: are MCP servers inside the zone (visible to the agent at `localhost`) or outside the zone (visible only via a controlled bridge)?

The MCP server process runs inside the bubblewrap sandbox alongside the agent. They share `/tmp`, can talk over Unix sockets, see each other's process tree.

Pros:

Cons:

MCP server runs on the host. Agent reaches it via a Unix socket bind-mounted into the zone, or via a localhost TCP port forwarded into the zone's network namespace.

Pros:

Cons:

For most cases, inside the zone for stdio-based MCP servers, outside the zone for HTTP-based shared servers. This matches what MCP is naturally optimized for.

Concretely, what bind-mounts does each zone need for MCP?

Per-zone stdio MCP servers (Architecture A or C, inside-zone):

Shared HTTP MCP servers (Architecture C, outside-zone):

A reasonable zone layout:

The agent reads `/control/mcp.json`, which tells it where to find each MCP server. Some entries point to local stdio commands, some to Unix sockets in `/mcp/sockets/`, some to HTTP endpoints reachable through `/mcp/shared-bridge/`. The agent doesn't know or care which is which — that's the MCP abstraction at work.

Now the live policy file gets a new section. From the chroot turn, policy was:

Add MCP:

This policy:

The agent's `/control/mcp.json` is generated from this policy on zone creation/update. Live changes to the policy file regenerate the MCP config and notify the agent (which can reload its MCP connections).

Tool-level permissions matter a lot. MCP servers tend to expose broad capabilities (the GitHub MCP can probably do everything you can do on GitHub with that token); you want fine-grained control over which of those capabilities each zone uses. Allow/deny/require-approval per tool is the right granularity.

This is where MCP integration gets really powerful for the RTS. The Claude Agent SDK has permission hooks for built-in tools; MCP doesn't natively have an equivalent middleware layer. But you can build it as a transparent MCP proxy.

Pattern: instead of the agent connecting directly to the real MCP server, it connects to an RTS-controlled proxy. The proxy:

This proxy is the equivalent of the Claude Code permission hook, but for MCP. It applies uniformly to any MCP server, regardless of which agent framework is using it. That uniformity is valuable — the same permission UX for every agent type, regardless of their native hook capabilities.

The proxy's authorization decision is logged. The map can show MCP tool calls as edges (or distinct events) with their approval status. "Zone alpha called `github.list_issues` (auto-approved)" or "Zone beta requested `database.execute` (operator approved at 14:32)" — all visible in the same event stream as filesystem operations.

Building this proxy is genuinely worthwhile. It generalizes the permission control story from "Claude Code-specific hooks" to "any MCP-using agent gets the same control surface." Cost: implementing JSON-RPC proxy semantics correctly, which is small but not trivial (handles streaming, errors, capability negotiation).

Last turn we made SSH a first-class transport. MCP composes with this surprisingly cleanly:

Remote MCP servers via SSH stdio: an MCP server on a remote host can be invoked as `ssh remote-host mcp-server-foo`. The agent's MCP client sees a normal stdio transport; SSH is the network layer. This is genuinely elegant — your remote shared MCP services are just SSH commands.

SSH-tunneled HTTP MCP: if you have shared MCP services on a remote host using HTTP transport, SSH port forwarding gives you secure access without exposing the services on the network.

Cross-host agents with local MCP: agent runs on remote host, its local stdio MCP servers run on the same remote host (cheap, local). The agent's RTS connection comes back over SSH. MCP services don't need to be exposed externally.

The natural pattern: MCP servers live near the agents that use them; SSH connects agents and operators to wherever they are. This avoids putting MCP services on the network unnecessarily, which is a security win (most MCP servers are not designed to be hardened for public exposure).

Here's an angle worth considering: the operator should also have MCP access to the RTS itself. The operator's primary interface is "type messages to agents and watch the map," but a parallel useful interface is "I have my own LLM (Claude in chat, locally-run model, whatever) and I'd like to ask it to summarize what's happening across the agents."

Build an MCP server that exposes the RTS's state as MCP tools and resources:

The operator's chat client (Claude.ai, ChatGPT, etc., if it supports MCP) connects to the RTS-MCP server. Now the operator can:

This makes the RTS self-describing in the MCP ecosystem and gives the operator a meta-LLM layer for managing the agents underneath. It's a meta-agent: an LLM whose tools are the RTS's commands. The operator doesn't have to build this — they get it by pointing their chat client at your MCP server.

That's a real product feature, and it falls out of MCP integration almost for free.

From the earlier turn about graphs: every agent's interactions are edges. With MCP, the edges get richer typing:

The MCP layer gives you semantic categorization of edges. A filesystem read via MCP filesystem server is genuinely different from an `Edit` tool call from Claude Code's built-in tools, even if both modify the same file — different audit trails, different approval flows, different policy. Your event schema should distinguish them.

This actually makes the map more informative. You can render different edge styles by capability source: built-in tools get one style, filesystem MCP gets another, HTTP MCP gets another. At a glance the operator sees not just what the agent is touching, but how.

Worth being clear: MCP isn't magic. Its specific contributions to your architecture:

What MCP doesn't do:

Updating the diagram from earlier — MCP slots in as a sub-tier between agents and external resources, with the proxy as a checkpoint:

The MCP proxy is the new permanent fixture. Every MCP call goes through it; policy enforcement is there; events emit there; the operator can see, approve, and audit there.

Given the existing architecture, MCP integration roughly slots in as:

Phase 1: enable MCP for one server in one zone. Pick the simplest case — filesystem MCP server inside a zone, no proxy yet. Verify it works end-to-end with Claude Code or OpenCode.

Phase 2: build the MCP proxy. Generic JSON-RPC passthrough between agent and real server, with zone identification and event emission. No policy yet — proxy is observer-only.

Phase 3: enforce tool-level policy. Allow/deny per-tool from the policy file. Operator approval flow for `require_approval` cases. UI for approval decisions.

Phase 4: shared MCP services. Spin up host-side MCP services that multiple zones connect to via bind-mounted sockets. Establish per-zone authentication.

Phase 5: RTS-MCP server (operator-facing). Expose the RTS's state and commands as an MCP server for the operator's own LLM to use.

Phase 6: ecosystem MCP servers. Document patterns for safely importing community MCP servers (review checklist, sandboxing guidelines, common pitfalls).

This staging keeps the surface manageable. Phase 1 alone gives you "agents can use MCP," which is the table-stakes capability. Each subsequent phase adds a real new capability without invalidating the prior one.

Want to dig into the MCP proxy implementation details, the per-zone credential vaulting, the operator-facing RTS-MCP server design, or the policy schema for tool-level approvals?

```javascript
Zone alpha
├── claude-code agent
├── /var/run/mcp/filesystem.sock  ← MCP fs server, scoped to /workspace
├── /var/run/mcp/github.sock      ← MCP github server, with alpha's tokens
└── /var/run/mcp/postgres.sock    ← MCP db server, alpha's connection
```

```javascript
Host
└── MCP services (run as host services)
    ├── filesystem-mcp
    ├── github-mcp
    └── postgres-mcp

Zone alpha → connects to host MCP services with token "alpha"
Zone beta → connects to host MCP services with token "beta"
```

```javascript
Per-zone:
- filesystem (scoped to zone's workspace)
- git/github (with zone's credentials)
- database (zone's connection)
- shell/bash (running inside zone)

Shared:
- web-search (stateless)
- fetch (stateless HTTP fetcher)
- timeserver (current time)
- public-docs lookup
```

```javascript
/                         (chroot root)
├── usr/, lib/, ...       (bind-mounted host)
├── workspace/            (zone's working files)
├── shared/               (cross-zone substrate)
├── control/              (RTS-managed)
│   ├── prompt
│   ├── policy
│   ├── events
│   ├── mcp.json          ← MCP server config
│   └── credentials/      ← scoped secrets
├── mcp/                  (MCP-related)
│   ├── servers/          (per-zone MCP server processes if any)
│   ├── sockets/          (Unix sockets for MCP IPC)
│   └── shared-bridge/    (bind-mount to host's shared MCP services)
└── tmp/
```

```yaml
read: [...]
write: [...]
exec: [...]
services: { allow: [...], deny: [...] }
```

```yaml
mcp:
  servers:
    filesystem:
      type: stdio
      command: ["mcp-server-filesystem", "/workspace"]
      tools:
        read_file: allow
        write_file: allow
        list_directory: allow
        delete_file: deny       # this zone is read-mostly
    github:
      type: stdio
      command: ["mcp-server-github"]
      env:
        GITHUB_TOKEN: ${ZONE_GITHUB_TOKEN}
      tools:
        create_pr: require_approval  # operator must approve before agent can do this
        merge_pr: deny
        list_issues: allow
    web-search:
      type: shared
      url: http://host.shared.mcp:8080/web-search
      auth: ${ZONE_AUTH_TOKEN}
      tools: allow_all
    database:
      type: stdio
      command: ["mcp-server-postgres"]
      env:
        DATABASE_URL: ${ZONE_DB_RO_URL}     # read-only DSN
      tools:
        query: allow
        execute: deny                       # no DDL/DML
```

```javascript
Agent → MCP proxy (RTS-controlled) → Real MCP server
              ↓
         Event log + operator approval UI
```

```javascript
rts-mcp server tools:
- list_zones() → list of active zones
- get_zone_events(zone, since) → recent events
- agent_status(agent_id) → current activity
- send_message(agent_id, text) → inject prompt
- create_zone(spec) → new zone
- transfer_object(from, to, path) → zone op
- query_event_log(predicate) → filtered events
- get_object_state(path) → file contents, metadata, history

rts-mcp server resources:
- rts://zones/<id>/events    (live event stream)
- rts://zones/<id>/policy    (current policy file)
- rts://map/state            (full world snapshot)
```

```javascript
Within each zone:
  Agent process
       ↓ (MCP client)
  RTS MCP proxy (zone-local or zone-bridged)
       ↓ (policy enforcement)
       ├── Per-zone stdio MCP servers (in zone)
       ├── Bind-mounted Unix sockets to host MCP services
       └── SSH-tunneled remote MCP services
       ↓
  Real backends: files, services, databases, APIs

Operator:
  Chat client / IDE
       ↓ (MCP client)
  RTS-MCP server (exposes RTS state as MCP)
       ↓
  RTS world state, command dispatcher
```

- Agents (Claude Code, OpenCode, etc.) are MCP clients. They connect to MCP servers to get capabilities beyond their built-in tool set.
- MCP servers can be local subprocesses (stdio transport) or remote HTTP services (SSE/streamable HTTP transport).
- Each agent has its own MCP server configuration — typically a JSON file declaring which servers to spawn or connect to.
- An agent invokes MCP-provided tools via the same tool_use mechanism it uses for built-in tools. From the agent's perspective, MCP tools and built-in tools are interchangeable.
- MCP servers can have rich state — credentials, database connections, file handles, network sessions.

- Strong isolation by construction. Agents can't accidentally see each other's MCP-mediated state because they don't share servers.
- Per-zone credentials. Each zone's MCP servers carry the credentials appropriate for that zone. Agent alpha's GitHub MCP has alpha's GitHub token, not the operator's master token.
- Per-zone configuration. Different zones can have different MCP capability sets — an experimental zone gets the dangerous tools, a production zone doesn't.
- Crashes contained. A misbehaving MCP server affects one zone, not all of them.

- Resource cost. Each MCP server is a process; N zones × M servers = N×M processes. Most MCP servers are lightweight Node or Python, so this isn't catastrophic, but it adds up.
- No shared state. If you legitimately want two zones to share access to a resource (a memory store, a vector DB), it's awkward — you'd run yet another MCP server outside both zones and have both connect to it.
- Duplicated work. Indexing, caching, connection pooling — all per-zone.

- Resource efficient. One process per MCP server, not N.
- Shared cache and state. Indexes, caches, connection pools shared across zones.
- Centralized configuration. Update an MCP server's config once, all zones benefit.

- MCP servers need to be multi-tenant. Most aren't. The standard MCP server is single-tenant — it assumes one client with full access. Adding per-client authorization requires modifying the server or wrapping it.
- Trust concentrated. A vulnerability in a shared MCP server is a cross-zone vulnerability.
- Authorization model has to be invented. MCP's spec doesn't deeply address multi-tenant authorization; you'd be building it.

- Simple. Standard MCP stdio transport works without modification — claude spawns mcp-server-filesystem as a subprocess, it just runs.
- Server inherits zone's filesystem isolation. Filesystem MCP server can't accidentally read outside the zone because it's also inside the chroot.
- No bridge needed.

- Server runs with agent's resource limits and namespace constraints. If the server needs network access the agent doesn't have, you have a conflict.
- Restarts/crashes intertwined with agent lifecycle.

- Server runs with whatever permissions/resources it needs, independent of zone constraints.
- Server lifecycle is independent — restart MCP server without touching agent.
- Easier to share a server across zones if you want to (Architecture B).

- Need a bridge mechanism (bind-mount socket or port forward).
- If the bridge is a socket, you've punched a hole in the chroot's isolation: the server on the other end can do whatever the agent asks. Server's authority becomes the agent's authority for that capability.
- Audit and policy now has to consider both the zone's filesystem boundary and the MCP server's access scope.

- Agent's MCP config file at /control/mcp.json declaring which servers to spawn
- Server binaries available in the zone (either via bind-mounted host /usr/lib/node_modules or by copying into the zone)
- Server-specific dependencies (npm/pip packages) accessible

- Network access to the host's MCP service endpoints
- Authentication tokens for each shared service in the zone's environment or a credentials file at /control/credentials/

- Lists the MCP servers the zone can use
- For each server, declares its transport (stdio local, shared HTTP, etc.)
- Lists tool-level permissions (allow / deny / require_approval)
- Plumbs zone-scoped credentials via env vars

1. Receives the agent's tool call request
2. Looks up the policy for that zone + that tool
3. If allow: forwards to real server, returns result
4. If deny: returns an error to the agent
5. If require_approval: emits an event to the RTS map ("zone alpha wants to call github.create_pr"), waits for operator decision, then forwards or rejects

- "Summarize what's happened in zone alpha today" → operator's LLM calls get_zone_events, summarizes
- "Are any agents stuck?" → LLM queries multiple zones, reports
- "Send a message to all agents working on the auth refactor" → LLM uses send_message with policy approval

- Agent → file (filesystem MCP read) — "agent reads file via MCP fs"
- Agent → file (filesystem MCP write) — "agent writes file via MCP fs"
- Agent → service (HTTP MCP fetch) — "agent fetched URL"
- Agent → DB (database MCP query) — "agent queried database"
- Agent → MCP server itself — "agent connected/disconnected"

1. A standard tool interface for arbitrary agents. Without MCP, each agent framework has its own tool definition. With MCP, you can build a tool once and any MCP-supporting agent can use it. Adding capabilities to the whole agent fleet becomes "deploy an MCP server."
2. Capability composition. An agent's effective capability set is "built-in tools + MCP servers it's allowed to connect to." You can give zones different capability profiles by choosing which MCP servers to expose. This makes the zone abstraction richer — zones aren't just filesystem boundaries, they're capability scopes.
3. Decoupling agent framework from tool implementation. The same filesystem MCP server works for Claude Code, OpenCode, Cursor, anything else. You build tools once; agents change.
4. Operator-side MCP access to the RTS. As described above, the RTS becomes self-describing.
5. Integration with the wider MCP ecosystem. Whatever MCP servers exist publicly (and there are many), your zones can use them — with proper policy and proxy mediation.

- Doesn't replace your zone isolation. Zones still need bubblewrap-equivalent for filesystem boundaries.
- Doesn't replace your event log. MCP events flow into the same log alongside built-in tool events.
- Doesn't replace your policy engine. Policy applies to MCP tool calls the same way it applies to built-in tool calls.

1. MCP server quality varies wildly. Public MCP servers in the ecosystem range from production-grade to weekend hacks. A buggy MCP server can leak credentials, hang the agent, or produce garbage results. Audit any MCP server you let into a zone.
2. MCP servers often want broad permissions. A "filesystem" MCP server might assume access to all of ~. Constraining it via chroot is necessary; relying on the server to enforce its own scope is unsafe.
3. MCP credential sprawl. Each MCP server needs its own credentials. A zone with 10 MCP servers has 10 credentials to manage. Per-zone credential vaulting becomes important.
4. Rate limits and costs. Some MCP servers proxy paid APIs (search, LLMs, databases). A misbehaving agent in a zone can run up bills fast. Per-zone rate limiting at the MCP proxy layer is the right enforcement point.
5. Server-spawned subprocesses. A stdio MCP server running inside a chroot might spawn its own subprocesses. Those subprocesses are inside the chroot too (good) but might exceed expected resource use (bad). Cgroup limits per zone catch this.
6. MCP spec evolution. The protocol is young; capabilities are still being standardized (notification types, streaming semantics, auth flows). Expect to update your proxy as the spec evolves. Build the proxy to be permissive about unknown message types so it doesn't break on protocol additions.
7. Configuration complexity. Per-zone MCP config × per-tool policy × shared-vs-local servers × credential plumbing = lots of moving parts. Keep the policy file's MCP section as declarative and minimal as possible.

1. Default architecture choice: I'd argue Architecture C (per-zone for the dangerous, shared for the cheap), but you might prefer pure A for simplicity. C is more efficient at scale; A is more isolated.
2. MCP proxy as mandatory or opt-in? Mandatory means every MCP call is observable and policy-controlled. Opt-in means simpler v1 but creates two code paths. I'd argue mandatory — the proxy overhead is low and the uniformity is worth it.
3. Tool-level policy vs server-level policy? Server-level is simpler ("allow/deny this whole MCP server"), tool-level is more flexible ("allow some tools, deny others"). The serious answer is tool-level because MCP servers expose broad capability sets you don't want to take all-or-nothing.
4. Operator MCP access: build the RTS-MCP server in v1 or defer? I'd build it early because it gives you a powerful operator UX with minimal code, and it's how you'd dogfood the MCP layer.
5. Credential storage: per-zone env vars, mounted secrets file, integration with a real secrets manager (Vault, 1Password CLI)? Env vars for v1, document the upgrade path.
6. Public MCP server policy: do you ship with a curated list of pre-vetted servers, or leave it entirely to the operator? Personal-tool answer: operator's choice with clear warnings. Team-tool answer: curated list.
7. Per-zone vs cross-zone MCP server visibility: can zone alpha see zone beta's MCP services? Almost certainly not — that breaks isolation. But shared services in the commons should be visible to multiple zones.

