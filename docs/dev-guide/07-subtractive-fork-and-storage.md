# 07. Subtractive fork, LLMKernel scope, and storage design

## Purpose

Decide what survives the fork of vscode-jupyter and how the surviving data is structured. Four lock-ins follow: a subtractive method, a single hardcoded kernel, three storage shapes embedded in one file, and a feasibility assessment that V1 is shippable with Claude Code as collaborator.

## Subtractive method (DR-0011)

Work backwards from vscode-jupyter. Delete what does not serve LLMKernel-as-sole-kernel; do not add subsystems that the original lacks. The surviving codebase earns every line by serving the new purpose. The fork ends up smaller than the original, with a clearer thesis and a leaner maintenance profile.

Most of vscode-jupyter does not apply. The cut list is the substance of the architectural decision, not a side effect of it.

Cut entirely:

- Python environment management. No interpreter selection, no ipykernel installation, no coordination with the `ms-python.python` extension. The fork drops the Python extension as a runtime dependency.
- Kernel discovery and selection. No kernel specs, no environment scanning, no remote Jupyter URI providers, no kernel picker UI.
- Remote Jupyter server support. RTS notebooks run locally against LLMKernel; remote work belongs to the daemon and SSH layer, not the kernel layer.
- IPyWidgets. The widget bridge is a large, complex subsystem for rendering Python-defined interactive widgets. Cell rendering uses custom MIME renderers (see [chapter 06](06-vscode-notebook-substrate.md)) instead.
- The Interactive Window. Send-to-interactive workflows do not apply.
- Variable Viewer, Data Viewer, Plot Viewer. Webview features tied to data-science workflows. There are no Python variables, no dataframes, no matplotlib plots in the V1 surface.
- Notebook debugging. Run-by-line and cell-level debugging are Python tooling features.
- Most non-Markdown export paths. nbconvert export to HTML, PDF, and Python scripts is irrelevant. Markdown export may survive for transcript sharing.
- The web environment. Anything matching `*.web.ts` and the entire web-worker target. V1 ships desktop-only.
- IntelliSense for notebook cells. Cells are prompts and structured commands, not Python; the language-service integration goes.
- Conda activation, kernelspec installation flows, troubleshooting commands for Python issues. None of the Python ecosystem integration applies.

Keep, possibly with modifications:

- The notebook editor itself. Cell creation, editing, output rendering, the document model, persistence to JSON. This is the core of what is being inherited.
- The kernel-protocol message machinery. Even though there is no real Python kernel, the Jupyter messaging vocabulary (execute_request, status, display_data) is the wire format LLMKernel speaks back to the editor.
- The MIME-type renderer extension API surface. Renderers register, receive a JSON blob, produce DOM. This is exactly what the LangSmith-shaped run renderer needs.
- Webview infrastructure. The map view ships as a webview panel; the panel registration, lifecycle, and message passing are inherited.
- The `NotebookController` API surface. One controller, one kernel, no selection.
- The `.ipynb` JSON serialization path. Reused with extensions; see the storage section below.
- Notebook diff support. Useful for git workflows; relatively self-contained; cheap to keep.

Subtractive forks have a meaningfully different maintenance profile than additive ones. Less to track upstream because the cut subsystems cannot break. Smaller surface for VS Code API churn. Easier to reason about because the codebase is smaller. The cost is reduced reversibility: re-adding a cut subsystem later is real work. For the surviving thesis (LLM-orchestration notebook environment, not generic Jupyter alternative), the cuts are unlikely to want reversing.

Upstream contribution becomes one-directional. The fork is too divergent to send pull requests back to vscode-jupyter. Operators who try to use it as a generic notebook editor will be disappointed; the naming and documentation must make this distinction clear. Selective cherry-picking of upstream bug fixes in the kept subsystems is an ongoing tax of a few hours per month.

The result is a fork in the range of 30-40% the size of the original by line count, with a focused identity: a lean notebook editor for LLM-agent transcripts that runs LLMKernel and exposes the RTS map as a peer surface.

## LLMKernel as sole kernel (DR-0012)

LLMKernel is the only execution target. It is hardcoded. No kernel selection ceremony, no kernelspec hunting, no discovery code paths.

