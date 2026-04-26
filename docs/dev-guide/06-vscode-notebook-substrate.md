# 06 — VS Code notebook as chat substrate

## Purpose

V1 is a VS Code extension whose primary surface is a notebook-shaped editor backed by VS Code's `NotebookController` API, with no Jupyter kernel and no Python runtime. Each cell is a turn in a structured conversation; the conversation transport is bidirectional MCP; the agent (Claude Code) communicates exclusively through MCP tool calls because its free-form text channel is suppressed at the prompt level.

This chapter locks four decisions at once. It is the load-bearing chapter for "what is V1, concretely." After this, the operator surface is no longer an open question.

## The substrate stack

```
+-------------------------------------------------------------+
| VS Code shell                                               |  host process, distribution, workspace, diff editor
+-------------------------------------------------------------+
| Subtractive fork of microsoft/vscode-jupyter                |  notebook editor UI, file persistence, cell semantics
+-------------------------------------------------------------+
| NotebookController API (no Jupyter kernel)                  |  cell.execute() handler runs inside the extension
+-------------------------------------------------------------+
| Cell-based chat surface                                     |  cells are conversation turns; outputs are typed events
+-------------------------------------------------------------+
| Bidirectional MCP (operator-as-server, agent-as-client)     |  the chat protocol; tool calls are messages
+-------------------------------------------------------------+
| Claude Code agent (text suppressed; forced tool use)        |  emits structured tool calls instead of prose
+-------------------------------------------------------------+
```

| Layer | One-line role |
| ---- | ---- |
| VS Code shell | Inherits diff API, file navigation, workspace context, terminal embedding, marketplace distribution. |
| vscode-jupyter fork | Provides the notebook editor UI and `.ipynb`-shaped persistence — without the Python integration that gets stripped in [chapter 07](07-subtractive-fork-and-storage.md). |
| `NotebookController` | The extension registers a controller; cell execution is a TypeScript callback inside the extension host. No external kernel process. |
| Cell-based chat surface | Cells replace chat messages. Re-execution means branch or resend. Cell output is a stream of typed events rendered by custom MIME renderers. |
| Bidirectional MCP | The operator daemon hosts an MCP server; the agent is its client. The agent's outbound tool calls *are* the messages to the operator. |
| Claude Code | Headless subprocess. System prompt forces tool-only output; the textual channel exists only as an internal scratchpad. |

The stack is the answer to "where does the chat live." Every layer earns its place by displacing custom work that V1 cannot afford to build from scratch.

## VS Code as host (DR-0007)

The decision to deliver V1 as a VS Code extension is recorded as [DR-0007](../../_ingest/manifests/decisions.json) and traces to the recognition (in [chapter 05](05-v1-scope-reduction.md)) that the chat window — not the framework, not the 3D map, not the policy engine — is the actual differentiator. Once the chat window is the differentiator, the question becomes: where does it live?

V1 picks VS Code, not a browser, not Electron, not a custom Chromium build. The reasoning:

**No context switch.** The operator already has VS Code open to read the code the agents are editing. A browser-based chat puts the operator in a second window, alt-tabbing to inspect diffs the agent proposes. A VS Code extension puts the chat next to the file tree, in the same shell as the editor that's about to render the agent's edits.

**The diff API is free.** When the agent calls `propose(action, diff)`, the renderer can hand the diff to VS Code's native `vscode.diff` command. The operator reviews the proposed change in the same diff editor they use for git changes. Building a comparable diff view in a webview from scratch is weeks of work and will be worse than VS Code's.

**File navigation is free.** When an agent emits a `present(artifact)` tool call referencing `src/auth/tokens.rs`, the renderer renders a clickable link that opens the file in a real editor tab. The operator does not paste paths into a separate process.

**Workspace context is free.** The extension knows what folder is open, what files are dirty, what the git status is, what the active branch is. A browser tab knows none of that without elaborate sync. The agent's tool calls can take "the current workspace" as implicit context.

