---
turn_id: 074
merged_turn_id: 062
role: assistant
phase: 06-vscode-notebook-substrate
source_lines: [7067, 7358]
source_sha256: 1de7635c620e304833368c141bee80687be4f96d459d7d750da165525ab14c98
char_count: 22701
---



## Assistant

You can. And you're hitting on something important — most people use MCP as a small accessory to an agent's context, but there's no architectural reason it has to be small. MCP can carry essentially arbitrary content into the model's context window, and if you're willing to be the primary or sole MCP provider for an agent, you can effectively own the context that agent operates on.

Let me work through what this actually means, what's technically possible, what limitations exist, and what the deeper implications are. Because "take over the context window" is achievable in important senses, but it requires being precise about what you mean by "take over," because there are several distinct capabilities that get lumped together.

To reason about this, we need to be specific about what fills up a context window during an agent run:

Of these, MCP can provide content for items 3, 4, 5, and indirectly via 8 (every MCP tool call's result occupies context). That's a lot of surface area.

What MCP cannot directly control:

So MCP is most of the surface area but not all of it.

Three plausible interpretations, in order of completeness:

Interpretation 1: be the dominant content provider. Your MCP server provides so much context (resources, tool schemas, prompts) that what you contribute swamps everything else. The agent's effective context is mostly things you put there.

Interpretation 2: be the sole external context provider. The agent has no tools or resources except what you provide. No filesystem MCP, no git MCP, no anything else — just yours. You're the only window the agent has into anything beyond its system prompt and the conversation.

Interpretation 3: control what's in context dynamically. Beyond passive provision, you actively manage what's in the context window over time — injecting, evicting, summarizing, restructuring. Context becomes something you curate.

These are increasingly ambitious. Let me walk through each.

The simplest version. You build an MCP server that exposes:

When the agent starts, it sees a rich set of capabilities and a substantial corpus of accessible resources, all from your server. The framework's defaults are minor by comparison.

This is fully supported by MCP and trivially achievable. The MCP spec is explicit about resources and prompts being a significant context contribution. Anthropic's reference implementations all assume rich resource provision.

What this gets you: most of the agent's "world" is shaped by you. The operator's setup, the codebase context, the relevant docs — all flow through your server. The agent sees what you decide to expose.

What it doesn't get you: control over the system prompt, the conversation flow, or the agent's reasoning. Those still belong to the framework.

This level is achievable for v1 and gives you a lot of leverage.

Take it further: your MCP server is the only MCP server connected to the agent. No filesystem MCP, no fetch MCP, no anything else. The agent has its built-in tools (the framework's defaults like `Read`, `Edit`, `Bash`) and your MCP-provided ones, and nothing else.

This is also fully supported by MCP. It's a configuration choice — you tell the agent's framework "connect only to this MCP server" and it does.

Why this is more interesting: you're now the curator of every augmenting capability the agent has. Want to forbid network access? Don't expose a fetch tool. Want to require all file access to go through your audit layer? Provide your own filesystem tool that wraps the real filesystem. Want to give the agent capabilities the framework doesn't natively provide? Add them.

This is meaningfully more controlling than just being the dominant provider. The agent's entire extended capability surface is yours.

Catch: the framework's built-in tools still exist. Claude Code's `Read`, `Edit`, `Bash`, `Grep` etc. are baked into the agent's tool surface and aren't gated by MCP. If the framework provides them, the agent has them.

Workaround: most agent frameworks have configuration to disable built-in tools. Claude Code has `--allowedTools` and similar flags that let you whitelist tools. If you whitelist only your MCP-provided tools, you've effectively cornered the market on the agent's capabilities.

At this level, you control:

You don't control:

This is a real "take over" in any practical sense. The agent operates entirely within the world you define.

This is the most ambitious version, and it's where MCP starts to feel like a genuine context-management layer.

Resources can be served dynamically. When the agent reads a resource, your server can return whatever current content you want. The same resource URI can return different content over time, or based on agent state, or based on what the operator has just shared. You don't have to pre-commit to static content.

Resources can be added and removed at runtime. MCP supports notifications about resource list changes. Your server can announce "this resource is now available" mid-conversation, and the agent gains access to it. It can also withdraw resources.

Tool definitions can change. Same notification mechanism: tools can appear and disappear. You can give the agent specific capabilities only at specific phases of work.

Tool results can be huge. A single tool call result can be tens of thousands of tokens. If you want to inject a large body of content into the agent's context, you have the agent call a tool whose result is that content. The tool call becomes a context-injection mechanism.

Resource prefetching via subscription. MCP lets clients subscribe to resources; the server can push updates. Combined with tool results, you can have a steady stream of content flowing into the agent's context as you choose.

Sampling: MCP has a feature where the server can request the agent to do a model call, treating the agent's model as a resource. This is more niche but it's another bidirectional capability that lets you influence the agent's model usage.

Together, these mean: you can reshape what's in the agent's context dynamically as the work progresses. Not just "set up the world at startup" but "manage the world over time."

For honesty, the things MCP genuinely can't do:

You can't modify the system prompt. The framework owns that. Claude Code has its own system prompt that establishes what the agent is and how it behaves. MCP doesn't touch this.

You can't directly evict things from context. If the framework's context manager has put something in context, MCP can't tell the framework "remove that." You can advise, by providing summaries that the agent might choose to use, but you can't force eviction.

You can't intercept the agent's outputs. The agent generates a turn; the framework receives it; what happens next is up to the framework. MCP doesn't see the agent's response except as it relates to subsequent tool calls.

You can't change what the operator types. Operator inputs flow through the framework directly to the conversation history. MCP doesn't gate them.

You can't directly modify the conversation history. The framework keeps track of message turns; MCP can't rewrite them post-hoc.

You can't set per-message constraints. You can't say "for this next turn, force the agent to call a specific tool." Tool choice is determined by the model, not by MCP.

So MCP is very powerful for shaping context but it doesn't give you complete control over the conversation. There are still framework-level concerns it doesn't touch.

Practical recipe for "MCP server that swallows the agent's context":

1. Build an MCP server that exposes a rich resource graph.

Resources represent everything the agent might need to know: codebase contents, documentation, recent operator activity, conversation history summaries, current zone state, current task definition, etc. Each resource has a URI; the agent can read them on demand.

2. Provide all the tools the agent needs.

Don't rely on framework built-ins. Provide your own:

The agent's entire capability surface flows through your server.

3. Configure the agent's framework to disable built-in tools.

For Claude Code: `claude --allowedTools '<your-mcp-server>__*'` whitelisting only MCP-provided tools. The agent now has nothing except what your server gives it.

4. Curate resources at startup based on the task.

When the agent starts on a task, your server provides exactly the resources relevant to that task: the codebase files involved, the specs, the operator's notes. Not too much, not too little.

5. Update resources as work progresses.

As the agent makes changes, your server's view of the world updates — file contents change, status changes. The agent can re-read resources to see the current state.

6. Push notifications for important context changes.

When the operator shares something new, your server adds a resource and notifies the agent ("a new resource is available: operator-shared-document-3"). The agent can read it on its next turn.

7. Provide summarization and compression tools.

When context gets full, you can have a `summarize_recent_activity()` tool the agent calls to get a compressed summary of recent work, freeing up tokens. You curate what makes it into the summary.

8. Inject "memory" via resources.

Long-term memory — facts the operator has told the agent, decisions made earlier — exists as resources the agent can re-read whenever needed. You manage what goes in this memory store.

This recipe gets you to "your MCP server is the agent's entire context, dynamically managed." Achievable today, with current MCP and current agent frameworks.

Specifically, the capabilities this unlocks:

Total observability. Every tool call goes through you. Every resource read goes through you. You log everything; you understand what the agent is doing in detail far beyond what the framework's logs show.

Total auditability. The agent's behavior is fully reconstructible from your server's logs. Replay is exact.

Policy enforcement at the right layer. The agent can't do anything you don't expose. Forbidden operations don't have tools. Allowed operations have audit and approval baked in.

Context engineering as your job, not the framework's. Most agent frameworks are bad at context management. Yours can be good. You decide what's in context, how it's structured, when to compress, when to inject memory.

Cross-session memory. Conventional agents forget between sessions. Your MCP server can persist memory and re-inject it as resources at the start of new sessions. Long-running agents become possible.

Multi-agent coordination via shared resources. Multiple agents all connected to your server share access to common resources. They see each other's work via the resource layer. Coordination becomes natural.

Prompt engineering moves to the protocol level. Instead of system prompt tweaks, you adjust tool descriptions, resource summaries, prompt templates. Persistent, version-controllable, queryable.

Security boundary. The agent can only reach what you expose. If your server is the boundary, security policy is centralized.

Capability composition. Want to give the agent a new capability? Add a tool. Want to take one away? Remove it. Capability changes don't require framework configuration; they're just MCP server changes.

This is genuinely a different way to build agent systems. The agent framework becomes a thin shim around the model; your MCP server is where the actual agent system lives.

Step back: in your overall architecture, this turns the MCP server into the center of the agent system rather than a peripheral capability provider.

Previously implied architecture:

New implied architecture:

This is a substantial reframing. Your tool isn't an RTS that has agents that use MCP; your tool is an MCP-server-centered system that runs agents as one of its outputs. The agent is the "front end"; your server is the "back end" of agent cognition.

This is, structurally, where systems like LangGraph and similar are heading — except they typically build it as a Python orchestration framework. You'd build it as an MCP server, which is more interoperable and language-agnostic.

A few honest cautions:

Context bloat is still real. You can put a lot in context, but the model still has finite tokens. Putting too much hurts quality. "Take over context" doesn't mean "fill it"; it means "decide what's there." Context discipline still matters.

Tool-call latency adds up. Every interaction with your server is an MCP roundtrip. Stdio is fast but not free. Many tool calls in a turn slow down the agent.

Models still hallucinate about tool descriptions. Even with carefully designed tools, the model might call them with wrong arguments. You handle this with validation and good error messages, but it's a real failure mode.

The framework's defaults can still surprise you. Claude Code might inject things you didn't expect — workspace indices, git state summaries, etc. Read the framework's docs carefully; some of this is configurable, some isn't.

System prompt remains framework's domain. You can't fully control the agent's behavior because the system prompt sets baselines. Some frameworks let you override the system prompt; some don't.

Tool definition tokens add up. Many tools means heavy tool-definition section. Be selective; don't expose tools the agent doesn't need.

Resource subscription has model support variance. Not all model providers handle MCP notifications equally well. Push-based context updates work better in some setups than others.

Agents may not follow tool-calling discipline. If you've configured the agent to "only use these tools," the model might still try to call non-existent tools or output text that should have been a tool call. Mitigation: clear system prompt instructions, robust error handling.

These are all manageable but worth knowing. Taking over context isn't a free lunch; it's a different set of trade-offs.

Combining this with the previous turn's idea: the operator-as-MCP-server isn't just a communication channel; it can be the entire context provider.

The agent connects to your MCP server. From the server, it gets:

Within this setup, the operator is part of the context (via interaction tools), the workspace is part of the context (via resources), the task is part of the context (via prompts and resources). Everything the agent thinks about flows through your server.

The agent's "world" is your server. The agent's "operator" is a tool. The agent's "files" are resources. The agent's "memory" is your persistent storage. The agent's "task" is a prompt template. Your server is the universe.

This is the natural end state of taking the MCP-as-interface idea seriously. The operator-interaction tools are one part of a much bigger picture: you're the agent's cosmos.

Now grounding back: what does this mean for the simplest v1?

You probably can't and shouldn't build the full "take over context" architecture in v1. It's too much. But you can lay the right foundation:

v1 commitment: your MCP server is the agent's primary tool source. Operator interaction tools (from the previous turn). File operations (with audit and policy). Status reporting. That's it.

v1 doesn't include: dynamic resource management, complex memory systems, full capability replacement. Those are v2.

Critical v1 decision: configure agents to use your MCP server prominently, even if not exclusively. Disable built-in tools where you have replacements. Establish the pattern that the operator interacts via your tools, not via direct framework affordances.

v2+ direction: progressively expand the MCP server to handle more. Resources for codebase context. Memory layers. Dynamic context curation. By v3, your server is the agent's whole world.

This is the strategic version: commit to MCP-as-context-substrate as the long-term architecture, build only as much as v1 needs.

A few reasons this direction is worth committing to:

MCP is converging into standard. Anthropic, OpenAI, Google, JetBrains, VS Code, Zed, and many others are betting on MCP. Your server speaks a standard. As MCP matures, your tool benefits.

Context engineering is the central problem. As agents become more capable, what's in their context is the binding constraint. Tools that solve context engineering well will be valuable. You're betting on a real problem.

Multi-model future. Different models have different strengths. If your MCP server is the agent's context layer, you can switch models underneath. Today's Claude, tomorrow's Gemini, next year's something else — same server, different agent.

Composability. Other tools can integrate with your MCP server. The operator's IDE, the operator's chat client, third-party tools — all can speak to the same server. Standardization compounds value.

Architectural elegance. The model is clean: agents are clients of an MCP-shaped substrate. Everything important is in that substrate. The architecture is uniform.

This is a defensible long-term direction. It's also unusual in 2026 — most teams treat MCP as an accessory, not as the substrate. Treating it as substrate is a position worth holding.

Yes, you can take over the context window via MCP, in any practical sense. By being the dominant tool and resource provider, configuring the agent to use only your tools, and dynamically managing what's exposed, you become the agent's entire external world.

The system prompt and the model itself remain the framework's, but everything the agent sees beyond them can be yours. For an agent doing coding work in a zone, "everything beyond the system prompt" is essentially the whole functional surface.

This isn't a hack or a limitation push. It's MCP being used to its full potential. The protocol supports rich resource provision, dynamic updates, and complete tool replacement. Most teams just don't use it that way.

For your project, committing to this architecture means: the daemon is, fundamentally, an MCP server that happens to also have a UI. The agent is a client; the operator is another client (via the chat); other tools are also clients. Everything is unified by speaking MCP to your server.

V1 builds enough to demonstrate the pattern. V2 expands the surface. By v3, your server is the agent's world — and the agent's world is much richer than any agent framework natively provides.

Decisions to commit:

Want to dig into the specific resource schema for "agent's world," the dynamic context update protocol, the tool taxonomy for fully-replaced framework tools, or how this composes with the chat UI design from earlier turns?

1. System prompt: defines the agent's persona, constraints, and core instructions. Set by the framework (Claude Code, etc.) at startup.
2. Tool definitions: the JSON schemas of every tool the agent has access to, plus their descriptions. Token-heavy if there are many tools.
3. MCP-provided resources: content that MCP servers expose as resources, which the agent can read or that get auto-included.
4. MCP-provided tools: tool schemas from MCP servers, contributing to the tool definition count.
5. MCP-provided prompts: predefined prompt templates from MCP servers, which can be injected into the conversation.
6. User messages: anything the operator types or sends.
7. Assistant messages: the agent's own outputs from previous turns.
8. Tool calls and results: the agent invokes tools, the tool returns content, both go into context.
9. Framework-injected content: some frameworks add metadata, file mentions, environment summaries, etc.

- The system prompt (set by the framework)
- The user's own messages (the operator types those)
- The agent's own outputs (the model generates those)
- The conversation history (managed by the framework's context manager)

- Resources: documents, files, knowledge bases, prior conversation summaries, the operator's notes, the codebase index, anything textual.
- Tools: not just the operator-interaction tools from the previous turn, but also any tool the agent might want — file reading, file writing, search, status queries, etc. Your server provides them all.
- Prompts: templates for common tasks, agent personas, instruction sets.

- Every tool the agent can call
- Every resource the agent can access
- Every prompt template available

- The system prompt
- The agent's reasoning and outputs
- What the operator types

- read_file(path) — wraps real reads with audit and policy
- write_file(path, content) — same, with operator approval if needed
- search(query) — your search over your indexed content
- bash(command) — your execution layer with sandboxing and logging
- Operator-interaction tools from the previous turn

- RTS daemon manages zones, agents, etc.
- MCP servers (your operator-interaction one + others) expose capabilities to agents
- Agent frameworks orchestrate the agents and their conversations

- RTS daemon hosts a primary MCP server that is the agent's entire context layer
- Other MCP servers might exist but are subordinate
- The agent framework is reduced to "spawn a model with this MCP connection and a system prompt"
- Everything important happens in the MCP server

- Resources representing the workspace, the task, the operator's notes
- Tools for everything: file operations, operator interaction, search, execution
- Prompt templates for common workflows
- A managed context that updates as work progresses

1. MCP server is your daemon's primary external interface. Not a peripheral feature; the central architecture.
2. Agents connect primarily to your server. Other MCP servers are optional and discouraged for v1.
3. Operator interaction goes through MCP tools. Not through framework-level chat; through structured tool calls.
4. File operations go through your MCP-provided tools when policy enforcement matters. Built-in framework tools used only when speed matters more than control.
5. v1 is a starter set of tools and minimal resources. The full "take over context" vision is multi-version.
6. Plan for resource notifications and dynamic updates in your protocol design, even if v1 doesn't use them.
7. The system prompt is still the framework's, but treat it as a known boundary. Don't try to control everything; control what MCP gives you control over.
8. Bet on MCP as the standard. Don't hedge with non-standard escape hatches.

1. MCP server is the architectural center, not a peripheral feature.
2. Agents are configured to use your tools, with built-ins disabled where replacements exist.
3. The full "take over context" vision is multi-version; v1 is the starter set.
4. Resources, tools, prompts all flow through your server.
5. Bet on MCP as a stable substrate for the long term.