Why this works for V1: there is exactly one possible execution target. A picker that shows one option is friction without information. Discovery code that scans for absent Python interpreters and remote servers is dead code that runs on every notebook open. Selection logic that resolves between competing kernels is a state machine for a system with one state.

Why discovery would be churn: kernel discovery is a substantial fraction of upstream's complexity, threaded across `src/kernels/`, the Python extension API surface, the URI provider system, and several UI flows. Keeping any of it means keeping its dependencies, its initialization timing concerns, and its error states. Cutting it is cleaner than reducing it.

The notebook controller is registered for the `.llmnb` file type with LLMKernel as its only kernel. Cells dispatch to it without ceremony. The status bar shows kernel state but no picker. The command palette has no "Select Kernel" entry for these documents.

This decision compounds with [DR-0009](06-vscode-notebook-substrate.md) (use NotebookController, no Jupyter kernel). Where DR-0009 said "keep cell semantics, drop the kernel protocol bridge," DR-0012 says "and inside that frame, the one kernel is hardwired." Both cut machinery; they cut different machinery for different reasons.

## Storage structures (DR-0014)

Three independent structures, each with the data shape that fits its data. All three serialize as JSON inside one `.llmnb` file.

The architectural insight is to resist uniformity. Most systems default to "one storage scheme, applied uniformly." That fails because different kinds of state have different shapes, and forcing them into one structure either bloats the structure or distorts the data.

### Layout tree

The RTS map's layout is hierarchical. Workspaces contain zones. Zones contain files. Zones can contain sub-zones. Operations on layout (add a file to a zone, move a zone within a workspace, nest groups) are tree operations: traversal, subtree manipulation, cut-and-paste. Forcing a tree into a flat JSON record or a graph distorts both the data and the operations.

The layout tree is JSON-serialized but the structure is a tree. Each node carries a type tag (`workspace`, `zone`, `file`, `agent`, `viewpoint`, `annotation`), an id, render hints (position, color, hull style), and a `children` array. Saved viewpoints live as nodes too: named camera positions with optional filters and time ranges.

Tree-shaped operations the layout system supports: find by id or path, walk for rendering, insert child, remove subtree, move (re-parent), update properties, diff between layouts. These are 50 lines of TypeScript or a small library; no database is required.

### Agent state graph

Agent state is a graph. Agents have relationships: parent-child (one agent spawned another), peer (two agents collaborating), client-server (one consumes another's output), supervisor (operator approves another's actions). Configuration also forms a graph: which tools an agent has, which MCP servers it connects to, which zones it is bound to, which other agents it can communicate with. These relationships have cycles. Trees and flat JSON cannot express them cleanly.

Nodes in the graph: agents, zones (zones appear in both the layout tree and the graph because agents reference them), MCP servers, tools, the operator, files when referenced by agents.

Edges: `spawned`, `in_zone`, `has_tool`, `connects_to`, `supervises`, `collaborates_with`, `has_capability`, `configured_with`. Some are directed; some are symmetric; some carry properties (timestamp, permissions metadata).

For V1, the implementation is an in-memory graph (`graphology` in TypeScript, `networkx` in Python) with JSON persistence. No graph database. Operations are graph operations: neighbors by edge type, paths along an edge type, subgraphs within N hops, filters over node properties, mutations.

This is the canonical hypergraph model from [chapter 03](03-hypergraph-observability.md), specialized for the runtime concerns of who-spawned-what and who-can-talk-to-whom.

### Chat flow JSON

Chat flow is a sequence of cells, each cell carrying one or more LangSmith-shaped run records. The structure is fundamentally a sequence with optional tree-shaped nesting (a run can have child runs). JSON handles this natively.

A LangSmith-shaped run record has: `id`, `trace_id`, `parent_run_id`, `name`, `run_type` (`llm`, `tool`, `chain`, `retriever`, `agent`, `embedding`), `start_time`, `end_time`, `inputs`, `outputs`, `events`, `tags`, `metadata`, optional `error`. This shape is converging across LangSmith, Langfuse, OpenInference, and OpenTelemetry GenAI semantic conventions; picking it gives composability with existing observability tools and a familiar cognitive model for developers.