**Distribution is free.** Publishing to the marketplace gets the extension on every platform VS Code supports. No installer, no auto-updater, no signing pipeline beyond what Microsoft already provides.

**Terminal embedding is free.** When V1 needs to show what an agent's subprocess printed, the extension uses VS Code's terminal API. No PTY library, no ANSI parser, no scrollback widget.

**Custom Chromium is the wrong shape.** A custom Electron build would mean writing the editor, the file tree, the diff view, the terminal, and the marketplace — all things that already exist in VS Code, all of which would land worse on the first attempt. The cost of "owning the shell" is the cost of rebuilding everything good about VS Code, badly.

**A pure web app loses too much.** The browser sandbox does not give you direct file system access without a paired native helper, so a web app already implies a daemon — at which point the simplest UI surface that talks to a daemon and renders code edits is, again, VS Code.

The constraint is real: V1 commits to operators who use VS Code (or a fork: Cursor, Windsurf, Code-OSS). That is an acceptable narrowing. The operators V1 is built for already use VS Code; serving a different population is a V2 question.

## Notebook UI without a Jupyter kernel (DR-0009)

[DR-0009](../../_ingest/manifests/decisions.json) keeps the cell paradigm and drops the kernel. The two halves of that decision were considered separately and only combined once it became clear that VS Code separates them as well.

**Why cells are the right metaphor.** A chat is a sequence of turns. A notebook is a sequence of cells. The structural isomorphism is not coincidental: both are linear-with-references, both have rich per-turn output, both support re-execution, both persist as a file. The capabilities a chat-over-MCP UI needs and gets for free from the notebook metaphor:

- Mixed content per turn (markdown, code, JSON, custom MIME-typed widgets).
- Per-cell rich output that streams incrementally.
- Re-executable history (the foundation of edit-and-resend / branching).
- Persistent file format (`.ipynb`-shaped JSON) that diffs in git, opens in any compatible viewer, and survives between sessions.
- Multi-cell selection, copy, delete — operations on conversation history are operations on cells.
- Familiar UX for technical users; the cell paradigm is an asset rather than a learning curve.

A flat chat queue UI fights every one of these. A notebook UI gets them by being a notebook UI.

**Why the kernel must go.** A Jupyter kernel is a process that speaks the Jupyter messaging protocol over ZeroMQ, executes code in some language, and returns results. Bringing a real kernel into V1 imports four problems V1 does not need:

- *Two protocols, one bridge.* If a kernel exists, the extension speaks Jupyter messaging to it, and the kernel speaks MCP to the daemon. Two protocols, two state models, glue between them. The bridge is a permanent maintenance liability.
- *Python expectation collision.* The moment "kernel" appears in the UI, users expect to type Python and get back DataFrames. The cells in V1 are not Python; they are messages addressed to agents. A live kernel selector shipping next to the cell editor poisons that intuition.
- *Kernel discovery and selection ceremony.* Real notebooks force users to pick a kernel before they can do anything. V1 has nothing to pick. There is one kind of cell.
- *Subprocess management for the kernel itself.* Starting, stopping, restarting, and crash-recovering a kernel is real engineering for zero gain.

**The escape hatch: `NotebookController`.** VS Code's notebook UI is decoupled from Jupyter. The platform exposes a `NotebookController` API: the extension registers a controller, declares the file extensions it handles, and provides a TypeScript callback that runs when a cell is executed. There is no ZeroMQ, no Jupyter messaging, no external process. The extension *is* the executor.

In V1, the `NotebookController.executeHandler` does this:

1. Reads the cell input (text or a small DSL — see "The V1 chat shape" below).
2. Dispatches to the daemon over the daemon's existing transport (the same one the MCP server uses).
3. Streams structured events back as cell output via `NotebookCellExecution.appendOutput`.
4. Marks the cell complete when the agent reports done.

That is the entire compute layer. The cell is not "code that runs in a kernel"; it is "a message dispatched to the daemon, with the agent's structured response rendered as output." Cells are conversation units, not code units.

This is the architectural payoff of the kernel-drop: the protocol bridge collapses to a function call inside the extension host. No second process, no second protocol, no glue.

