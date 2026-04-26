---
turn_id: 092
merged_turn_id: 078
role: assistant
phase: 07-subtractive-fork-and-storage
source_lines: [9501, 9832]
source_sha256: 8d6cfe83eaffb76637e88371caab2a86a158147a2a3b9c694261c24e3e589adc
char_count: 25320
---



## Assistant

Now the constraints are sharp and the design clarifies into something with a clear shape. Let me work through what falls away and what remains, because the subtractive frame produces a meaningfully different fork than the additive one I was sketching.

Subtractive forking has a different character than additive. Additive forks tend to bloat: the original codebase plus your additions, with everything fighting for attention. Subtractive forks have a clarifying property: every line that survives is there because it earned its place by serving the new purpose. The fork ends up smaller than the original, more focused, with a clearer thesis.

For vscode-jupyter, subtractive is the right call because most of what's there is not relevant to your use case. Python environment management, IPyKernel injection, remote Jupyter server discovery, Anaconda integration, conda detection, IPyWidgets rendering pipeline, the Interactive Window, the data viewer, the variable viewer, the plot viewer, debug-by-line for Python, the entire Python-extension integration layer — none of these serve LLMKernel-as-sole-kernel.

What's left after the cuts is: a notebook editor that opens .rts.ipynb files and runs them against LLMKernel, with custom MIME rendering for LangSmith-shaped events, and a map view as a separate tab. That's a much smaller artifact than the original extension, and the shape is right.

Let me enumerate, because the cuts are the substance of the architectural decision:

Kernel discovery and selection. Upstream supports finding kernels in many places: Jupyter kernel specs, Python environments via the Python extension, remote Jupyter servers, conda envs. With LLMKernel as the sole kernel, you delete all of this. The kernel is hardcoded; there's no picker, no discovery, no selection logic. Saves substantial code in the `kernels` directory and removes the entire dependency on the Python extension.

Python extension integration. Upstream coordinates with `ms-python.python` for environment management, interpreter selection, ipykernel installation, and Python language services. None of this applies to LLMKernel. The fork drops the Python extension as a dependency entirely. This removes complex initialization code and a substantial inter-extension communication layer.

Remote Jupyter server support. Connecting to remote Jupyter servers, the URI provider system, the server-discovery UI — all gone. RTS notebooks run locally with LLMKernel; remote work is something different (handled at the daemon/SSH layer, not the kernel layer).

IPyWidgets. The IPyWidgets bridge is a large, complex subsystem for rendering interactive widgets defined in Python. RTS doesn't use it; you have your own rendering via custom MIME types. Cut it.

The Interactive Window. Upstream supports a split-editor view with a notebook on one side and a Python file on the other for "send to interactive." Not relevant to RTS. Cut.

Variable Viewer, Data Viewer, Plot Viewer. These are webview-based features specific to data-science workflows. RTS doesn't have variables in the Python sense; doesn't have dataframes; doesn't have matplotlib plots. Cut.

Notebook debugging. "Run by line," debug by cell — these are Python debugging features. LLMKernel doesn't need them. Cut.

Export/import beyond .ipynb. Upstream supports converting notebooks to HTML, PDF, Python scripts, etc. via nbconvert. RTS files don't need most of these. Maybe keep export-to-Markdown for sharing transcripts. Cut the rest.

The web environment. Upstream targets both desktop (Node) and web (web worker) VS Code. RTS is desktop-only for v1; the entire `*.web.ts` codebase can be deleted. This alone is a substantial reduction.

IntelliSense for notebooks. Upstream provides language services for cells (autocomplete, hover, go-to-definition). LLMKernel cells aren't Python in the conventional sense; they're prompts and structured commands. Cut the language-service integration; you'll provide your own completion for the DSL if you want it.

Notebook diff tool. Maybe keep this — it's useful for git diffs of `.rts.ipynb` files. Honest assessment: probably keep, it's relatively self-contained and useful.

Conda environment activation, kernelspec installation flows, troubleshooting commands for Python issues. All gone — there's no Python ecosystem to integrate with from the fork's perspective.

The kernel picker UI. Removed entirely. RTS files have one kernel; selection is automatic.

Most of the notebook controller's flexibility for non-Python kernels. Upstream has paths for Julia, R, .NET Interactive, etc. Cut. LLMKernel is the only kernel.

What remains after these cuts is, roughly:

That's a small percentage of the original codebase. The fork becomes lean.

This is a strong choice and worth examining specifically because it changes how renderers work and what LLMKernel emits.

