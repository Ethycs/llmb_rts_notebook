---
turn_id: 027
merged_turn_id: 018
role: assistant
phase: 03-hypergraph-observability
source_lines: [1565, 1738]
source_sha256: f6debe3937a9ffe93fedf17d7a1b3234353b0d3842b25ea7e7380645b544dbe2
char_count: 18503
---



## Assistant

Now I have enough to answer properly. The picture is much better than you might realize — there's a real standard emerging, and these three agents are all integrable, just with different amounts of effort.

Yes. All three are runnable from your RTS, and crucially: two of them (OpenCode and Claude Code) have first-class programmatic interfaces that give you exactly the hooks you need — streaming tool-call events, permission gates, session control. OpenClaw is a different beast but also integrable via the same mechanism. There's an emerging standard — ACP, the Agent Client Protocol — that most of these tools now speak, which is the cleanest target.

The tooling landscape has converged a lot in the last year, and you'd be building at a good moment. Let me walk through each.

This is the one with the cleanest, most complete integration surface. The Claude Code CLI has been generalized into the Claude Agent SDK, which is a standalone package giving you programmatic control over tools, permissions, cost limits, and output — you don't need the Claude Code CLI installed to use it Claude API Docs. What you get:

Translation for your RTS: you can see every `Read`, `Edit`, `Write`, `Bash` call before it runs, decide whether to approve it, and see the result after. That's a complete control surface. Your "zone of control" becomes a permission policy applied at the hook layer: agent A tries to edit a file outside its zone → the hook rejects → the operator sees a "blocked" event on the map and can choose to approve or deny interactively.

OpenCode runs a JS HTTP server as its core, with the Golang TUI as just one client that talks to it over HTTP. Thanks to Opencode's client/server design, any client (a mobile app, web app, script, etc) can send HTTP requests to create a session and start hacking away. Moncef Abboud This is essentially ideal architecture for your RTS — the TUI is optional; you can be the client.

You get:

Translation for your RTS: you spawn OpenCode either as an HTTP server and poke it via its API, or as an ACP subprocess and speak JSON-RPC to it over stdio. Either way, you get a full event stream and command surface. The HTTP mode is probably what you want for the RTS because it lets you attach/detach and have multiple viewers.

This is the different beast. OpenClaw isn't itself a coding agent — it's a personal AI assistant framework with 50+ integrations (WhatsApp, Telegram, Discord, Slack, Gmail, GitHub, etc.), able to browse the web, fill forms, read/write files, and run shell commands Openclaw. It's the orchestration layer, not the coder.

Importantly, OpenClaw has a skill that delegates coding tasks to Codex, Claude Code, or Pi agents via background process — Claude Code uses `--print --permission-mode bypassPermissions` (no PTY), while Codex/Pi/OpenCode require `pty:true` GitHub. So OpenClaw is already spawning the others as subprocesses, which means if you can integrate with OpenClaw as a control plane, you effectively inherit its integrations.

Also notable: the openclaw org maintains `acpx`, a headless CLI client for stateful Agent Client Protocol (ACP) sessions GitHub, which suggests OpenClaw is already ACP-aware on the client side.

Translation for your RTS: OpenClaw is a candidate for one of two roles — either (a) another type of agent your RTS can monitor and command (alongside Claude Code and OpenCode), or (b) an orchestration layer under your RTS that handles the messy multi-channel integration stuff so your RTS only has to speak to OpenClaw. I'd lean toward (a) for v1 because it keeps your architecture cleaner, but (b) becomes attractive once you want Slack/Discord/WhatsApp inputs.

This is the interesting piece of news. The Agent Client Protocol (ACP) standardizes communication between code editors/IDEs and coding agents, suitable for both local and remote scenarios, and the protocol re-uses JSON representations from MCP where possible while including custom types for agentic coding UX like displaying diffs Agentclientprotocol. It's JSON-RPC 2.0 over stdio pipes, with symmetric bidirectional communication — both agent and client can initiate requests and must handle requests from the other side DeepWiki.