## Bidirectional MCP as the chat protocol (DR-0008)

[DR-0008](../../_ingest/manifests/decisions.json) flips MCP's usual orientation. In normal MCP usage, the agent extends its capabilities by calling tools provided by external servers (filesystem, fetch, etc.). In V1, the operator daemon is also an MCP server, and the tools it exposes are not capability-extensions — they are conversation primitives.

The agent connects to the operator-MCP-server like any other MCP server. The tools it sees are things like:

- `ask(question, context, options?)` — operator-targeted question; result is the operator's answer.
- `respond(content, kind, related_to?)` — the catch-all "what would normally be a message."
- `clarify(question, options)` — typed clarification with a discrete option set.
- `request_approval(action, diff_preview, risk_level, alternatives?)` — anything the operator must approve before the agent proceeds.
- `report_progress(status, percent, blockers?)` — status update.
- `propose(action, rationale, preview?, scope?)` — anything needing approval, richer than `request_approval`.
- `present(artifact, kind, summary)` — generated content (code, plans, diffs) lifted to the artifacts surface.
- `notify(observation, importance)` — fire-and-forget annotation.
- `escalate(reason, severity)` — flag operator attention.

The agent already knows how to use tools — every modern coding model is heavily tool-use trained. When the model would have produced "Hey, should I do X?" as text, it instead calls `clarify("Should I do X?", ["yes", "no", "wait"])`, because that tool is right there and visibly intended for that use. No custom agent framework is required; a stock Claude Code subprocess connected to the operator-MCP-server does this naturally.

What the operator surface renders is *the tool calls*, not parsed text. Each tool call has a dedicated renderer: `clarify` becomes a question card with a radio picker, `propose` becomes an approval block with a diff button, `present` lifts an artifact to the sidebar, `report_progress` becomes a progress widget.

**Why this beats text streaming, concretely:**

- *Structured intent.* The agent had to commit to a category — question, status, proposal — before emitting the call. The operator surface knows what kind of thing arrived without parsing prose.
- *Attributable.* Every operator-facing event is a JSON-RPC call with a typed schema. Filtering, querying, replaying, and diffing the conversation are simple structured queries instead of LLM-based parsing.
- *Drives UI affordances directly.* Approval modals, progress bars, diff buttons, artifact links are properties of the schema, not interpretations of free text. The renderer is a switch on tool name.
- *Per-tool policy.* The operator can configure each tool independently — auto-approve `propose` calls in low-risk zones, require manual handling for `escalate`, throttle `notify` to a per-minute budget. Policy at the interaction level is the right granularity.
- *Multi-agent unification.* Three agents in three zones all calling the same tool vocabulary produce one queue with three sources, all using the same event shapes. Comparison and routing are trivial.

The bidirectionality is symmetric: the operator can also initiate by calling tools the agent exposes (its inbox, its status, its intent injection). MCP is a general communication substrate when treated that way, not just a "give the agent superpowers" channel.

## Forced tool use (DR-0010)

[DR-0010](../../_ingest/manifests/decisions.json) is the maximally aggressive form of DR-0008. The agent's textual output channel is suppressed entirely at the prompt level. The agent's only way to communicate with the operator is through the operator-MCP-server's tools.

The system prompt enforces the discipline:

> All communication with the operator must occur through the provided MCP tools. Do not produce free-form text intended for the operator. Reasoning may be expressed in your internal monologue, which is not surfaced.

The model complies with this because (a) modern instruct-tuned models follow tool-use directives well when the alternatives are clearly available, and (b) the operator-MCP-server provides a tool for every category of communication the agent might want to produce, including the catch-all `respond(content, kind="explanation")` for cases where the agent really needs prose.

What this costs the agent in the short run:

- *No conversational warmth.* The agent cannot ramble, rapport-build, or preamble. Every output is typed.
- *Tool design discipline becomes the new UX work.* Get the tool taxonomy wrong and the agent struggles to express what it wants to say. Get it right and the conversation is crisp.
- *Tool-call latency.* Each call is a JSON-RPC roundtrip. For human-in-the-loop pacing, this is invisible. For high-frequency reasoning, batch where possible.
- *Reasoning becomes invisible by default.* The agent's chain of thought is internal monologue, not surfaced. Mitigation: an optional "reasoning view" that surfaces the suppressed text on demand for debugging.

What it buys the operator surface in the long run:

- *No parsing.* The renderer never has to extract structure from prose. It dispatches on tool name.
- *No leaked thinking.* The agent's "let me think about this..." filler is internal-only. The operator sees outputs, not process.
- *Predictable affordances.* Every approval looks like an approval. Every question looks like a question. The UI is consistent because the protocol is.
- *No "is this AI talking?" feeling.* Operators interacting with structured events feel like they are operating equipment, not chatting with an AI. That framing keeps the operator in the supervisor role.
- *Exact audit and replay.* The full operator-facing transcript is a structured event log — queryable, filterable, diffable.
- *Multi-agent supervision is operable.* Reading three chat streams in parallel is unmanageable; reading one queue of typed events from three agents is straightforward.

This is an architectural commitment with no half-measure. Chat-shaped messages sitting next to structured events look weird. V1 is all-in on tool-only communication or it falls back to chat; half-and-half is worse than either. V1 commits.

## The V1 chat shape

Bringing the four lock-ins together, here is the shape of a V1 session.

The operator opens VS Code. They open or create an `.llmnb`-shaped notebook file (final extension TBD; see [chapter 07](07-subtractive-fork-and-storage.md)). The forked vscode-jupyter editor renders it as a notebook. Cells render exactly like Jupyter cells. There is no kernel selector; the extension's `NotebookController` is auto-bound to this file type.

The operator types into the first cell:

```
/spawn alpha zone:refactor task:"extract JWT validation from src/auth/tokens.rs"
```

They press Shift+Enter. The `NotebookController.executeHandler` parses the cell, sends a spawn request to the daemon. The daemon launches a Claude Code subprocess in the `refactor` zone, configured with:

- The operator-MCP-server as its sole or primary MCP connection.
- A system prompt that forces tool-only communication.
- The task as initial input.

The agent boots. It reads relevant files via its built-in tools, then begins emitting tool calls to the operator-MCP-server. Each tool call streams back to the cell as output:

- `report_progress(status="reading", files=[...])` renders as a small progress event.
- `present(artifact="plan.md", kind="plan", summary="3-step refactor")` renders as a plan widget with an "open" button.
- `request_approval(action="extract JWT validator", diff_preview=..., risk_level="medium")` renders as an approval card with an inline "Show diff" button that opens VS Code's diff editor.

The operator clicks Approve in the cell output. The renderer sends the approval back through the daemon, which returns it as the tool's result to the agent. The agent continues. More tool calls stream in. Eventually `report_progress(status="complete", artifacts=[...])` arrives. The cell is marked complete.

The operator adds a new cell below:

```
@alpha explain why you chose to extract instead of inline
```

Re-execution of an earlier cell branches. The operator selects the cell with the original spawn directive, edits the task, re-executes. The daemon snapshots the zone, branches the conversation, and runs the modified task in the new branch. Branches are notebook files (or branches-as-metadata in one file; design pinned in [chapter 07](07-subtractive-fork-and-storage.md)).

The operator never sees agent prose. Every cell output is a stream of typed events, each rendered by a renderer specific to its MCP tool name. The `.llmnb` file on disk is a complete, replayable, version-controllable record of the session.

That is V1. A notebook with cells, each cell a conversation step, agents emitting MCP tool calls that the extension renders as cell content (text segments, approval requests, tool diagrams, RTS map snapshots), with the agent's free-text channel suppressed.

## What carries forward / what defers

**Locked in this chapter:**