LangSmith's tracing format (and similar formats from Langfuse, OpenTelemetry GenAI, OpenInference, etc.) is a structured representation of LLM/agent events that's becoming standardized. The shape:

Different providers structure these slightly differently but the core abstractions (typed runs, hierarchical tracing, structured I/O) are convergent. The OpenTelemetry GenAI semantic conventions are pushing toward standardization.

Using this format as your I/O is genuinely smart for several reasons:

Familiar to developers building with LLMs. Anyone using LangChain, LangGraph, LlamaIndex, OpenInference, or just structured logging with their own LLM apps has seen this shape. The cognitive cost of "what does this event mean" is low.

Composable with existing tooling. Operators can pipe RTS event streams into LangSmith, Langfuse, Phoenix, Arize, or any observability tool that ingests this format. Your fork becomes part of an ecosystem rather than a silo.

Standardized enough to be a real protocol. You're not inventing a format; you're picking one that's increasingly canonical. Future agents and frameworks that emit LangSmith-shaped output integrate naturally.

Hierarchical tracing comes for free. The `parent_run_id` field gives you nested operations: an agent run contains tool calls, which contain LLM calls, which contain prompts. The map view can render this hierarchy; the cell output can render it; both speak the same data.

Distinguishes types naturally. `run_type` gives you the categorical distinction you need for type-specific renderers. Tool runs render one way; LLM runs render another; agent runs another.

Errors are first-class. Failed runs have `error` populated; renderers can show errors distinctively without requiring a separate error event type.

It's JSON. Trivially serializable, debuggable, queryable. Operators can `jq` event streams. Persistence is just newline-delimited JSON or a simple log structure.

Practically, this means: LLMKernel emits LangSmith-shaped run records as kernel output. The fork's MIME-type renderers consume them. The map view consumes them. The persistence layer stores them.

The existing Jupyter MIME-type system is good for this; you just rename and re-purpose it.

Standard Jupyter MIME types include `text/plain`, `text/html`, `application/json`, `image/png`, etc. — content-format-oriented. Your repurposed scheme is event-type-oriented:

The renderer registration is the same as upstream's — VS Code's renderer extension API — just with your MIME types. Renderers receive the JSON blob and produce DOM. Standard pattern.

The simplification: instead of inventing many fine-grained MIME types, you can have one primary MIME type (`application/vnd.rts.run+json`) and dispatch within the renderer based on `run_type` and tags. Fewer renderers to register; more flexibility within them. The renderer is a state machine over the LangSmith schema rather than a separate component per event type.

I'd argue for the consolidated approach: one renderer for application/vnd.rts.run+json that handles all run types via internal dispatch. Simpler to maintain; easier to extend (add a new `run_type` and the renderer's dispatch handles it without registering anything new). This matches how LangSmith's own UI handles arbitrary runs.

Making the map view a separate tab (rather than a sidebar panel or embedded in the notebook editor) is a clean choice. Specifically:

A VS Code "tab" in this context is most likely a custom editor or a webview panel that opens in the editor area. Not a sidebar (those are narrower and constrained); not a panel (those are the bottom-of-screen output/terminal area). The editor area, where notebooks open, is where the map should live too.

This means:

This is the right placement for the map. It treats the map as a peer to the notebook, not a subordinate. The operator's normal "split editor" workflow gives them the dual-view layout. They can close the map and just use the notebook; they can have multiple maps open for different workspaces; standard editor behavior.

The implementation is via the Custom Editor API or the Webview Panel API, depending on whether the map is tied to a file or is a free-floating view. For RTS, I'd argue:

The map is a webview panel, not a custom editor. Reasons:

Webview panels open in tabs but aren't tied to files. Standard pattern. ~150 lines of TypeScript for the registration and lifecycle, plus the webview content (HTML/JS for the actual map rendering).

The communication is: webview panel posts messages to extension host (operator clicks), extension host posts messages to webview (state updates from kernel). The extension host is the bridge between kernel state and the map's rendering.

The fork is, essentially, the notebook editor + a webview panel for the map + sidebar contributions + custom MIME renderers. Everything else is cut. The kernel does the work. The fork is a presentation layer.

With the subtractive frame and LangSmith I/O, cell content has a specific shape:

Cell input: prompts to the agent system, in some DSL. Free text is interpreted as a user message to the active agent. `@agent` mentions route. `/commands` invoke RTS operations directly. Markdown cells are documentation.

