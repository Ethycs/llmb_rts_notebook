---
turn_id: 110
merged_turn_id: 096
role: assistant
phase: 08-blockers-mediator-standards
source_lines: [12591, 12840]
source_sha256: f6aa6c279705570eb0602ff38132977ae0ccc87f723b39b207fbbbf6b2ab93f9
char_count: 17012
---



## Assistant

Honest answer: no. The testing infrastructure question we just resolved is one blocker; there are several others I haven't surfaced explicitly that would bite during v1 if not addressed. Let me work through what I think the real blocker list looks like, distinguishing genuine blockers from "things that need attention but aren't blocking."

A blocker, for this purpose, means something where if you don't have an answer or a working solution, v1 can't proceed past a specific point. Things that need attention but have known solutions or can be deferred aren't blockers in the strict sense.

Worth noting what's been answered across the conversation so we know what's actually outstanding:

These have working answers. They're not blockers anymore, even though some details remain to be filled in.

Now the things I think are genuinely blocking and haven't been fully resolved:

This is the central protocol commitment but I haven't been concrete about how it's wired. Specifically:

The "operator-as-MCP-server" design from earlier turns implies the kernel hosts a server. But the kernel also needs to call into other MCP servers (filesystem, git, custom tools) that agents need access to. So the kernel is both client and host.

This dual role has implementation specifics that need locking: how does the kernel's MCP server expose itself (stdio, SSE, HTTP)? How do agents discover it? How does the kernel manage MCP client connections to other servers? What's the tool-routing logic when an agent calls a tool — is it a kernel-hosted operator-interaction tool, or is it a tool from another MCP server the kernel is proxying?

This is a genuine blocker because the entire chat-over-MCP protocol depends on it working. Without a clear implementation plan, you can't write the kernel-side code that agents talk to.

To unblock: write a specific design doc for the kernel's MCP architecture. Probably a day's work to get it right; it needs to cover server hosting, client connection management, tool registration, and routing.

How does LLMKernel actually launch agents? This matters because:

This is real engineering work that I've waved at but not specified. Is the daemon (Rust) doing this, or is LLMKernel doing this directly via Python's subprocess module? If the latter, the daemon I've been mentioning sometimes doesn't really exist for v1.

To unblock: decide whether v1 has a separate daemon or whether LLMKernel manages agents directly. For v1 simplicity, I'd argue: LLMKernel manages agent subprocesses directly; no separate Rust daemon. The daemon is a v2 separation if needed.

I've referenced chroot, bubblewrap, and zones throughout but haven't said what v1 actually does. There are real options:

For v1, I'd argue subprocess isolation with working directory is enough. Operators are sophisticated; they'll run agents with `--allowed-tools` restrictions and trust the model. Real isolation is v2.

But this needs to be explicit, and the trade-off (less safety, simpler v1) needs to be understood. Without it being explicit, you'll either over-build isolation (slow) or build something insecure that surprises you.

To unblock: lock the v1 isolation strategy; document the threat model it doesn't cover.

You're configuring agents to suppress text and use only tool calls. This depends entirely on system prompt engineering plus MCP tool availability. Specifically:

This is the kind of thing that "looks fine in demo" and "is broken in production" because real agents under real workloads occasionally drift. Without an answer, the chat-over-MCP commitment is brittle.

To unblock: write the system prompt; test it across the agents you plan to support; define the fallback behavior when text leaks through. Probably a week of iteration during v1 to get robust.

LangSmith blobs are typically full records — start to end. But cell output renders incrementally as the agent works. How do streaming runs work?

The Jupyter messaging protocol handles streaming via `update_display_data`, which can replace a previous `display_data` output. So mechanically, streaming is doable: emit a placeholder, update it as the run progresses. But the LangSmith schema needs an extension for partial records, and your renderer needs to handle update events.

To unblock: define the streaming run protocol — partial record schema, update message type, renderer expectations. Probably a few hours of design work.

I've talked about branching as "copy the file." But there are real questions:

This isn't blocking for the simplest "static branching" (operator wants to retry from a point with a fresh agent), but it's blocking for any "live branching" (operator wants to explore a path while keeping the original alive).

To unblock: define what v1 branching does. I'd argue: v1 branching is static — operator branches by saving the file, copying it, opening the copy with a fresh kernel. Simple. Live branching with running agents is v2.

Cells in your notebook aren't really "code" — they're prompts, commands, or markdown. The Jupyter notebook editor wants to treat cells as code, with execution semantics, syntax highlighting, IntelliSense, etc.

For v1, plain-text cells with no language server is fine. But the editor experience won't be great — operators just type into a textbox. Compared to Cursor's chat input, it's primitive.

To unblock: accept plain-text cells for v1; plan a custom language for v2 that gives cell autocomplete for the DSL.

For VS Code's notebook editor to use LLMKernel, there needs to be a kernelspec — a `kernel.json` file that tells Jupyter how to start the kernel. This is straightforward but needs to be done:

For your case, the kernelspec needs to specify how to launch LLMKernel with the right environment, MCP config path, working directory, etc.

To unblock: package the kernelspec as part of LLMKernel's install. Probably half a day of work.

When something breaks in v1 (it will), how do you debug it?

The LangSmith-shaped JSON gives you good observability, but only if you actually capture and surface it. Without explicit logging and a debug-view UI, you'll have a v1 that breaks and is hard to fix.

To unblock: define logging conventions early; build a basic debug view (probably just "show raw events" panel) into v1.

Your `.llmnb` files contain layout (written by the fork), agent graph (written by kernel), event log (written by kernel), cell outputs (written via Jupyter pipeline). Each has its own schema version. When schemas evolve, what happens?

Without a clear migration story, schema evolution becomes a v1.5 disaster.

To unblock: define version compatibility matrix; build the migration framework into v1 even if v1 has only one schema version. Standard pattern; low effort if done at the start.

Looking honestly:

These are real concerns but not v1 blockers.

A few things I should have flagged but didn't:

If a user has both Microsoft's Jupyter extension and your fork installed, what happens? File extension associations, command registrations, kernel discovery — all could conflict.

To unblock: explicit decision — your fork claims `.llmnb` only, leaves `.ipynb` to Microsoft. Test the coexistence scenario.

You decided desktop-only for v1, but VS Code increasingly runs in browsers (vscode.dev, github.dev, codespaces). Operators may try to use your fork there and have a bad time.

To unblock: explicit "desktop only" messaging in the extension manifest; clear error if attempted in web. Otherwise users get a confusing broken experience.

Operators install your fork from a marketplace. Then they need LLMKernel installed too. Then they need an LLM provider configured. Then they need at least one MCP-capable agent (Claude Code, OpenCode) installed. Then a working directory configured.

This is real friction. Without an installer or setup wizard, first-time experience is bad.

To unblock: minimum viable v1 has clear setup docs; v1.1 adds a setup wizard. Don't expect installs to "just work" without explicit guidance.

vscode-jupyter is MIT-licensed, so you can fork. But:

Probably MIT for everything is fine. But should be explicit, not assumed.

To unblock: decide license early; check trademark concerns (Jupyter is a trademark; using it in your project name might be restricted).

LLMKernel needs API keys for LiteLLM. Agents may need API keys too. Where do these live?

To unblock: pick a strategy; document it; test the "keys not configured" error path.

Compiling everything, here's the prioritized list:

Must resolve before week 1 starts:

Must resolve before week 2 (to write kernel code):

Must resolve before week 3 (to write extension code):

Must resolve before week 4 (during integration):

Must resolve before shipping:

The good news: most of these are small decisions or short design exercises, not engineering work. Resolving them is mostly thinking, not coding.

The bad news: there are 15 of them. If you don't budget time for them, they'll accumulate as drag during implementation — every one becomes a "wait, we never decided X" moment that pauses work for half a day.

Concrete recommendation: before starting week 1, spend 2-3 days on a design sprint that resolves these blockers as a written document. Probably half a day per blocker on average, with you and Claude Code working through them together. End state: a v1 design doc that has a section for each blocker with the decision and rationale.

That doc becomes the reference Claude Code uses during implementation. When something comes up that's not covered, it's a new decision to make explicitly, not silent drift.

Even with all 15 blockers resolved, real engineering will surface unknown unknowns:

This is normal for real software. Plan for ~20-30% of v1 time being spent on issues that aren't in this list. That's the residual that no amount of upfront design eliminates.

No, the testing infrastructure wasn't all the blockers. There are roughly 15 real ones, of which 6-7 are the kind that genuinely block code from being written if not resolved. The rest are smaller decisions that need to be made but don't gate progress as severely.

Most of them are design decisions, not engineering work. A 2-3 day pre-week-1 design sprint resolves most of them on paper. The remaining (10-15%) get resolved during implementation as concrete questions arise.

The v1 plan should explicitly include this design sprint. Without it, blockers surface mid-implementation and create drag. With it, you start week 1 with a clear v1 design doc and Claude Code has a reference for everything.

Decisions worth committing:

Want to walk through any specific blocker in more depth — the MCP server architecture inside LLMKernel, the agent process management decision, the system prompt strategy, or another? Or should we treat this as the agenda and work through them systematically?

- Architecture: subtractive fork of vscode-jupyter, LLMKernel as sole kernel, .llmnb format with embedded structures
- Protocol: chat-over-MCP with structured tool calls, agent text suppressed
- Frontend: notebook UI as primary surface, RTS map as webview tab, sidebar contributions
- Storage: tree for layout, graph for agents, JSON for chat flow, all embedded in .llmnb
- Testing: layered approach with doc-driven contracts, Markov simulation, fault injection, WebdriverIO for webviews
- File format: .ipynb-shaped JSON with metadata.rts namespace, custom MIME type for runs

- Does LLMKernel host an MCP server that agents connect to as clients?
- Does LLMKernel act as an MCP client to other servers (the daemon, third-party MCPs)?
- Both?

