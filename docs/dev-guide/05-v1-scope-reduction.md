# 05 — V1 scope reduction and frontend search

## Purpose

This chapter is the inflection point where the project narrows from "everything imagined" to "what ships." V1 exists to test exactly one hypothesis: that an RTS-style operator interface improves supervision of autonomous coding agents. Everything that does not directly serve that test is cut, deferred, or replaced with the cheapest possible stand-in. The frontend question that opens next — React, Svelte, htmx, p5.js, Flutter — is then walked through and dissolved: framework choice is downstream of the real differentiator, which is the chat and operator interaction model itself.

## The V1 hypothesis

V1 is meant to demonstrate one thing: that an operator running multiple coding agents in bounded zones, watching their activity on a 2D map, intervening through inline permission approvals and direct chat, produces meaningfully better oversight than tailing two terminal windows of agent logs side by side. The hypothesis is qualitative — "does this metaphor work?" — not quantitative, and the test is small enough to ship in roughly three weeks of focused work, not three months. If the simple demo does not feel useful, none of the architectural elaboration from the prior chapters matters. If it does, V1 is the foundation everything else can be retrofitted onto without repainting.

The principle behind the cuts in [DR-0005](../../_ingest/manifests/decisions.json) is that V1 should prove the core hypothesis with the smallest possible surface area, while staying structured to grow into the full architecture later. Every cut is a deferral, not a deletion — and several of the cut items return in altered form in later chapters.

## What V1 IS

The kept feature set is opinionated and small:

- **Single host.** The daemon, the agents, the UI, and the operator all live on one Linux machine. No remote daemon, no cross-host transport, no SSH tunneling.
- **Single agent type: Claude Code via the Agent SDK.** No adapter trait, no second framework, no ACP or HTTP plug-points. The SDK is wrapped in a small Node or Python subprocess per agent so that mid-run message injection works cleanly.
- **2D map only.** Zones as colored rounded rectangles, files inside as small rects, agents as colored circles, tool calls as edges that flash on event arrival. SVG is enough; no D3, no canvas dataflow engine, no 3D anything.
- **Plain `chroot()` plus bind mounts for filesystem isolation.** The zone metaphor cashes out as a chroot tree with the workspace bind-mounted in. Roughly 150 lines of Rust around the syscalls. Network and PID namespacing are not in V1.
- **In-memory daemon state, persisted to a single SQLite file.** Three tables: `zones`, `agents`, `events`. Recovery on restart is "load zones, mark prior agents lost, let the operator respawn." No event sourcing, no derived index over an append-only log.
- **Permission hooks as the load-bearing operator-control surface.** The agent SDK invokes a callback into the daemon for every tool call; the daemon decides (auto-allow inside zone / ask operator / deny) and renders pending decisions as inline approval blocks in the chat panel.
- **Per-agent chat panels driven by a websocket.** Click an agent on the map, a side drawer opens with that agent's full message history, tool calls collapsed by default, an input box that sends as a `user_message` event into the SDK session.
- **Three CLI commands, no shell magic.** `rts new-zone <name> <path>` creates a chroot-backed zone, `rts spawn <zone> '<prompt>'` launches an agent in it, `rts status` lists active zones and agents. CLI talks to the daemon over a Unix socket.
- **`xdg-open` handoff for files.** Click a file in the UI, the daemon resolves it to a host path, `xdg-open` hands off to whatever editor the operator has registered. The tool does not try to be an editor.
- **Single-user, no auth.** Daemon listens on a Unix socket and a localhost websocket. Remote access is "SSH-tunnel it yourself," documented but unsupported.
- **Stable event schema as the connective tissue.** Events have `(id, agent_id, zone_id, timestamp, event_type, payload_json)` from day one. Tool calls, assistant messages, user messages, permission requests, and permission decisions all flow through this one pipe. Everything else in the system is derived from it.

That is V1. Five components — daemon, frontend, CLI, SQLite, agent SDK wrapper — each doing one thing, each replaceable later without invalidating the others.

## What V1 IS NOT (DR-0005)

Each of the items below was on the table in earlier chapters and was explicitly cut for V1. The "why cut" line states the cost of carrying it through V1 versus the value it adds to the hypothesis test.