Who speaks it:

What this means for you: ACP is essentially LSP-for-coding-agents, and it's the right target for the RTS's agent integration layer. Build an ACP client in your RTS (Rust crate exists, or you can implement JSON-RPC 2.0 over stdio directly — it's simple). Any ACP agent now works with your RTS without custom integration. That's a huge win.

Claude Code isn't native ACP but has such a rich `--output-format stream-json` interface that you can write an ACP adapter for it in an afternoon, or just treat it as a separate integration path.

Given all of the above, here's the shape:

Three adapters for v1: ACP (covers the long tail of standard-compliant agents), Claude Code stream-json (special-cased because it's the most capable/popular), and OpenCode HTTP (the richest control surface of any single agent). OpenClaw via its ACP client path, or via its HTTP/IPC interface, slots in as either a fourth adapter or is handled through ACP.

The nice property: the adapters all normalize into the same event schema — `(agent_id, event_type, object, metadata, timestamp)` — so the rest of the RTS doesn't care which flavor of agent it's talking to. A `Read` tool call from Claude Code and a `read_file` method call from OpenCode both become the same edge in your graph.

Concretely, what your operator can do once this is wired up:

Observability (all three agents): see every tool call as an edge appearing on the map in real time. Agent reads a file → edge from agent to file node, with the verb. Agent writes → edge with "write" semantics, file node state changes. Completed tasks, token counts, cost, all visible.

Permission gates (Claude Code and OpenCode specifically): intercept tool calls before execution. "Agent A just tried to edit `config/prod.yaml`, which is outside its zone — approve/deny?" pops up on the map. This is your control surface made real. Claude Code's hook API and OpenCode's permission prompts both support this; it's the mechanism that turns your RTS from observability to control.

Message injection (Claude Code SDK, OpenCode via API, ACP via prompt method): type a message to a running agent. "Focus on the tests next" as an operator interrupt. All three agent types support this through their respective APIs.

Session control: pause, resume, cancel, restart. All supported through the SDKs + OS signals as a fallback.

Multi-agent orchestration: spawn multiple agents, each in their own zone, watch them work in parallel, transfer files between zones, etc. The zone-of-control model from our previous turn maps cleanly onto "which directories/files is this agent's permission policy allowing?"

Claude Code's bypassPermissions mode matters. If you're intercepting permissions in your RTS, you want the agent to not ask itself first — you want all decisions to flow through your hooks. The `--permission-mode` flag controls this; you'd typically run agents with permission handling delegated entirely to your RTS.

OpenCode's client/server split is genuinely useful. You can have the OpenCode server running, connect your RTS to it as one client, and simultaneously have the operator using the native TUI for detailed work. They're both clients of the same session. That's a nice "RTS as one of many views" story.

ACP is bidirectional. The client (your RTS) can send requests to the agent, and the agent can send requests to the client (e.g., "I want to write this file, permission?"). This symmetric model is exactly what you need for zone-of-control enforcement — the agent asks the RTS, the RTS consults zone policy, the RTS replies.

PTY vs non-PTY matters for some agents. As noted, Claude Code uses `--print --permission-mode bypassPermissions` without PTY, while Codex/Pi/OpenCode require `pty:true` GitHub. For agents that require a PTY, you either wrap them in `expect`-style interaction or use ACP mode (if available) to skip the TUI layer entirely.

OpenClaw's role is architecturally ambiguous for your tool. It's both an agent (it does things) and an orchestrator (it spawns other agents). You may decide the RTS replaces OpenClaw's orchestration role entirely, or you may decide OpenClaw is useful as an inbound-message adapter (so "Slack message to @bot" becomes an RTS event) while the RTS owns the map and control. Either is valid; I'd defer the decision until after v1.

Mostly it holds, but a few refinements:

Given the SDK reality, the spike becomes much more targeted. Two weeks, with a real shippable result:

Week 1: Claude Code integration end-to-end.

Week 2: ACP adapter.

At the end of two weeks, you have a working RTS that can host Claude Code and any ACP-compatible agent, with a real zone-policy mechanism, live tool-call visualization, and OS-level handoff for object inspection. That's not a demo; that's a tool you could actually use.

A year or two ago, this project would have required inventing the integration layer for each agent. The landscape has shifted: Claude Code has a real SDK with real hooks, OpenCode has an HTTP API with generated clients, ACP is emerging as a LSP-like standard, and the ecosystem is converging on JSON-RPC-over-stdio with well-specified event schemas.

You're building a command surface over a now-standardizing substrate, not inventing an integration layer. That's a much better project to be starting.

The order I'd actually target:

Decisions worth making before week 1:

Want to drill into the ACP adapter implementation sketch, the Claude Code hook policy design, the event normalization schema, or the multi-agent session orchestration layer?

```javascript
┌──────────────────────────────────────────────────────────────┐
│ RTS Core (Rust)                                              │
│  - World state (Arrow tables)                                │
│  - Zone/membership/edge data model                           │
│  - Map renderer, command dispatcher                          │
└───────────────────────────┬──────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
┌────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│ ACP Adapter    │ │ Claude Code     │ │ HTTP API Adapter    │
│ (generic)      │ │ stream-json     │ │ (OpenCode direct)   │
│                │ │ Adapter         │ │                     │
│ - JSON-RPC     │ │                 │ │ - Generated SDK     │
│   over stdio   │ │ - Spawn via     │ │   client            │
│ - Session      │ │   wrapper       │ │ - Session/event     │
│   lifecycle    │ │ - Parse         │ │   streams           │
│ - Tool call    │ │   stream-json   │ │ - Tool/permission   │
│   events       │ │ - Hook into     │ │   events            │
│ - Permission   │ │   permission    │ │                     │
│   prompts      │ │   API           │ │                     │
└────────┬───────┘ └────────┬────────┘ └──────────┬──────────┘
         │                  │                      │
         ▼                  ▼                      ▼
┌────────────────────────────────────────────────────────────┐
│ Process supervisor                                         │
│  - Spawn agents in cgroups (Linux) with env var tagging    │
│  - Track PIDs, subprocess trees                            │
│  - Signal control (pause/resume/kill)                      │
│  - Log stream capture                                      │
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────┐
│ Actual agent processes                                     │
│  - claude CLI                                              │
│  - opencode serve / opencode acp                           │
│  - openclaw                                                │
│  - future agents that speak ACP                            │
└────────────────────────────────────────────────────────────┘
```

- Event stream: claude -p "..." --output-format stream-json --verbose --include-partial-messages gives you tokens and events as newline-delimited JSON Claude. Every tool call, result, and partial message streams out of stdout.
- Session init metadata: the system/init event reports session metadata including the model, tools, MCP servers, and loaded plugins as the first event in the stream Claude — so you know what tools the agent has available before it does anything.
- Permission hooks: the SDK allows hooks to handle permission decisions programmatically Claude API Docs — this is the load-bearing feature for your RTS, because it means you can intercept every tool call before it executes and decide whether to let it through. That's your zone-of-control enforcement mechanism.
- Rich lifecycle events: the agent loop yields SystemMessage init, AssistantMessage with text and tool call blocks, UserMessage after each tool execution with tool results, and StreamEvent for partial messages — five types covering the full agent loop lifecycle Claude API Docs.

- HTTP API via opencode serve, with OpenAPI/Stainless-generated SDK for type-safe extensibility Moncef Abboud.
- A JS/TS SDK (@opencode-ai/sdk) exposing all server APIs through a type-safe client, with the ability to connect to an already-running instance via createOpencodeClient opencode.
- ACP mode: opencode has an ACP subcommand that starts an Agent Client Protocol server communicating via stdin/stdout using nd-JSON opencode. This is the same protocol Zed, Kiro, and others speak.

- OpenCode (native, via opencode acp)
- Kiro CLI
- Zed editor (as client)
- Codex has an ACP bridge (codex-acp)
- JetBrains supports it
- Neovim has clients

1. The tracing layer becomes simpler. Instead of needing eBPF/fanotify for attribution (those are still useful as defense-in-depth), the primary signal source is the agent's own event stream. When Claude Code says "I called the Edit tool on foo.py," that's authoritative attribution — no kernel tracing needed. Kernel tracing catches shell-outs and subprocess escapes, which matters for completeness but is no longer the primary mechanism. Approach 1 from my previous message (framework-level instrumentation) gets you to ~95% coverage for these agents, and eBPF is an optional layer for the remaining 5%.
2. The command surface is real, not aspirational. Permission hooks + message injection + signal control means the RTS can genuinely command agents, not just watch them. Every concern I had about "commands being advisory" was wrong for this class of agent — they have proper control APIs.
3. Zone of control becomes a permission policy. An agent's zone = the set of paths its permission hook will approve for write operations, plus the set of services it can call. This is a policy object you maintain in the RTS, applied at the hook layer. Transfer = reassign a path from one agent's policy to another's. Share = add a path to both policies. Dead simple, because the policy is applied at the exact moment of intent (tool call), not post-hoc.
4. "Click to open with" still works. Objects (files) open in the user's preferred editor via xdg-open. Agents' log streams open in a terminal drawer or an inline panel. Nothing in the SDK integration changes the host-OS handoff story.

- Rust RTS binary spawns claude -p "..." --output-format stream-json --verbose --include-partial-messages as a subprocess, parses the event stream, builds the object/edge/zone tables.
- Permission hook via the SDK's hook mechanism — every tool call goes through your RTS, which applies a zone policy (for v1: "yes to anything in the configured directory, no otherwise").
- Simple web frontend: agent's zone as a box, files in the zone as rects, tool calls as flashing edges. Click an agent → log drawer. Click a file → xdg-open.

- Rust crate for ACP client (JSON-RPC 2.0 over stdio).
- Spawn opencode acp as a subprocess, establish an ACP session, consume session/update notifications as events.
- Verify the same RTS UI works without modification for OpenCode via ACP.
- Test with one other ACP-compatible agent (Kiro, or Codex via codex-acp) to validate genericity.

1. Hook latency matters. Every tool call in Claude Code waits for your hook to respond. If the RTS is slow, the agent is slow. Target sub-10ms hook decisions for the policy layer (cached policy lookups, nothing chatty with the UI).
2. Event volume at real agent speeds. A Claude Code session running full-tilt can emit hundreds of stream events per second (token deltas, tool calls, results). You want aggregation at the ingest layer — render tool calls as edges, but smooth the token-delta noise into a "thinking..." status rather than a per-event update.
3. Model coupling in event shapes. Different agents have different tool names, different permission semantics, slightly different event types. The normalization layer (mapping each agent's events into your canonical schema) is where compatibility bugs will live. Expect to iterate on it.
4. Authentication state per agent. Each agent has its own auth (Anthropic API key, OpenAI key, etc.). The RTS is the launcher, so it needs to plumb secrets through. Env-var passthrough is the simplest path; a proper secret store is a later polish.
5. OpenClaw is a moving target. It's under active development and the skill/integration story is changing. Lock to a version and be prepared to revalidate periodically.

1. Claude Code first (best docs, richest hooks, largest user base).
2. ACP-via-OpenCode second (validates the generic adapter).
3. Extend ACP coverage (Codex via codex-acp, Kiro, etc.) — near-zero marginal cost once adapter works.
4. OpenClaw last — decide whether it's agent-as-peer or orchestrator-below based on what you've learned.

- Host OS: Linux-first given cgroups/eBPF strength and the Windows-WSL2 note for OpenClaw?
- Agent auth: env-var passthrough or integrated secret handling?
- Hook policy schema: static config file per zone, or a live policy object you can edit at runtime?
- Do you want the TUI-clients coexisting? I.e., can someone have OpenCode's TUI open and be observing it in your RTS simultaneously? (The client/server architecture allows this; you just need to decide whether it's a feature or a complication.)

