---
turn_id: 070
merged_turn_id: 058
role: assistant
phase: 06-vscode-notebook-substrate
source_lines: [6502, 6695]
source_sha256: 767530d41ad559185e5c24bcabe32f898f2999c2c86136632fe28d8aaa119442
char_count: 20980
---



## Assistant

This is a sharp question and the answer is more nuanced than a yes or no. The short version: VS Code extensions are explicitly designed to not aggressively intervene in each other, and the API enforces this. But there's real territory between "do nothing" and "modify another plugin's code," and that territory contains some genuinely useful capabilities, plus some workarounds for cases where the official API isn't enough.

Let me work through what's possible, what isn't, and what's relevant for your project specifically — because "aggressive interventions" can mean very different things depending on what you're trying to accomplish.

VS Code extensions run in a separate process called the "extension host" — a Node.js process that's distinct from the editor's renderer process. All extensions in a workspace share this extension host process, but the API enforces hard boundaries between them:

This is a security and stability design choice, and it's what allows the marketplace to function. If extensions could freely intervene in each other, every extension you install would be a potential vector for breaking every other extension. The model is deliberately restrictive.

So the first thing to be clear about: VS Code does not give you an "aggressive intervention" API by design. Anything resembling that is going to be either (a) using the official cooperative APIs, (b) clever workarounds, or (c) genuinely outside the supported model.

There are several legitimate ways extensions can interact, and they collectively cover a lot of ground:

Public commands. Any extension can call commands registered by any other extension via `vscode.commands.executeCommand('extension.commandId', ...args)`. This is the primary cooperation mechanism. If GitLens registers a command, you can call it. If you register commands, others can call yours. This is by-design coupling and works well.

Exported APIs. An extension can expose a public API surface via its `activate()` function's return value. Other extensions get this via `vscode.extensions.getExtension('publisher.extension').exports`. Languages servers, debuggers, and platform tools commonly use this. Want to integrate with the Python extension's interpreter selection? Use its exported API.

Document and editor APIs. Your extension can read any open document, observe edits, programmatically modify text, manipulate selections. This works regardless of which extension is "responsible" for the file. If another extension's webview displays a file, you don't see that — but if a regular text document is open in an editor, you can read and write it.

File system APIs. Read and write files in the workspace. Watch for changes. This affects whatever extensions might be observing those same files.

Workspace and language events. Subscribe to file open, close, save, change. Subscribe to language events (definitions, references, diagnostics from any language server). This is observation, not intervention, but it's pretty rich.

Setting overrides. Read and write workspace and user settings programmatically. You can change settings that other extensions consume on the fly.

Terminal and task APIs. Spawn terminals, run tasks, read output. Affects what other extensions might see in those terminals.

Diagnostics. Your extension can publish diagnostics (errors/warnings) for any file, and they show up alongside diagnostics from language servers and other extensions. You can also read diagnostics from other sources.

Source control API. Multiple extensions can register source control providers and they coexist visually.

This is meaningful capability. Most legitimate cross-extension cooperation happens through this surface.

Things that aren't officially supported but are technically possible in the extension host:

Reading the extensions' source files from disk. Every installed extension is just files in your `.vscode/extensions` directory. Your extension can read other extensions' source code. This is observation only — you can't change their behavior, but you can know what they expose, what commands they register, what files they touch.

Monkey-patching the VS Code API in the extension host. Because all extensions share a Node.js process, your extension can technically `require('vscode')` and modify properties on the returned object. This is deeply unsupported and breaks at any update, but it's been done for specific purposes by extensions that want global behavior changes. Very fragile and almost always a bad idea.

Replacing module imports via Node.js's module system. You can hook `require` and intercept what other extensions load. Same fragility as monkey-patching the API.

Spawning child processes that interact with extensions externally. Your extension can spawn processes that talk to other extensions via the file system, RPC over disk, or whatever. This is a different model — extensions cooperating via external mechanisms rather than in-process APIs.

Using the proposed/secret API. VS Code has APIs marked "proposed" that aren't in the public surface but are usable if your extension declares it. These can do more powerful things, with the caveat that they may break in any release. Microsoft uses these for first-party extensions; third-party use is officially discouraged but technically possible.