- VS Code is the host for V1. ([DR-0007](../../_ingest/manifests/decisions.json))
- The chat protocol is bidirectional MCP, with the operator daemon as the MCP server. ([DR-0008](../../_ingest/manifests/decisions.json))
- The cell paradigm is kept; the Jupyter kernel is dropped; cells dispatch via VS Code's `NotebookController` API. ([DR-0009](../../_ingest/manifests/decisions.json))
- Agent text output is suppressed at the prompt level; structured MCP tool calls are the sole agent-to-operator channel. ([DR-0010](../../_ingest/manifests/decisions.json))

**Deferred to [chapter 07](07-subtractive-fork-and-storage.md):**

- The exact mechanics of the subtractive fork of `microsoft/vscode-jupyter`: what to delete (Python integration, IPyWidgets, remote servers, debugging, viewers), what to keep (notebook editor, cell semantics, file persistence).
- The `LLMKernel` placement once the Jupyter kernel is dropped (the name carries forward; the role changes).
- The on-disk file format (likely `.llmnb` — an `.ipynb`-shaped JSON with three embedded storage structures: layout tree, agent graph, chat flow).
- Branch semantics — separate file per branch vs. branches-as-metadata.

**Deferred to [chapter 08](08-blockers-mediator-standards.md):**

- The exact tool taxonomy. The list above (`ask`, `respond`, `clarify`, `request_approval`, `report_progress`, `propose`, `present`, `notify`, `escalate`) is a starter set; the v1 surface is targeted at ~9–12 tools and the precise schemas are RFC discipline, not chapter-level prose.
- The system-prompt boilerplate that enforces tool-only output reliably across model versions.
- Per-zone tool policy (which tools are available in which zones; which require approval; which auto-resolve).
- Multi-agent coordination tools (`pause`, `resume`, `inject`, `redirect`).

**Carried forward implicitly:**

- The isolation model from [chapter 04](04-isolation-and-mcp-placement.md) is unchanged. Each agent still runs in its own zone with per-zone MCP servers; the operator-MCP-server is one additional connection in the agent's MCP client config.
- The hypergraph observability model from [chapter 03](03-hypergraph-observability.md) is unchanged. The structured tool-call log produced by DR-0010 is, in fact, the cleanest possible input to the hypergraph: every event is already a typed edge.
- The scope cuts from [chapter 05](05-v1-scope-reduction.md) hold. Nothing here re-adds 3D, VR, macOS, SSH, bubblewrap, live policy, or VegaFusion.

## Source turns

The decisions in this chapter were merged from the following raw turns under `_ingest/raw/phase-06-vscode-notebook-substrate/`. The phase overview lives at [`00-overview.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/00-overview.md).

- [`turn-070-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-070-assistant.md) — VS Code extension model, what aggressive intervention is and is not, MCP as the standardization layer to bet on.
- [`turn-072-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-072-assistant.md) — bidirectional MCP locked: operator-as-MCP-server, tools as conversation primitives, the radical "no text channel" version sketched.
- [`turn-074-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-074-assistant.md) — MCP as context provider, operator-MCP-server as the agent's universe, the three interpretations of "take over context."
- [`turn-076-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-076-assistant.md) — forced tool use locked: the agent has no native communication surface, all output is structured events, the chat panel disappears or becomes a debug surface.
- [`turn-078-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-078-assistant.md) — naming the architecture "chat over MCP"; tools as messages, results as responses, schemas as conversational grammar.
- [`turn-080-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-080-assistant.md) — the notebook insight: cells map onto chat-over-MCP turns; first sketch of forking vscode-jupyter, with kernel-as-MCP-bridge as the initial proposal.
- [`turn-082-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-082-assistant.md) — the kernel-drop: keep the cell paradigm, drop the Jupyter kernel, use VS Code's `NotebookController` API directly. The architecture lock for DR-0009.
- [`turn-084-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-084-assistant.md) — synthesis: the substrate stack, what each layer is for, how the brought-forward chat-quality features map onto the notebook substrate.
- [`turn-086-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-086-assistant.md), [`turn-088-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-088-assistant.md), [`turn-090-assistant.md`](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-090-assistant.md) — follow-on consolidation turns refining the rendering pipeline and the operator's input DSL.