- **3D / VR view.** Always a v3 feature. The hypothesis is about whether the spatial encoding works at all; 2D answers that. Stereoscopic rendering does not.
- **macOS support.** Linux-only. The chroot path, the agent process model, the daemon's syscall surface all assume Linux. Building a Mac launcher and a packaging story doubles the platform engineering for zero hypothesis value.
- **SSH and multi-host transport.** Single host only. Local Unix socket between CLI and daemon. SSH support is documented as future work; in practice, [chapter 06](06-vscode-notebook-substrate.md) eventually solves the remote story by leaning on VS Code Remote-SSH rather than building a transport layer.
- **MCP.** Cut entirely from V1. Agents have whatever built-in tools the SDK ships with; no MCP servers, no per-zone instances from [DR-0004](../../_ingest/manifests/decisions.json), no proxy. This is a clean upgrade path — MCP adds as a new event type and a side process later. MCP returns in a different role in [chapter 06](06-vscode-notebook-substrate.md), where it becomes the bidirectional communication channel between extension and kernel rather than a tool-provisioning protocol.
- **Bubblewrap, namespaces, microVMs.** Plain `chroot()` inside a mount namespace is enough for V1 — the zone metaphor only needs filesystem isolation to be visible to the operator. Bubblewrap is a user-installable dependency; namespace orchestration is a Rust project unto itself; microVMs were never seriously on the V1 table. All defer to later hardening passes.
- **Live policy injection.** Zone policies are static config files set at zone creation. Changing a zone's policy means recreating the zone. Watched-file hot reload, DB-backed policies, policy-as-code — all v2.
- **Event sourcing as source of truth.** SQLite is authoritative; an optional JSONL audit log is append-only beside it. No projection from events, no replay-as-recovery. The event-log-as-truth model from [chapter 03](03-hypergraph-observability.md) is preserved as a design *aspiration* — the schema is stable enough to flip into source-of-truth later — but V1 does not pay the cost of building it that way.
- **NATO symbology / milsymbol.** The categorical visual vocabulary remains the right answer aesthetically, but milsymbol is one more dependency and a styling exercise that does not affect whether the metaphor works. V1 ships with simple colored shapes — circles for agents, rectangles for files, lines for edges — and the categorical language gets layered on once the UX is settled.
- **VegaFusion / Vega.** Cut entirely. V1's data volumes (tens of agents, thousands of events) do not need a column-store dataflow engine. A plain frontend reading directly from a websocket is fine. Vega comes back if and when scale demands it; the [chapter 01](01-vega-rendering-substrate.md) substrate work is preserved as research, not as V1 code.
- **Magic CLI tooling.** No prefix-launcher, no preexec hook, no shell integration, no SDK skill. Just three subcommands talking to the daemon. The "agent runs the way you usually run things" framing was always seductive and always premature.

The discipline here is that every cut is *additive* to retrofit, not destructive: nothing about V1's structural decisions makes any of these features harder to add later, as long as the load-bearing things (event schema, zones-as-first-class-entities, tool-calls-as-events, decisions-as-records) are done right even in the simple build.

## The frontend non-question (DR-0006)

Once the V1 cut list is settled, the immediate next question is "what does the web UI look like." The conversation cycles through every plausible candidate, the user rejects React directly, and the assistant eventually reframes the question itself: framework choice is not what differentiates this product. See [DR-0006](../../_ingest/manifests/decisions.json).

Frameworks evaluated, with one-line verdicts:

- **React.** Rejected outright by the user — "too complicated." The toolchain (Vite, Next, the ten-tool chain), the state-management menu (Redux, Zustand, Jotai, MobX, Recoil), the hooks gotchas (useEffect dependencies, stale closures, useMemo correctness), the component-library culture choice — all of it is enormously over-spec'd for a websocket-driven SVG view with a few panels and an input box.
- **Plain JS / vanilla DOM.** Genuinely viable for V1's scope. Zero framework, zero build complexity, zero churn. The cost is that as the chat panel grows in capability the absence of structure starts to hurt — without reactivity you write a lot of "find this element, update its text" plumbing.
- **htmx (with Alpine).** Server-driven HTML swapping. Excellent fit for the chat panels (forms, lists, panels with occasional updates), poor fit for the map (smooth 60fps animations and edge flashes are awkward when every update is "diff this fragment, swap it in").
- **Svelte 5.** The honest "least complexity while still capable" answer. Compiler-driven; no virtual DOM, no hooks rules, reactivity built into the language with `$state` and `$derived`. Files are short; the whole framework is learnable in an afternoon. SVG inside Svelte components is natural. If a single framework had to be picked, this would be it.
- **p5.js.** Creative-coding framework with a `setup()` / `draw()` frame loop. The map view is *literally* what p5.js was designed for — drawing zones, agents, edges, animations is one function call each. Bad for chat (text rendering, scrolling, markdown, accessibility all fight the canvas substrate). The natural conclusion is hybrid: p5.js for the map, plain DOM for the chat. The aesthetic upside is real — p5 leans the UI toward "thing in motion" rather than "business dashboard."
- **Flutter.** Genuinely good and probably the right answer for a v3 multi-platform native build. Wrong for V1: Dart is not in the existing stack, the web ecosystem advantage (markdown, code highlighting, diff display, streaming chat) is enormous and immediate, and Flutter web is heavy on first paint. Defer to v2+.

The reframe — and the actual content of [DR-0006](../../_ingest/manifests/decisions.json) — is this: **the frontend framework is not the load-bearing question.** None of the frameworks above will produce or fail to produce the V1 hypothesis on their own. What differentiates this tool from existing chat-with-an-agent UIs is not the framework chosen to render it; it is the *interaction model* of the chat surface itself. The framework decision becomes a downstream consequence of which interaction model is being built.

## What the differentiator is

Most chat windows — Claude Code's TUI, OpenCode, ChatGPT, Slack-shaped agent UIs — share weaknesses that come from treating the conversation as an append-only stream of text. Long tool results dominate the screen. Past messages are immutable. Generated artifacts are buried in scrollback. There is no notion of "what the agent is doing right now" separate from "what it just said." Permission requests, when they exist, are modal yes/no dialogs without context.