Cell output: a stream of `application/vnd.rts.run+json` blobs as the kernel processes the cell. Each blob is rendered by your single renderer based on its `run_type`:

Streaming is handled by `application/vnd.rts.run-update+json` blobs that update an in-progress run's state. The renderer maintains an in-progress UI that updates as new updates arrive.

The notebook file format remains `.ipynb` JSON. Cells store their executed outputs, which are arrays of MIME-typed displays. For RTS, those displays are the LangSmith blobs. The file is human-readable and grep-able because it's still JSON.

Worth being explicit: with LangSmith-shaped events and `.ipynb` cells, there are two persistence layers:

The notebook file (`.rts.ipynb`): stores the cell sequence, including executed outputs. This is the durable record of the conversation. Operators see it as a file; they can version-control it, share it, edit it.

The kernel's runtime log: as runs happen, LLMKernel can also persist them to a side file (newline-delimited JSON of all runs, including hierarchical structure). This is the event log for debugging, replay, and audit. It's separate from the notebook file and can be much more detailed.

The notebook file is what operators see; the kernel log is what debugging uses. Both are LangSmith-shaped JSON. Same format, different scopes.

This separation lets you keep the notebook file clean (only the cell-level content) while still having full event-level fidelity in the side log.

Keeping clear which is which:

Cut entirely:

Repurposed:

Added new:

This split makes the fork's identity clear: it's a lean notebook editor for LangSmith-shaped agent transcripts, with LLMKernel as the runtime and a map view as the secondary surface.

Subtractive forks have a meaningfully different maintenance profile than additive ones.

Less to track upstream. Microsoft's vscode-jupyter ships frequent changes to all the things you've cut: Python integration improvements, IPyWidgets fixes, remote-server features, etc. If you've cut those subsystems, you don't have to merge their updates. Only the parts you've kept need to track upstream.

Smaller surface for breaking changes. When VS Code's APIs change, the cut subsystems can't break because they don't exist. Only the kept subsystems can break. The fork is more stable against external churn.

Easier to reason about. The codebase is smaller. New contributors (or future-you) can understand it. The behavior is predictable because there's less of it.

Harder to reverse cuts later. If you ever decide "actually, we want remote Jupyter server support back," you have to either re-merge that subsystem from upstream or reimplement it. This is a real cost; subtractive choices are less reversible than additive ones. But for your case the cuts are unlikely to want reversing.

Forking ethics. A heavily subtracted fork is, in practice, a different product. The naming, the audience, the use case are all different. You're not "an alternative Jupyter extension"; you're "an LLM-orchestration notebook environment." The clearer that distinction, the better for everyone.

A few risks worth naming:

Upstream contribution flow becomes one-directional. You won't be sending pull requests back to vscode-jupyter — your changes are too divergent. This is normal for hard forks but worth acknowledging.

Operators who try to use it as a generic notebook editor will be disappointed. The fork is `.rts.ipynb`-specific, opinionated, and doesn't do the things they'd expect from a Jupyter extension. The naming and documentation need to make this very clear so people don't install it expecting normal Jupyter behavior.

Some cuts will hurt later. You'll occasionally miss something — IPyWidgets for some interactive UI, a debugger for the kernel itself, something else. Re-adding cut subsystems is real work. Plan for surprises.

The .ipynb format choice constrains things. Sticking with `.ipynb` JSON gives you tooling compatibility but also commits you to its quirks (multiline JSON strings as arrays, base64-encoded outputs, etc.). If you ever want a custom format, that's a future migration.

LangSmith format isn't fully standardized. The format is converging but not unified. You're picking a canonical shape; future events from other providers may not exactly fit. You'll need a normalization layer that maps various provider outputs into your canonical schema. Manageable but non-trivial.

Tracking upstream's bug fixes selectively is annoying. When Microsoft fixes a bug in the kept subsystems, you need to identify it and merge it. Subtractive forks need a discipline of "regularly review upstream's recent commits, cherry-pick relevant fixes." A few hours per month, ongoing.

These are the costs of the approach. None is a dealbreaker.

If you're committing to the subtractive fork, here's a specific list of directories and files to delete (or set aside) early:

Delete entire directories:

Delete files:

Keep with modifications:

Add new:

This is rough; the real exercise is going through the codebase with this lens and making informed cuts. Probably 2-3 days of focused work to do the major reductions, with smaller cleanups continuing for another week.

The result: a fork that's maybe 30-40% the size of the original, with a clear structure, focused purpose, and lean maintenance burden.

A focused statement:

The fork is a lean LangSmith-aware notebook editor that runs LLMKernel cells, with a map view tab for spatial agent supervision. Operators write prompts and structured commands in cells; LLMKernel processes them and emits LangSmith-shaped run records; the fork renders those records inline (in cells) and spatially (in the map). The conversation persists as a `.rts.ipynb` file. There's no Python ecosystem integration, no remote kernels, no widgets, no debug-by-line — just the notebook + LLMKernel + map view, refined.

This is small enough to ship. The total fork size after subtraction is maybe 30k-40k lines of TypeScript (down from 100k+), most of which is unchanged from upstream and just inherited. Your additions are a few thousand lines of focused new code. Maintenance is tractable. Upstream tracking is selective.

Subtractive forking is the right approach for what you're doing. The vscode-jupyter codebase has substantial value for the parts you keep (notebook editor, kernel protocol, MIME renderer infrastructure, webview pattern) and substantial drag in the parts you'd cut. The cut-list is large but well-defined.

LangSmith-shaped JSON as the I/O format is a smart choice that aligns with where the LLM-tooling ecosystem is heading, simplifies your renderer to a single dispatching component, and gives you composability with observability tools.

LLMKernel as the sole kernel removes a significant fraction of upstream's complexity (discovery, selection, multi-language support) and makes the fork's purpose clear.

The map view as a tab (webview panel in the editor area) is the right placement — peer to the notebook, splittable, focused.

The total v1 work is roughly: 1 week to do the cuts and fork, 1 week to wire LLMKernel and the LangSmith renderer, 1 week to build the map view tab, 1 week of polish. Four weeks for a focused, lean, working tool with a clear identity.

Decisions worth locking before starting:

Want to dig into the LangSmith schema specifics, the renderer's internal dispatch design, the cut list with specific commit hashes to subtract from, the map-view webview's communication protocol, or the file format details for `.rts.ipynb`?

```json
{
  "id": "uuid",
  "trace_id": "uuid",
  "parent_run_id": "uuid",
  "name": "string",
  "run_type": "llm | tool | chain | retriever | agent | embedding",
  "start_time": "ISO8601",
  "end_time": "ISO8601",
  "inputs": { ... },
  "outputs": { ... },
  "events": [...],
  "tags": [...],
  "metadata": { ... },
  "error": null | { "message": "string", "stack": "string" }
}
```

```javascript
┌──────────────────────────────────────────────────────────────┐
│ VS Code (with your forked LLMKernel-only Jupyter extension)  │
│                                                              │
│  Editor area:                                                │
│    [ notebook tab: .rts.ipynb ]  [ map view tab: webview ]   │
│                                                              │
│  Sidebar (Activity Bar):                                     │
│    [ RTS: zones tree | agents tree | recent activity ]       │
│                                                              │
│  Status bar:                                                 │
│    [ active agent count | pending approvals ]                │
└────────────────────────────┬─────────────────────────────────┘
                             │ kernel protocol (ZeroMQ)
                             │ + custom messages for map state
┌────────────────────────────▼─────────────────────────────────┐
│ LLMKernel (Python)                                           │
│                                                              │
│  Emits LangSmith-shaped JSON blobs as run events             │
│  Manages agents, zones, MCP integration                      │
│  Persists conversation history (the .ipynb file is the       │
│   transcript; raw runs may also persist as side files)       │
└──────────────────────────────────────────────────────────────┘
```

- The notebook editor integration (cells, output, persistence)
- The kernel protocol implementation (ZeroMQ message handling)
- The MIME-type renderer extension API
- The webview infrastructure for custom panels (map view will use this)
- The .ipynb JSON serialization
- Basic notebook diff support (optional)
- The desktop entry points

- application/vnd.rts.run+json — a complete LangSmith-shaped run record (any run_type)
- application/vnd.rts.run-update+json — a streaming update to an in-progress run (partial input/output, status change)
- application/vnd.rts.permission-request+json — operator-action-required event (which is just a run with run_type "tool" and a specific name like "request_approval", but rendered specially)
- application/vnd.rts.map-event+json — map-view-specific events (zone state changes, agent spawns)

- Operator opens .rts.ipynb notebook → notebook tab appears in editor area
- Operator runs "RTS: Open Map" command → map view tab appears in editor area, alongside the notebook tab
- Operator splits the editor area horizontally → notebook on the left, map on the right
- Both tabs are first-class editor surfaces; either can be the active focus