- Claude Code, OpenCode, etc. are subprocesses
- They need to be configured to talk to the kernel's MCP server (system prompt + MCP config)
- They need to be given a working directory (the zone)
- They need to be terminated cleanly when the kernel shuts down
- They need stdin/stdout/stderr handled (suppressing text output to operators, logging for debugging)
- They need restart logic if they crash

- Subprocess isolation only: each agent runs in a subprocess with a chosen working directory. No filesystem isolation. Simplest. Operators trust agents not to do harm outside the working dir.
- Per-zone working directory + filesystem permissions: agents run as different OS users with permissions on specific directories. Linux-only, requires user setup.
- Bubblewrap or similar lightweight namespace isolation: Linux namespaces, mount namespaces, network namespaces. More secure but more setup.
- Containers (Docker/Podman): heavier but more standard.

- What's the exact system prompt that gets agents to comply?
- How robust is compliance across different models (Claude, GPT-4, others)?
- What happens when an agent ignores the prompt and outputs prose anyway?
- How do you handle the inevitable cases where the model does both (text AND tool call)?

- Does the agent emit a "run started" record, then stream updates, then emit "run completed"?
- Are partial results renderable, or do you wait for completion?
- What if a run takes minutes (a long agent task)?

- When you branch, do agents get cloned or restarted?
- If an agent had partial state (mid-conversation), does it resume in the branch, or start fresh?
- Does the agent's working directory (zone) get copied, or do branches share a working directory?
- If shared: how do you avoid two branches' agents stepping on each other?
- If copied: how do you handle large working directories?

- What language is set on cells? (Affects highlighting, IntelliSense)
- How does VS Code's notebook editor handle cells that aren't really code?
- Do you provide a language server for your DSL, or accept plain-text cells?
- How do operators get autocomplete for @agent mentions and /commands?

- The kernelspec needs to be installable (typically jupyter kernelspec install)
- Or your fork ships it bundled
- Or your fork creates it dynamically on first use

- Where do kernel logs go?
- How do you see what messages flowed between extension and kernel?
- How do you replay a session?
- What's the trace structure for a failed cell execution?

- A v1 file opened by v1.5 fork: should migrate
- A v1.5 file opened by v1 fork: should fail gracefully
- A v1 fork opens a file written by v2 kernel: ?

- Performance optimization: not a blocker for v1. v1 just needs to work; optimization is v2.
- Cross-platform support: explicitly Linux-only for v1. Not blocking.
- Multi-agent coordination protocols: explicitly v2. Not blocking.
- Map view sophistication: a basic map (zones + agents + edges) is enough for v1. Polish is v1.5.
- Multi-operator support: v2+. Single operator is fine for v1.
- Authentication/authorization: v1 is local-only; not needed.
- Production deployment story: v1 is dogfood, not production.
- Broad agent compatibility: v1 supports Claude Code; other agents are v2.

- If you publish to OpenVSX, what license do you use?
- If you bundle LLMKernel with the fork, what's its license?
- Are there trademark concerns with using "Jupyter" in branding?

- Environment variables: works but operators have to set them up
- VS Code's secret storage: secure but per-extension
- A config file: convenient but easy to commit to git accidentally
- Inherited from shell environment: fine for development, bad for distribution

- [Blocker 1] MCP server architecture inside LLMKernel — explicit design
- [Blocker 11] Coexistence with Microsoft's Jupyter extension — explicit decision

- [Blocker 2] Agent process management — daemon-or-direct decision
- [Blocker 3] Zone/sandbox implementation strategy — locked
- [Blocker 8] LLMKernel kernelspec — packaged

- [Blocker 4] System prompt strategy for agents — drafted and testable
- [Blocker 5] Streaming tool calls protocol — defined
- [Blocker 6] Branching semantics — locked for v1
- [Blocker 10] Schema versioning framework — present from day one

- [Blocker 7] Cell language and editor integration — accepted as plain text v1
- [Blocker 9] Observability and debugging — basic logging in place

- [Blocker 12] Web environment messaging — explicit
- [Blocker 13] Installation experience — docs at minimum
- [Blocker 14] Licensing and trademarks — researched and locked
- [Blocker 15] Secrets handling — strategy chosen and tested

- Some VS Code API behavior won't match docs
- LLMKernel's existing code will have assumptions that don't hold under new use
- Agent frameworks will have undocumented behaviors that break your assumptions
- Tests will pass but real usage will reveal issues the test corpus doesn't cover
- Performance under realistic load will differ from synthetic benchmarks
- A user-visible polish issue will turn out to be a deeper architectural problem

1. Pre-week-1 design sprint of 2-3 days that resolves the blockers as a written v1 design doc.
2. The 15 specific blockers above are the agenda for that sprint.
3. The doc becomes the reference for implementation; updates to it are real changes, not silent drift.
4. Plan for 20-30% surprise time in the v1 schedule for unknown unknowns.