Each cell that has been executed has its outputs as MIME-typed displays. The custom MIME type is `application/vnd.rts.run+json` (with a streaming variant `application/vnd.rts.run-update+json`). A single renderer dispatches on `run_type` internally rather than registering separate renderers per type. Adding a new run type then requires only an internal dispatch arm.

The cell-level chat flow is what the operator sees. The full event log (including non-cell-level child runs and kernel-internal events) lives in `metadata.rts.event_log` as a JSON array of run records.

### Cross-structure references

The three structures are loosely coupled but not independent. They share IDs as the glue.

- Layout tree to agent graph: when the map renders an agent symbol, it queries the graph for status, zone, tools.
- Layout tree to chat flow: when a file's "recent activity" indicator renders, it queries the chat flow for runs that touched the file.
- Agent graph to chat flow: each run record references the agent that produced it.
- Chat flow to layout tree: when a tool call references a file, the renderer looks up the file's position in the layout tree to draw a connecting line.

Each structure is the source of truth for its own concern. The others reference it by stable id (agent ids, zone ids, file paths, run ids). No structure tries to capture everything.

### One file: `.llmnb`

The three structures embed in a single file with extension `.llmnb`. The file is JSON. Its top-level shape is `.ipynb`-conformant: `nbformat`, `nbformat_minor`, `metadata`, `cells`. RTS state lives in namespaced extensions: `metadata.rts` for layout, agents, config, and the full event log; `cells[*].metadata.rts` for cell-specific hints (trace id, target agent, branch markers); `cells[*].outputs[*]` for the cell-level chat flow as MIME-typed displays.

Why one file:

- Atomic operations. Updating a multi-structure operation (transfer a file from zone A to zone B touches the layout tree and emits chat flow events) writes one document. There is no partial-update window.
- No cross-file sync. Layout, graph, and chat flow live in the same JSON document; they cannot get out of sync because there is nothing to sync.
- Coherent git diffs. A change produces one diff in one file showing all the affected state. Reviewers see the full picture in one place.
- One artifact to manage. Operators understand "the conversation file." Sharing, versioning, archiving are single-file operations.
- ID resolution is local. All references resolve within the same document; no orphan references across files.
- Uniform versioning. One file format, one top-level version field, one migration path. Schema evolution is one effort, not three. Each substructure still carries its own version field for independent evolution within the file.

The cost is bounded: files grow large for very long sessions. The mitigation ladder is: V1 accept it; V1.5 truncate large cell outputs to external blobs by content hash; V2 split the embedded event log into a side file when it exceeds a threshold; V2 archival splits for sessions running over days. None of these mitigations is needed for V1.

## Why ipynb-derived

The container is `.ipynb`-shaped JSON for several compounding reasons.

Cell semantics survive. Cells, execution counts, output arrays, and metadata namespaces are exactly the model RTS needs. Inheriting them means inheriting the editor that knows how to render them.

Tooling exists. Notebook diff and merge tools (nbdime and similar) operate on this format. Git can be configured to use them via `.gitattributes`. Code review tools that render notebooks can show `.llmnb` files (they will ignore the `metadata.rts` namespace they do not understand, which is fine).

The Jupyter ecosystem provides the kernel-protocol vocabulary even though there is no real Python kernel underneath. LLMKernel speaks Jupyter messaging (status, execute_input, display_data, execute_reply) over the standard sockets, which means the inherited notebook controller can drive it without translation. This is the same point made in [DR-0009](06-vscode-notebook-substrate.md): keep the cell paradigm, drop the protocol bridge for Python expectations, but keep the wire vocabulary because it already encodes "running cell," "output arrived," "ready for next" cleanly.

The rename to `.llmnb` is deliberate. Standard Jupyter tools will not open `.llmnb` files by default (no extension association), which prevents the confusion of opening one in JupyterLab and seeing a kernel mismatch. The fork registers `.llmnb` as its file extension exclusively. The MIME type for the file itself is `application/vnd.llmnb+json`. The MIME type for run records inside is `application/vnd.rts.run+json`.