The Code OSS / Cursor / Windsurf forks have additional capabilities. If your audience uses VS Code forks, the forks sometimes expose things VS Code doesn't. But targeting fork-specific capabilities fragments your audience.

These "more aggressive" approaches range from "officially allowed but discouraged" to "technically possible but you'll regret it." For a tool you want to be reliable, stay out of this zone.

Before going further, worth pulling on the question. Why would your tool need aggressive intervention into other plugins?

A few possible motivations and what they actually mean:

"I want to know what other agents/plugins are doing in the editor": this is observation, and the official APIs cover most of it. Watch document changes, watch diagnostics, watch terminal output. You don't need aggressive intervention; you need active subscription.

"I want to make other plugins use my plugin's functionality": this is forcing dependency, which is fundamentally hostile. A better model is exposing your functionality cleanly and letting others choose to use it.

"I want to disable or constrain other plugins when my plugin is active": this isn't really possible by design. You can recommend the user disable certain plugins; you can't programmatically disable them.

"I want to coordinate with specific other plugins (Copilot, Continue, Cursor's built-ins)": this is integration, and the right answer is using their public APIs (if any) or shipping a cooperation mechanism.

"I want to capture LLM-related events from any agent plugin": this is interesting for your project specifically. It's harder than it sounds, and we should walk it carefully.

The last one is probably what's actually motivating the question. Let me focus on it.