The chat surface V1 needs to deliver on is qualitatively different because the entity on the other end is not a human and not a stateless completion endpoint — it is a running process inside a zone, with a checkpointable filesystem, a deterministic event log, and a permission gate that the operator owns. The interaction model has to use those facts.

Concretely, the chat panel needs to do things off-the-shelf chat UIs do not:

- **Inline permission approvals with full context.** When the agent wants to write a file, the approval block appears in the conversation where the request was made, showing the verb, the target, the agent's reason, a diff preview where applicable, the policy implication, and multiple approval levels (allow once, allow + add to policy, deny). The block stays in the transcript after resolution as an audit trail. This is where the V1 hypothesis actually lives — the operator's leverage over the agent is exercised here, and the surface has to make that leverage cheap to use.
- **Tool-call collapsing.** Tool calls render as one-line collapsed entries with action verb, target, result summary, and timing. Click to expand. A session with a hundred tool calls becomes scannable in seconds rather than scrollable in minutes. This single affordance changes the experience of reading an agent transcript by an order of magnitude.
- **Streaming UX done well.** Token-by-token rendering with smooth incremental DOM updates and no janky reflow. Auto-scroll while the operator is at the bottom; do not auto-scroll when they have scrolled up to read past content; show a "new messages" indicator they can click to jump back to live. Visible interrupt button so the operator can cancel mid-generation cleanly. This sounds like polish but is what makes the agent feel alive and steerable rather than like a delayed log tail.
- **`xdg-open` handoff for files referenced in chat.** Click any file path in any message, the daemon resolves it, the operating system opens it in whatever editor the operator has wired up. The chat does not try to be an IDE; it tries to be the shortest possible bridge between the conversation and the actual artifacts.
- **Persistence as data, not as UI state.** Conversations are first-class entities in SQLite. The chat panel is a *renderer* over the conversation; the conversation itself survives daemon restart, survives page reload, and is queryable. This is also what makes later features like edit-and-resend, branching, and time scrubbing possible without schema migration — they all become read patterns over the same event log.

These are the features that, taken together, make V1's chat surface meaningfully better than what exists. The user's framing question — "could we ship a chat window on the side that was better than most chat windows for web" — is the load-bearing one. The framework question is downstream of it.

This is also the hand-off into [chapter 06](06-vscode-notebook-substrate.md). Building this chat surface well — inline diffs, native file open, multi-pane layout, command palette, distribution, cross-platform — turns out to be enormously cheaper if the host is *not* a browser tab. The diff editor, the file decorators, the activity-bar integration, the webview API, the marketplace install path, even the cross-platform story (via VS Code Remote-SSH absorbing what would otherwise be the SSH and macOS work) all collapse into things VS Code already provides. V1's chat panel is what makes the case for adopting VS Code as the host platform, which is the pivot the next chapter records.

## Source turns

- [00-overview.md](../../_ingest/raw/phase-05-v1-scope-reduction/00-overview.md) — phase manifest
- [turn-048-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-048-assistant.md) — V1 cut catalogue, three-week build plan, hypothesis statement (the basis for [DR-0005](../../_ingest/manifests/decisions.json))
- [turn-049-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-049-user.md) — "I want some nodes to be interactive chat windows"
- [turn-050-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-050-assistant.md) — chat-as-nodes design space, conversations as first-class data, inline permission approvals
- [turn-051-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-051-user.md), [turn-052-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-052-assistant.md) — Flutter vs React deliberation; React deferred for v1
- [turn-053-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-053-user.md) — "I don't like react because I think it's too complicated" (the trigger for [DR-0006](../../_ingest/manifests/decisions.json))
- [turn-054-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-054-assistant.md) — alternatives walkthrough (plain JS, htmx, Svelte, Solid, Lit, Vue, htmx+Alpine), Svelte recommended
- [turn-055-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-055-user.md), [turn-056-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-056-assistant.md) — p5.js evaluation; hybrid p5+DOM proposal
- [turn-057-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-057-user.md) — the reframe: "what if we developed a chat window on the side that was better than most chat windows for web"
- [turn-058-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-058-assistant.md) — the differentiator catalogue: three-pane layout, collapsed tool calls, inline approvals, streaming with interrupt, edit-and-resend with branching
- [turn-059-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-059-user.md), [turn-060-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-060-assistant.md) — two-day chat shipping plan
- [turn-061-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-061-user.md), [turn-062-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-062-assistant.md) — custom Chromium fork explored and rejected
- [turn-063-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-063-user.md), [turn-064-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-064-assistant.md) — Electron / Tauri considerations
- [turn-065-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-065-user.md), [turn-066-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-066-assistant.md) — "is there a cheaper way to do a full featured browser chat while still being useful as a tool"
- [turn-067-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-067-user.md), [turn-068-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-068-assistant.md) — "what about VSCODE instead of the browser" — the bridge into [chapter 06](06-vscode-notebook-substrate.md)