The single writer for `metadata.rts` is LLMKernel. Standard Jupyter machinery writes cell outputs (the cell-level chat flow). Layout edits initiated in the map view are sent to the kernel as custom messages; the kernel updates its in-memory state and writes the file. Two physical writers, one logical writer (the kernel is the source of truth for everything except the cell-output stream that VS Code's notebook pipeline already owns).

Snapshot strategy: the kernel writes on save (operator save or autosave), on clean shutdown, and on a 30-second timer for crash safety. Crash recovery loses at most the last 30 seconds of activity, which is acceptable for V1.

The file is a resumable session. Close it, reopen tomorrow, the kernel restores layout and graph from the embedded state and restarts agents that were active at last save. This dual nature (live mode with a kernel attached, static mode without one) inherits naturally from how Jupyter notebooks already behave.

## V1 feasibility assessment (DR-0013)

Honest assessment: a serious V1 is deliverable with Claude Code as collaborator on a calendar timeline of roughly 5-6 weeks, given tight scoping and hands-on oversight at architectural decision points.

What "serious V1" includes:

- Subtractive fork of vscode-jupyter executed against the cut list above, producing a clean, reduced codebase.
- Integration with the existing LLMKernel codebase: kernel start, cell execution, message round-trip.
- LangSmith-shaped JSON I/O and a single MIME renderer for `application/vnd.rts.run+json` with internal dispatch by `run_type`.
- Map view as a webview panel in a tab, with state synchronization to the kernel.
- Sidebar Activity Bar contributions (zones tree, agents tree, recent activity).
- Single-file `.llmnb` format with embedded layout tree, agent graph, and chat flow.
- Inline permission approvals with diff preview.
- Streaming with auto-scroll and interrupt.
- Edit-and-resend with branching by file copy.
- Three-pane mental model (stream / current / artifacts) from [chapter 06](06-vscode-notebook-substrate.md).

What V1 does not include:

- Production polish at scale. Files over a few megabytes, sessions over days, conversations with thousands of cells: V1 handles these correctly but not optimally.
- The full RFC tool taxonomy. Tool standards work is deferred to [chapter 08](08-blockers-mediator-standards.md).
- A complete fault-injection test harness. Markov simulation and fault injection are valuable but the full investment (9-10 days of infrastructure) parallelizes alongside feature work and may not all land in V1.
- Cross-notebook coordination. Each `.llmnb` is independent; agents do not span files in V1.
- Time-travel for layout. The layout tree captures current state, not history. Time scrubbing applies to the chat flow, not the map.
- Annotations on the map. Drawing arrows, highlighting regions, manual labels: deferred to V1.5.
- Layout-as-visualization-spec. Multiple named layouts per notebook (code-review view, debug view, presentation view): V2.

The fork is the most uncertain part of the schedule. Subtractive cuts surface dependencies that look innocuous but turn out to be load-bearing. Plan to spend more calendar time on the cuts than the line count suggests. The new functionality (renderer, map view, sidebar contributions, custom commands) is more predictable because each component is well-scoped and self-contained.

Phase shape:

- Week 1: planning artifact, project skeleton, fork setup, initial cuts.
- Week 2-3: parallel tracks of new functionality (renderer, map view, sidebar, kernel extensions, file-format read/write).
- Week 4: integration and end-to-end testing.
- Week 5-6: polish, edge cases, documentation, ship-readiness.

Calendar weeks, not effort weeks. Solo without Claude Code: 2-3 times longer for the same quality. Claude Code unsupervised over the same window: 60-70% of the way there with rough edges and architectural drift to fix. The amplification is real but not autonomous; the oversight is what closes the gap.

## Testing strategy

Doc-driven contract tests are the foundation. The Jupyter messaging protocol, the VS Code Extension API, the LangSmith schema, and the MCP protocol are all well-specified by their own authors. The test specification is the spec document. Walk it; for each documented message, API call, or schema field, write a test that verifies conformance. Tests cite their doc source in comments. Coverage is tracked against the docs, not the code.

This replaces "think of every case" with "walk the spec." It produces tests that are stable across refactors (they break when contracts change, not when implementations change), enumerable (the doc says what to cover), and grounded in shared specifications that resolve disagreements about correctness.

Markov-chain simulation extends the doc-driven foundation. The Jupyter protocol is a small distributed system; the kernel and the extension communicate over sockets. The kernel state machine (`starting`, `idle`, `busy`, `interrupting`, `shutting_down`, `dead`) is a Markov model. Triggers cause probabilistic transitions; transitions emit messages with timing distributions.

The simulator drives a mock kernel through generated sequences (realistic operator workflows, random valid sequences, stress sequences, adversarial sequences, replay sequences from real bugs). Property-based testing libraries (`hypothesis` in Python) check invariants across thousands of sequences: every `busy` is followed by `idle`, every request gets a reply, no two simultaneous executions, no unbounded memory growth.

Fault injection makes the mock kernel deliberately misbehave: drop messages, duplicate messages, reorder, delay, corrupt, crash mid-execution, hang, slow responses, disk-full on save. The system under test is verified to recover or fail gracefully. This is what makes lifecycle bugs (kernel crash mid-execution, save during agent operation, file close while running) testable rather than aspirational.

Lifecycle smoke tests cover the transitions that production failures cluster around: extension activation, file open, kernel start, cell execution, map view open, file save, file close, kernel shutdown, extension deactivation. Each transition has its own work item with documented acceptance criteria; each is testable in the simulator.

Cross-language coverage: a single Python mock kernel serves both Python tests (LLMKernel-side handlers connect to it) and TypeScript tests (the fork's kernel client connects to it via real sockets). One mock implementation, two test consumers.

CI cadence by layer: doc-driven contract tests and unit tests run on every commit; integration tests run before merging; Markov simulation and fault injection run nightly; stress and chaos run weekly or pre-release.

This is light treatment. The fuller testing investment (full Markov state machine, hypothesis property suite, fault injection framework, test corpus) is roughly 9-10 days of infrastructure parallelizable with feature work. The ratio of effort that lands in V1 versus V1.5 depends on calendar; the foundation (doc-driven contract tests, mock kernel, basic property assertions) lands in V1.

## What carries forward / what defers

Forward to implementation:

- The cut list is locked. Subtraction proceeds against a defined target.
- LLMKernel is the only kernel. No discovery, no selection.
- The `.llmnb` file format is locked at the structural level: `metadata.rts` namespace with `layout`, `agents`, `config`, `event_log`; cells with their MIME-typed run outputs.
- The three-structure decomposition (tree, graph, sequence) is the storage architecture.
- Doc-driven testing with Markov simulation and fault injection is the testing strategy.
- V1 is feasible on a 5-6 week calendar with disciplined scoping.

Deferred to [chapter 08](08-blockers-mediator-standards.md):

- The bidirectional MCP "paper-telephone" between the kernel and the extension as a unifying communication pattern.
- The RFC-driven tool taxonomy for chat-over-MCP. Numbered specifications for each tool the agent can call, written before implementation.
- Provisioning procedures and reliability practices in the Bell System tradition: standards before code, signed and dated documents, explicit invariants, formal review.
- The mediator role of LLMKernel: where it sits in the stack as the unifying point that translates between MCP, the kernel protocol, PTY traffic, and file-format writes.

Deferred to V1.5 and V2:

- Annotations on the map (drawing, highlighting).
- Layout-as-visualization-spec (multiple named layouts per notebook).
- Cross-notebook coordination (agents spanning multiple `.llmnb` files).
- Time-travel for layout.
- Coverage-guided sequence generation in the simulator.
- Full archival splits for very long sessions.
- Cross-conversation event tracking.

## Source turns

- [turn-091-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-091-user.md)
- [turn-092-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-092-assistant.md)
- [turn-093-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-093-user.md)
- [turn-094-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-094-assistant.md)
- [turn-095-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-095-user.md)
- [turn-096-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-096-assistant.md)
- [turn-097-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-097-user.md)
- [turn-098-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-098-assistant.md)
- [turn-099-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-099-user.md)
- [turn-100-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-100-assistant.md)
- [turn-101-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-101-user.md)
- [turn-102-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-102-assistant.md)
- [turn-103-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-103-user.md)
- [turn-104-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-104-assistant.md)
- [turn-105-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-105-user.md)
- [turn-106-assistant.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-106-assistant.md)
- [turn-107-user.md](../../_ingest/raw/phase-07-subtractive-fork-and-storage/turn-107-user.md)