The natural thing for an RTS-style tool to want is: the operator has multiple agent tools running (yours + Copilot + Continue + Cursor's built-in), and your RTS should show all of them as agents on the map.

This is the deepest interpretation of "aggressive intervention into other plugins": your tool wants to be the unified observability and control layer for all agent activity in the editor, regardless of which extension provides the agent.

The honest news: this is hard, and only partially possible. Let me lay out what works and what doesn't:

Document-edit observation. When any agent (yours, Copilot, Continue, Cursor) makes an edit, it goes through VS Code's document API. Your extension can subscribe to `workspace.onDidChangeTextDocument` and see edits regardless of source. You won't always know which agent caused the edit — the API doesn't carry that metadata — but you can see all edits.

File save observation. Same pattern. Anyone saves a file, you see it.

Terminal observation, partial. You can read terminal contents and observe new terminals being created. If an agent spawns a terminal to run something, you might see the activity. Some agents don't use terminals (Copilot's inline suggestions don't), so this is partial.

Git activity observation. Watch the git status. When agents commit, you see the commits. When they create branches, you see them.

Diagnostics observation. If an agent triggers a build/test that produces diagnostics, you see them.

Notification observation, almost none. You can't see notifications other extensions emit. This is intentionally siloed.

Webview observation, none. Other extensions' webviews are entirely opaque to you. If Copilot's chat is in a webview, you can't see what's happening in it.

Inline suggestion observation, none directly. Copilot's inline ghost-text suggestions are rendered through an internal API that doesn't expose accept/reject events to other extensions. You can detect the resulting text change via document changes, but you don't know it came from a suggestion.

LLM call observation, none. If another extension calls an LLM API directly, you have no visibility. The HTTP traffic doesn't pass through any extension-visible interface.

MCP observation: if you can intercept MCP, you can see anything that flows through MCP. VS Code's language model API and MCP integration are evolving fast — there are increasingly ways for extensions to participate in the language model interaction layer, but this is still maturing.

The fundamental issue: a lot of agent activity happens outside VS Code's observable APIs. Copilot's suggestions, Cursor's chat, Continue's interactions — much of it is internal to those extensions, communicated to LLM backends directly, and the only externally visible artifact is the resulting code change.

For your RTS tool to track all agent activity in the editor, you'd have to:

The last one is interesting. It pulls toward: your tool isn't an observer of all agent activity, it's the home for the activity you care about. Operators choose to use yours; what they do with Copilot or Continue alongside is their business and your tool stays out of it. Less ambitious; more honest about what's actually possible.

Where the question gets genuinely interesting is at the MCP and Language Model API layer in VS Code. Both are converging on a model where extensions can participate in the LLM-tooling layer in standardized ways, and your tool could plug into this surface.

VS Code's Language Model API lets extensions invoke LLM models through a unified interface. If other extensions use this API (rather than calling LLM endpoints directly), there's a natural place where activity could be observable. But adoption is mixed — most agent extensions still talk to LLMs directly.

VS Code's MCP integration lets extensions register as MCP servers or clients. If you became a major MCP-server provider for agent tools in VS Code, you'd be in the loop for MCP-mediated activity. This is a real opportunity but it's emerging, not established.

The strategic answer to "how do I observe other plugins' agent activity": bet on standardization layers, not aggressive observation. As MCP and the Language Model API mature, the natural observability points open up. Your tool can be a first-class participant in those ecosystems rather than an outside observer trying to peek in.

For v1, this is mostly aspirational. For v2 and beyond, it's how this actually scales.

Let me steelman the original question. Are there cases where you'd actually want aggressive intervention?

Case 1: replace another extension's UI with yours. E.g., your RTS wants to replace Copilot's chat panel with its own. Not allowed; not even via aggressive workarounds reliably. Copilot's panel is its own webview that you can't touch.

Case 2: prevent another extension from doing something. E.g., your RTS wants to block other agents from making writes to certain files. Not allowed by extension API. The closest thing: register file system operations and try to compete to handle them, but you can't reliably preempt.

Case 3: piggyback on another extension's authentication or session. E.g., your RTS wants to use Copilot's GitHub auth to call APIs. Generally not allowed; extensions don't expose their auth to others.

Case 4: route another extension's commands through yours. E.g., when the user invokes Copilot's chat, your RTS wants to add to the prompt or wrap the response. Not allowed through commands; their command goes directly to their handler.

Case 5: read another extension's webview content. E.g., your RTS wants to scrape Cursor's chat panel. Not allowed; webviews are opaque to other extensions.

In every one of these cases, the answer is the same: the platform doesn't allow it because extensions are designed to be independent. Workarounds exist (mostly fragile module-level monkey patching) but they break constantly and put you in adversarial territory with the extensions you're "intervening in."

A practical reading:

Don't try to be a universal agent observability layer in v1. The platform doesn't support it. You'll spend enormous effort on hacks that break weekly.

Be the home for the agent activity that goes through your tool. Operators who use your RTS get full observability of agents they spawn through your RTS. Operators who use Copilot for inline suggestions on the side get... Copilot's behavior, separately. You don't need to unify everything to be useful.

Use the official cooperation APIs for legitimate integrations. If you want to integrate with the Python extension's interpreter, the GitLens commit timeline, the Docker extension's container view — those have public APIs and are great targets.

Consider being an MCP server. If your daemon exposes its capabilities as MCP tools, any agent extension that uses MCP can use your tool. Operators using Copilot Workspace, Cursor's MCP integration, or Claude Code in your VS Code can all reach your RTS. This is the "be the standardized backend" play, and it's strong.

Plan for the daemon to be editor-agnostic anyway. If you have a working tool that works with one editor, plus a reasonable protocol, other editors can integrate by writing their own clients. You don't need to "intervene" in their plugins — you provide a service their plugins can use.

This is roughly the architecture I'd recommend regardless of how aggressive you wanted to be. The platform constraints push you toward the architecture that's actually correct.

Cursor, Windsurf, Continue (when packaged as a fork), and others have customized the VS Code extension model in various ways. Some of them expose APIs that VS Code doesn't, sometimes specifically for agent integration. If a substantial part of your audience uses one of these forks, you can target their additional capabilities.

However: fragmenting your extension across forks is a maintenance trap. Each fork has its own quirks, its own update schedule, its own breaking changes. Targeting only stock VS Code keeps your extension portable; targeting forks adds capabilities at a real ongoing cost.

For v1, I'd target stock VS Code and accept missing some fork-specific integration potential. Revisit when you have a real, large user base on a specific fork.

If you want to push the limits of what's possible without breaking the model:

Build a rich, well-documented public API for your extension. Make it easy for other extensions to integrate with you. Other agent tools could publish events to your RTS as a deliberate cooperation. You become the "I integrate with everyone" tool by being the easy integration target.

Build an MCP server that exposes your RTS as MCP tools. Any MCP-using agent — including Claude Code, Cursor's MCP integration, Continue, etc. — can use your tool as a capability. This is genuinely powerful. The agent in another extension calls your MCP "spawn-zone" tool; suddenly that agent has access to your RTS's zone primitives.

Provide CLI hooks that any tool can use. Your daemon's `magic` CLI from earlier turns is callable by any process, including other extensions' shell-out helpers. Any agent in any extension that runs shell commands can drive your RTS through the CLI.

Use document edit events plus heuristic attribution. Track edits, group them by burstiness and pattern, attribute to agents (yours specifically) when you have ground truth. Be honest about uncertainty for edits from other sources.

Subscribe to git events for cross-tool reconciliation. If multiple agents commit, your RTS at least sees the commits and their authorship. The git history becomes a unifying ledger.

These are integration through openness rather than intervention through aggression, and they fit the platform's model.

VS Code intentionally prevents aggressive intervention between extensions, and you should treat that as a feature, not a limitation. The right architecture for your RTS is:

The "aggressive intervention" framing turns out to be the wrong mental model. The right one is "build a great host for the activity I care about, integrate cleanly with the rest, and bet on emerging standards for the unification I'd like." That's a longer path but a stable one.

Decisions worth locking:

If the question was really "how do I make my RTS the unified agent layer in the editor," the honest answer is: you can't via aggressive intervention; you can via being the best agent host plus the most-integrated backend. That's still a real path, just not the one the question implied.

Want to dig into the MCP server design for cross-tool integration, the public extension API surface for cooperation, the heuristic attribution model for editor-wide changes, or the git-as-unifying-ledger idea?

- Extensions can't read or write each other's memory
- Extensions can't access each other's private state
- Extensions can't intercept or modify each other's API calls
- Extensions can't subscribe to each other's internal events
- Extensions can't reach into each other's webviews
- Extensions can't override each other's commands without explicit collaboration

1. Accept that you'll miss things: see code changes but not the prompt that produced them, see commits but not the reasoning. This is the realistic position.
2. Rely on document change events as the primary signal: any edit, regardless of source, is observable. Build the model around "what changed" rather than "what intent."
3. Use heuristics for attribution: a rapid burst of edits in patterns characteristic of LLM output (large blocks added at once, multi-file changes), made shortly after a chat panel was active, can be heuristically attributed. Not reliable, but informative.
4. Provide a manual signaling API for collaborators: your extension exposes an API ("publishAgentActivity") that other extension authors can call to inform your RTS of their activity. Cooperative model. Realistic adoption: zero unless you become massively popular.
5. Run your own version of "the operator's primary agent" and skip other agents: if your tool is the agent surface in the editor, observability is simple — all the activity goes through your tool. This is the "Cursor approach" — be the agent UI rather than coexisting with others.

1. Be the home for the agent activity that flows through you. Operators who use your RTS get great visibility and control over its agents. They use Copilot or Continue separately if they want to.
2. Integrate with VS Code's official APIs aggressively, with other extensions cooperatively. Document changes, terminals, diagnostics, source control — all observable. Other extensions are integrated via their public APIs or via cooperation mechanisms (your MCP server, your CLI, your public API).
3. Bet on MCP and the Language Model API for the future of cross-tool integration. As these layers mature, the unification you want becomes possible naturally. Don't try to force it now via hacks.
4. Don't try to monkey-patch other extensions or VS Code itself. It will break on every update and put you in adversarial territory. The energy is better spent on your tool's core value.
5. Accept that some agent activity in the editor will be invisible to you. Build the tool to be useful with that limitation. Most operators will adopt one primary agent surface anyway; if yours is good, that becomes them.

1. Extension respects the platform model: no monkey-patching, no module-level hacks, no aggressive interception.
2. Use document, terminal, diagnostics, git APIs for legitimate observation of editor-wide activity.
3. Plan for an MCP server interface to your daemon as a v2 cross-tool integration play.
4. Provide a public extension API so other agent tools could integrate with you cooperatively.
5. Don't target VS Code forks for v1; revisit if a large audience emerges on one.
6. Be honest about visibility limits in the UX — show what you can attribute, mark what you can't.