- The map's content is derived from kernel state, not from a file
- One map view per session, not one per file
- The map represents the current world (zones, agents, activity), not a saved document
- Operators don't "save the map"; they save notebooks

- llm runs render as messages/text from the model
- tool runs render as collapsed structured-call cards (with type-specific UI for permission requests, approvals, etc.)
- chain runs render as nested expandable trees
- agent runs render as a status header
- error runs render as red alert blocks

- Python environment management
- Kernel discovery and selection UI
- Remote Jupyter server support
- IPyWidgets bridge
- Interactive Window
- Variable, data, plot viewers
- Notebook debugging
- Web environment
- Conda integration
- Most of the IntelliSense layer

- MIME types (renamed to application/vnd.rts.*, repurposed for LangSmith blobs)
- Notebook editor integration (now only handles .rts.ipynb and uses LLMKernel)
- Webview infrastructure (used for the map view)
- Notebook output rendering pipeline (now consumes LangSmith blobs)
- The .ipynb JSON serialization (notebook = transcript)

- LangSmith-shaped run renderer (one MIME-type renderer with internal dispatch by run_type)
- Map view webview panel
- Sidebar Activity Bar contributions for RTS
- Custom commands for RTS operations
- Kernel-state synchronization between cells and map

- src/interactive-window/ — Interactive Window
- src/webviews/extension-side/variablesView/ — Variable viewer
- src/webviews/extension-side/dataViewer/ — Data viewer
- src/webviews/extension-side/plotting/ — Plot viewer
- src/standalone/intellisense/ — IntelliSense
- src/standalone/notebookExtensibility/ — Some extensibility might survive; review
- src/platform/interpreter/ — Python interpreter discovery
- src/kernels/jupyter/ — Jupyter server support; review carefully
- src/kernels/raw/ — Maybe keep partially (kernel launching), cut discovery

- Anything matching *.web.ts — entire web environment
- src/standalone/api/ — selectively, since you may want to keep simple API exposure
- Various Python-extension-coordination files in src/platform/

- src/notebooks/ — the core notebook editor integration (this is what you're building on)
- src/kernels/ execution/messaging code (handles the kernel protocol)
- src/platform/common/ — shared utilities
- src/platform/api/ — base extension scaffolding

- src/rts/ — your additions: map view, RTS commands, sidebar, custom renderers

1. Subtractive fork strategy. Cut aggressively; keep only what serves the RTS use case.
2. LLMKernel is the only supported kernel. Hardcoded; no kernel selection UI; remove kernel discovery.
3. .rts.ipynb is the file extension. Compatible with .ipynb JSON tooling; signals RTS-specific.
4. LangSmith-shaped JSON as the I/O format. One canonical schema for runs, with run_type dispatch.
5. MIME types repurposed but minimal. Probably one primary MIME type (application/vnd.rts.run+json) with internal dispatch, plus a streaming-update variant. Not a separate MIME per event.
6. Map view as a webview panel in a tab. Editor area, peer to the notebook, splittable. Not a sidebar.
7. Desktop-only. Cut the entire web environment.
8. Cut the Python extension dependency. No coordination with ms-python.python.
9. Cut IPyWidgets, Variable Viewer, Data Viewer, Plot Viewer, Interactive Window. Pure removals.
10. Keep notebook diff support. Useful for git workflows; relatively self-contained.
11. Persistence in two layers: .rts.ipynb for cell-level transcript, side log for full run-level event stream.
12. Sidebar Activity Bar contribution for RTS. Zones, agents, recent activity.
13. Custom commands for RTS operations. Spawn agent, transfer zone, branch, etc.
14. OpenVSX as the publishing target. Sidesteps Microsoft Marketplace concerns.

1. Subtractive cut-list confirmed: kernel discovery, Python extension integration, IPyWidgets, Interactive Window, Variable/Data/Plot viewers, web environment, IntelliSense, debugging, remote-server support all cut.
2. LangSmith-shaped JSON is the canonical run format.
3. One primary MIME type (application/vnd.rts.run+json) with internal dispatch by run_type. Plus a streaming variant.
4. Map view as a webview panel in the editor area. Tab-style; peer to notebook.
5. .rts.ipynb as the file extension. .ipynb-shaped JSON; RTS-specific marker.
6. OpenVSX publishing target. Not Microsoft Marketplace.
7. Desktop-only. Cut the web environment.
8. Cut Python extension dependency entirely. Standalone.
9. Persistence: notebook file for cell-level, side log for run-level.
10. Total scope: 4 weeks for v1.

