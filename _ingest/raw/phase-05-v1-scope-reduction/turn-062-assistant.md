---
turn_id: 062
merged_turn_id: 050
role: assistant
phase: 05-v1-scope-reduction
source_lines: [5433, 5645]
source_sha256: 2ea70eebfb2d7bb26bb550935b90a9e8f3dc0e7db7a8c67398eba2b05cd32a53
char_count: 20590
---



## Assistant

Now we're in genuinely interesting territory, but also genuinely dangerous territory in terms of scope, so let me work through this carefully because the answer depends a lot on what you're actually trying to accomplish.

Let me first make sure I understand what you're asking, because "custom Chromium with parallel interaction piped back to our chat" can mean several quite different things.

Three plausible interpretations, in order of complexity:

Interpretation 1: When the operator browses chat-based AI services in their browser (Claude.ai, ChatGPT, Gemini, etc.), the custom browser captures the subscription/streaming events from those services and feeds them back into your unified chat element, so you can see and interact with multiple AI conversations from many providers as if they were agents in your zone-based system.

Interpretation 2: Agents inside zones drive a browser (à la Browser-Use, Stagehand, Claude's computer-use) and the operator can see and interact in parallel — both the operator and the agent are interacting with the same web page simultaneously, with the agent's actions piping back to the chat as visible events.

Interpretation 3: A custom Chromium build is the application framework for the whole RTS — replacing Tauri/Electron — with deep modifications to support multiplexed connections, agent control, and chat integration as first-class browser features.

These have very different costs and benefits. Let me work through them.

Before going into the interpretations, worth being grounded about Chromium itself, because "custom version of Chromium" is a phrase that gets thrown around like it's a small undertaking, and it isn't.

Chromium is roughly 35 million lines of C++. Building it from source on a beefy machine takes 1-3 hours from a clean checkout. Set up takes a day if everything goes right. Maintaining a fork means tracking upstream — Chromium has a 4-week release cycle and breaks ABI/API constantly. Brave, Edge, Opera, and Vivaldi all maintain Chromium forks; each has full-time engineering teams dedicated to upstream tracking. That's the floor.

Most things you might want to do "with Chromium" don't actually require modifying Chromium. They can be done with:

Forking Chromium itself is reserved for cases where you need to ship binaries to end users, modify rendering or networking at the engine level, or change browser-level UI in ways extensions can't. Most agent-tool needs don't reach that bar.

So the very first question: do you actually need a Chromium fork, or do you need extensive Chrome DevTools Protocol usage with maybe an extension? I'm 90% sure the answer is the latter for everything you want.

Let me re-walk the interpretations with that frame.

The operator visits Claude.ai, ChatGPT, Gemini, etc. in their browser. Your tool captures the streaming responses from those services and makes them available in your chat UI alongside the agents running in zones.

The technical problem: most of these services use Server-Sent Events (SSE) or WebSocket streams to deliver tokens. The browser receives them and renders incrementally. You want to tap into that stream.

The hard part: cross-origin restrictions, CSP, and the browser's security model exist specifically to prevent this kind of cross-site interception. You can't just install an extension that reads ChatGPT's stream and forwards it elsewhere — at least not without some friction, because doing so would break a lot of security guarantees.

The realistic ways to do this:

Option A: Browser extension with explicit permissions. The extension declares the domains it needs access to (`https://claude.ai/*`, `https://chatgpt.com/*`, etc.), the user grants permission, and the extension content scripts can:

This is buildable. The extension is maybe 500-1000 lines. It's also fragile: every UI change to ChatGPT or Claude.ai requires updating selectors. You're scraping, basically.

Option B: Chrome DevTools Protocol (CDP) attached to a regular Chrome. Your daemon launches Chrome with `--remote-debugging-port=9222`, connects to it via CDP, and uses Network.responseReceived events to see all responses including streaming ones. This is what Playwright does under the hood. Totally legal, no browser fork needed, full network visibility.

The catch: the user has to launch Chrome through your tool (or you have to attach to a running Chrome with CDP enabled, which means they're using a special Chrome session). It's not their normal browsing session.

Option C: A man-in-the-middle proxy. The user's browser is configured to route through a local proxy (mitmproxy or similar) that you control. You see all traffic, including streaming responses. Most flexible; requires CA cert installation; works for any service without per-service customization.

This is the heaviest user setup but the most general solution. mitmproxy with a custom addon could feed your chat UI quite cleanly.

Option D: Custom Chromium fork. You modify Chromium to expose internal stream events to a local socket. You ship a custom browser. This works but it's the most expensive option by orders of magnitude, and gives you nothing options A-C don't.

The realistic recommendation: if Interpretation 1 is what you want, go with Option A (extension) for v1. It's the standard pattern for "augment what the user sees in their browser." If you find you need cross-cutting capabilities the extension can't provide, escalate to Option C (proxy). Forking Chromium is almost never the answer.

But — and this is the bigger question — is Interpretation 1 actually valuable? You're already running agents in zones via API. Why add a layer that scrapes consumer chat services? The use cases I can think of:

The biggest issue with Interpretation 1 is that it's working against the providers' ToS. Anthropic's Terms of Service for Claude.ai prohibit "use any automated means to access the Services." Same for OpenAI. Same for most of them. Building tooling explicitly to scrape those interfaces creates legal exposure for the user and possibly the developer.

Honest take: if you want unified access to multiple chat AI services, the right path is the API for each, not browser scraping. The API gives you streams, the API is allowed by ToS, and the API is more reliable than scraping. API integration is what your existing zones-with-Claude-Code architecture already supports; you'd just add other model providers as agent types.

So I'd say: Interpretation 1 isn't a great fit. The aim is sympathetic but the means are wrong.

This is where it gets genuinely interesting and architecturally productive. The setup:

This is the agent-in-the-loop browser collaboration model, and it's a real and underserved pattern. Multiple existing tools touch this:

What's missing from these: real-time co-presence. The operator can watch what the agent does, but taking over mid-task and handing back is awkward; both interacting at the same time is poorly supported; the chat history of "what's been happening in the browser" is usually a separate thing from the page itself.

A custom integration could do better, and here's how:

Architecture:

The hard part: how does the operator see and interact with the browser?

Option A: Screenshot stream + click forwarding. Easiest. Agent's browser headless or visible on a remote display; CDP captures screenshots at high frequency; operator's UI shows them; operator clicks are translated to coordinates and sent back via CDP. Works but feels like remote desktop. Latency-sensitive.

Option B: VNC/RFB or noVNC. Run the browser in a VNC-accessible session (Xvfb + x11vnc, or a containerized desktop). Operator connects via noVNC in their UI. Real interactive experience. More moving parts but proven.

Option C: Embed Chromium in your UI. Use CEF (Chromium Embedded Framework) or Webview to embed a real browser inside your application's window. The operator sees a real browser, can interact normally. The agent's CDP commands also drive it. This is what tools like Tauri or Electron do, with extensions for agent control.

Option D: Custom Chromium with multi-cursor support. Modify Chromium to support multiple input sources simultaneously — one human, one agent — with visible cursors for each. This is a real Chromium fork, with all the costs that implies. Probably overkill.

Option E: Anthropic's Claude in Chrome pattern, but yours. A Chrome extension installed in the operator's regular browser. The agent operates within the extension's permissions; the operator sees what's happening inline; the chat is a sidebar in the browser itself.

For your project, Option C (embedded Chromium) or Option E (extension) are the most realistic. Both avoid Chromium forks. C lets the browser be part of your RTS UI; E lets the operator's actual browser be the surface, with your tool integrated as an extension.

Of these, I'd argue Option E is more interesting for the "useful to a wide range of developers" frame, because it works with their existing browser, their existing logins, their existing extensions. The extension does:

This pattern is well-established (Claude in Chrome, several other tools) and doesn't require any browser fork.

For Option C: CEF and Tauri's webview integration are both viable. You'd embed a Chromium instance, drive it via CDP from your daemon, and present it in a panel of your app. More work than the extension approach but gives you a fully self-contained app.

Forking Chromium for this: would only make sense if you want browser-level features that neither C nor E support. I genuinely can't think of one for this use case.

Replace Electron/Tauri/etc. with your own Chromium build, deeply customized for your tool's needs. Browser is the app framework, not just an embedded view.

Why people consider this: total control over the runtime. Custom URL schemes. Custom protocol handlers. Custom devtools. Custom sandboxing rules. Custom IPC. Custom rendering pipeline.

Why almost nobody actually does this:

For the RTS tool, Tauri is dramatically more appropriate. Tauri uses the system webview (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux), so you don't ship a browser engine; you ship a thin Rust shell that hosts your web UI. You get:

This is what you want for a desktop-feel version of your tool. Not custom Chromium.

If for some reason Tauri's webview limitations bite (some web APIs aren't supported uniformly across platforms, certain features need specific browser engines), the next escalation is Wails (Go) or Electron (ships full Chromium, painful binary size but maximal compatibility). Then CEF (embed Chromium directly with custom shell). Forking Chromium itself is the last resort, after every other option has been exhausted.

Working back from the actual goals:

If the goal is "operator can have unified chat across multiple AI services": skip the browser angle. Add support for OpenAI/Gemini/etc. as agent types via their APIs. Each is a different "agent kind" in your zones. This is what your architecture is already shaped for.

If the goal is "operator can supervise an agent doing browser-based work": build a Chrome extension that integrates your tool with the operator's browser. The agent gets a controlled CDP/extension API surface for actions; the operator sees what's happening; the chat shows the action stream. Custom Chromium is unnecessary; Anthropic's Claude in Chrome is the existence proof.

If the goal is "make the RTS tool a real desktop app": use Tauri. Wraps your existing web UI in a native shell. Linux, Mac, Windows. No fork.

If the goal is genuinely "we need browser-engine-level customization to support our specific architecture": this is almost certainly not your situation. But if it ever were, you'd start by clearly enumerating which APIs/behaviors require engine modification, exhaust the alternatives (extensions, CDP, Tauri custom protocols), and only then accept the maintenance burden of a fork.

Let me steelman one version of "custom browser integration" that is potentially worth doing — not a Chromium fork, but a real product piece:

A Chrome extension that brings your RTS tool to the user's regular browsing.

The extension:

This is a real product. It extends your tool from "manage agents in zones on a server" to "operator's whole web workflow is integrated with their agent fleet." It builds on top of your existing daemon and chat; it doesn't require modifying Chromium.

The use case: developer working on a bug, agent in zone alpha reading the codebase. Developer opens a Stack Overflow page about a related issue. Click a button in the extension: "Share this page with agent alpha." The agent's chat now shows "Operator shared: [page title and content]," and the agent can incorporate it. Or the developer is reading Sentry error reports; "Watch this page, alert if errors spike" sends the URL to a monitoring agent.

That's interesting and shippable. It's also incremental — built later, after the core RTS works. The two-day chat from the previous turn doesn't need it.

Coming back to the immediate scope: in two days, you're shipping a chat that streams agent responses with inline permissions. None of the browser-integration ideas above belong in v1. They're all v2+ ideas with real value but real cost.

The discipline: don't expand v1 because shiny new ideas come up. Note them, slot them into v2 backlog, ship v1.

If you want to start thinking about the browser-integration future during v1, the architectural commitment to make is: the daemon's API is good enough that an extension or another client can use it. The websocket protocol that the chat speaks is the same protocol an extension would speak. The permission events are the same. The agent control surface is the same. You're not adding browser support; you're keeping the door open for it.

Concretely: don't make the API web-UI-specific. JSON-RPC or REST or whatever you pick should be reusable. The chat is one client; an extension would be another; a CLI is a third; a future native app is a fourth. All thin clients of the same daemon API.

For completeness, if you ever genuinely needed to do this:

Total cost of ownership: a small team's full attention indefinitely. Compared to "use an extension" or "embed via Tauri": orders of magnitude difference.

The takeaway isn't "don't fork Chromium" as a categorical rule — it's that the bar should be specific, articulable engine-level requirements that no other path can satisfy. Your project, as I understand it, doesn't reach that bar.

The honest summary: the impulse behind the question is good (browser integration with agent workflows is genuinely valuable), the proposed mechanism (custom Chromium) is wrong for it, and the right mechanism (extension + good daemon API) is achievable without bloating v1. Note the idea, ship the chat, build the extension later when you've validated the core.

Want to dig into the Chrome extension architecture for v2, the daemon API design that keeps multiple client types possible, the API-based multi-provider unified chat, or anything else?

- Chrome extensions: small, sandboxed, well-supported. Most browser augmentation lives here.
- Browser automation libraries: Playwright, Puppeteer, CDP (Chrome DevTools Protocol) directly. Full programmatic control without modifying the browser.
- Wrapper frameworks: Electron, Tauri (uses system webview), Wails. Embedded browser as an app shell.
- Headless modes: Chromium's built-in --headless flag for non-UI automation.

- Observe DOM mutations (when new message tokens render, capture them)
- Intercept fetch/XHR responses via service worker (modern Manifest V3 has limitations here)
- Forward captured content to your local daemon via fetch to localhost

1. The operator wants to consult Claude.ai's chat in addition to Claude Code agents and have the consultation visible in the same surface. Plausible but niche.
2. The operator wants to use a paid ChatGPT Pro subscription's higher rate limits without going through the API. True but morally and legally gray; the ToS of these services typically prohibit programmatic scraping of the chat surface.
3. The operator wants their personal Claude.ai chat history to be searchable alongside agent histories. Useful but probably solvable with simpler integration.

- An agent is doing browser automation work (researching, filling forms, interacting with a web app)
- The operator wants to see what the agent is doing and be able to take over or assist in real time
- Both can interact with the same page; the page state is shared
- The agent's actions stream into your chat as events

- Claude's computer-use: Claude controls a virtual desktop, including a browser. You can see what it's doing via screenshots streamed back.
- Browser-Use, Stagehand: agent-driven browser automation with visibility for the operator.
- Anthropic's Claude in Chrome (beta): a Chrome extension that lets Claude operate the user's actual browser session.
- OpenAI's Operator: similar concept, agent driving a browser.

- A browser session (Chromium) runs as a controlled environment for browser-using agents
- The agent drives it via CDP (Chrome DevTools Protocol) — it sends click, type, navigate commands and receives DOM snapshots and screenshots
- The operator's UI shows the same browser session in real time — either as a live screenshot stream, a remote-rendered view, or by literally embedding the browser in the operator's interface
- The operator can take over: pause the agent, click around themselves, send the agent a message about what they did, resume
- All actions (agent's and operator's) flow into the chat as events

- Adds a sidebar (or panel) showing your chat
- Talks to your local daemon via fetch to localhost
- Can be told by your daemon to perform actions: navigate, click, type, observe
- Surfaces those actions as chat events
- Lets the operator take over by just... using their browser normally

- The build/maintenance cost is enormous (Brave/Edge/Opera/Vivaldi scale)
- 95% of "I need a custom Chromium" is solvable with extensions, registered URL schemes, and webview customization
- Tauri and Electron exist specifically to give you "browser as app framework" without the fork

- Rust backend integrated naturally with your existing daemon
- Native window management, system tray, menus
- File system access from Rust (no need for browser sandboxing workarounds)
- Custom URL scheme handlers
- IPC between web UI and Rust
- Cross-platform (Linux, Mac, Windows)
- Small binary size (3-10 MB versus Electron's 100+ MB)

- Adds a sidebar panel with your chat UI
- Detects when the user is on a relevant site (a documentation site, a service dashboard, a vendor portal)
- Surfaces context-appropriate actions: "Send this page to agent alpha for review," "Have agent beta watch this dashboard," "Pipe support chat from this page into your incident response zone"
- Lets agents act on behalf of the operator with permission gates (the same inline permission UX as your main chat)
- Streams the operator's authorized browser interactions into the chat as events that agents can react to

- Setup: 1-3 days for working build environment, more on Mac/Windows
- Initial fork: a week to add a small custom feature and figure out the build/release/distribution path
- Ongoing: rebase against upstream every Chromium release (every 4-6 weeks), handle breakage, ship updates
- Distribution: code signing on Mac/Windows, GPG-signed packages on Linux, auto-update infrastructure
- Security: you're now responsible for shipping security patches as upstream releases them; falling behind is dangerous because Chromium gets serious vulnerabilities frequently
- Scale: companies that do this (Brave, Vivaldi, Arc until recently) have multiple full-time engineers on the browser

1. No Chromium fork in v1, v2, or v3. Not categorically forbidden, but not in the foreseeable plan.
2. For unified chat across providers: API integration via agent-type adapters in your existing zone architecture. Not browser scraping.
3. For browser-using agents with operator co-presence: Chrome extension that integrates with your daemon, similar to Claude in Chrome's pattern. Build later as v2+.
4. For desktop-app feel: Tauri when you want it, not a custom browser.
5. For browser-as-RTS-companion: Chrome extension is the surface, talking to your daemon via the same protocol the chat does. Real product idea, post-v1.
6. The daemon API is the architecture: keep it reusable across multiple client types so future browser integration is additive, not retrofit.

