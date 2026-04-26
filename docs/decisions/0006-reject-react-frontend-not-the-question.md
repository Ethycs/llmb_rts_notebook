# 0006. Reject React; reframe frontend as not the load-bearing question

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** PIVOT

## Context

Once DR-0005 settled the V1 cut list, the immediate next question was "what does the web UI look like." The conversation cycled through every plausible candidate — React, plain JS, htmx, Svelte, p5.js, Flutter — and framework selection started consuming attention disproportionate to its impact on the hypothesis. The user rejected React directly ("I don't like react because I think it's too complicated"), which broke the framing and forced a reframe of what the question actually was.

The reframe: none of the candidate frameworks would, on their own, produce or fail to produce the V1 hypothesis. What differentiates this tool from existing chat-with-an-agent UIs is not the framework chosen to render it; it is the interaction model of the chat surface itself — inline permission approvals with full context, tool-call collapsing, streaming UX done well, file handoff via `xdg-open`, and conversations as first-class data rather than UI state. The framework decision is downstream of which interaction model is being built.

## Decision

React is rejected for V1. More importantly, the framework question is reframed as not load-bearing: the operator-agent interaction model of the chat surface is the actual differentiator, and the framework choice falls out of it as a downstream consequence.

The chat surface V1 must deliver on:

- Inline permission approval blocks rendered in-conversation with verb, target, agent reason, diff preview, policy implication, and multiple approval levels (allow once / allow + add to policy / deny). The block stays in the transcript after resolution as audit trail. This is where the V1 hypothesis lives — operator leverage over the agent is exercised here.
- Tool-call collapsing: one-line collapsed entries with action verb, target, result summary, timing; click to expand. Turns a hundred-tool-call session from scrollable-in-minutes into scannable-in-seconds.
- Streaming UX done well: smooth incremental rendering, smart auto-scroll (yes at bottom, no when scrolled up), visible interrupt button, generation-state indicator.
- `xdg-open` handoff for file paths in any message; the chat is not an editor.
- Persistence as data, not UI state: conversations are first-class entities in SQLite, the chat panel is a renderer over them, they survive restart and reload and are queryable.

The framework picked is whatever makes those features cheapest to build well. That decision is deferred until the chat shape is committed; it is explicitly not a V1 architectural decision. (The chapter 06 pivot to VS Code as the host platform ultimately absorbs much of the "frontend framework" question entirely.)

## Consequences

- **Positive:** Attention shifts from framework deliberation to the actual differentiator. The V1 build plan stops being held hostage to a tooling choice. The chat surface gets specified concretely enough to estimate (the five priority features become a tight implementation target). The path stays open to whichever rendering substrate fits — plain DOM, Svelte, p5+DOM hybrid, or eventually a VS Code webview — without re-litigating the framework question.
- **Negative / cost:** A concrete framework decision is deferred, which means the V1 implementation cannot start the frontend skeleton until that downstream decision is made. The five priority chat features are real work — likely two to three weeks of focused effort on top of the rest of V1 — and committing to a "better than most" chat surface inflates V1's timeline beyond the simplest possible build. React's mature ecosystem (markdown rendering, code highlighting, streaming chat libraries) is given up; whatever is chosen has to provide those or build them.
- **Follow-ups:** The chat shape needs to be specified in enough detail that the framework decision becomes obvious. Conversations must be modeled as first-class entities in the SQLite schema (alongside zones, agents, events) so persistence survives any frontend rewrite. The chapter 06 hand-off explores VS Code as the host platform precisely because building the chat surface well is enormously cheaper there than in a browser tab — DR-0006's reframe is what unlocks that pivot.

## Alternatives considered

Frameworks evaluated, with one-line verdicts — and with the note that all of them are downstream of the chat-shape question:

- **React.** Rejected outright. Toolchain (Vite, Next, ten-tool chain), state-management menu (Redux, Zustand, Jotai, MobX, Recoil), hooks gotchas (useEffect dependencies, stale closures, useMemo correctness), component-library culture — all enormously over-spec'd for a websocket-driven SVG view with a few panels and an input box.
- **Plain JS / vanilla DOM.** Genuinely viable for V1's scope. Zero framework, zero build complexity. Cost: as the chat panel grows the absence of structure starts to hurt, and you write a lot of "find this element, update its text" plumbing.
- **htmx (with Alpine).** Excellent fit for the chat panel forms and lists, poor fit for the map's smooth 60fps animations and edge flashes when every update is a fragment swap.
- **Svelte 5.** The honest "least complexity while still capable" answer. Compiler-driven, no virtual DOM, no hooks rules, reactivity built in via `$state`/`$derived`. SVG inside Svelte components is natural. If a single framework had to be picked, this would be it.
- **p5.js.** Creative-coding `setup()`/`draw()` frame loop. The map view is literally what p5.js was designed for. Bad for chat (text rendering, scrolling, markdown, accessibility all fight the canvas substrate). Natural conclusion is hybrid: p5.js for the map, plain DOM for the chat.
- **Flutter.** Genuinely good and probably the right answer for a v3 multi-platform native build. Wrong for V1: Dart is not in the existing stack, the web ecosystem advantage (markdown, code highlighting, diff display, streaming chat) is enormous and immediate, Flutter web is heavy on first paint.

The accepted alternative — and the actual content of this DR — is the reframe itself: none of the above is the load-bearing question. The chat-shape and the operator-agent interaction model are.

## Source

- **Source merged turn:** 041
- **Raw sub-turns:**
  - [turn-053-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-053-user.md) — "I don't like react because I think it's too complicated" (the trigger)
  - [turn-054-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-054-assistant.md) — alternatives walkthrough (plain JS, htmx, Svelte, Solid, Lit, Vue, htmx+Alpine)
  - [turn-057-user.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-057-user.md) — the reframe: "what if we developed a chat window on the side that was better than most chat windows for web"
  - [turn-058-assistant.md](../../_ingest/raw/phase-05-v1-scope-reduction/turn-058-assistant.md) — differentiator catalogue, five priority chat features, framework-as-downstream framing
- **Dev guide:** [chapter 05](../dev-guide/05-v1-scope-reduction.md)
