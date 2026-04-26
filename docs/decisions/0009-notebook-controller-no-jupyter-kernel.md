# 0009. VS Code NotebookController API used; no Jupyter kernel, no Python runtime

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** LOCK-IN

## Context

The chat window is V1's actual differentiator (chapter 05), and once the chat window is the differentiator the question becomes what kind of container holds it. The notebook metaphor is structurally isomorphic to a chat-over-MCP transcript: a sequence of turns with rich per-turn output, mixed content types, re-executable history, and a persistent file-shaped representation. Cells have already solved — over a decade of refinement in the data-science world — most of the UI problems a structured-event chat surface would otherwise have to reinvent (mixed MIME content, streaming output, multi-cell selection, persistent diffable file format, familiar keybindings).

But the cell paradigm and the Jupyter *kernel* are separable concerns. A live Jupyter kernel imports four problems V1 does not need:

- A protocol bridge: the extension would speak Jupyter messaging over ZeroMQ to the kernel while the kernel speaks MCP to the daemon. Two protocols, two state models, glue between them.
- Python expectation collision: the moment "kernel" surfaces in the UI, users expect to type Python and get back DataFrames. Cells in V1 are messages addressed to agents, not code.
- Kernel discovery and selection ceremony: real notebooks force a kernel pick before any work happens. V1 has nothing to pick — there is one kind of cell.
- Subprocess management: starting, stopping, restarting, and crash-recovering a kernel process is real engineering for zero gain.

VS Code itself separates these concerns. The platform's notebook UI is decoupled from Jupyter — the `NotebookController` API lets an extension register a controller, declare which file extensions it handles, and provide a TypeScript callback that runs when a cell is executed. Microsoft already uses this for Polyglot Notebooks and .NET Interactive. The substrate is generic; Jupyter is one consumer of it.

## Decision

**Build V1 on VS Code's `NotebookController` API, with no Jupyter kernel and no Python runtime.**

The cell paradigm is kept; the kernel is dropped. Cells are conversation units, not code units. The extension registers a `NotebookController`, and `executeHandler` runs as a TypeScript callback inside the extension host: it reads the cell input, dispatches over the daemon's transport, streams structured events back as cell output via `NotebookCellExecution.appendOutput`, and marks the cell complete when the agent reports done. There is no ZeroMQ, no Jupyter messaging, no external kernel process, and no language runtime. Cell input is a thin DSL over free text (`/spawn`, `@agent`, markdown); cell output is a stream of typed MCP events rendered by custom MIME renderers.

## Consequences

- **Positive: protocol bridge collapses to a function call.** What would have been "kernel translates Jupyter messaging to MCP" becomes a TypeScript dispatcher inside the extension. One protocol, one state model, no glue.
- **Positive: no Python expectation collision.** Without a kernel selector or `In[1]:` prompt, users do not expect a REPL. The cell is shaped by what V1 actually defines it to be.
- **Positive: zero kernel-discovery ceremony.** Opening an `.llmnb` file is ready for input; no kernel-picker step.
- **Positive: no kernel subprocess to manage.** Starting, stopping, restarting, and crash-recovering a kernel is removed from V1's operational surface entirely.
- **Positive: cell semantics are V1's to define.** Re-execution can mean "branch from here" or "resend without branching" rather than "re-run code with current kernel state." V1 is not bound by what kernels do.
- **Negative: lose any future Python-cell-execution use case.** If V2 ever wants real code execution inside a cell (e.g., the operator scripts a multi-agent workflow), it has to be added back deliberately — likely through a separate controller, not by re-introducing Jupyter.
- **Negative: outside the native notebook ecosystem.** No nbdime out of the box, no JupyterLab compatibility, no jupytext. Acceptable because the file is a conversation, not a notebook.
- **Follow-ups:**
  - DR-0011 makes this mechanical: the subtractive fork of `microsoft/vscode-jupyter` deletes the Python integration entirely, leaving the notebook editor and cell semantics — the exact surface area `NotebookController` consumes.
  - DR-0014 pins the storage shape (`.llmnb` as `.ipynb`-shaped JSON with three embedded structures: layout tree, agent graph, chat flow).

## Alternatives considered

- **Keep the Jupyter kernel as a fallback, with MCP bridge logic inside it.** Considered seriously in turn-080 as the first sketch ("kernel-as-MCP-server"). Rejected in turn-082 once the protocol-bridge cost was visible: two protocols and the maintenance liability of keeping them aligned, plus the Python-expectation collision and kernel-management overhead. The bridge is a permanent maintenance liability for zero functional gain.
- **Build a custom mini-kernel (TypeScript or Rust) speaking Jupyter messaging.** Reinvents what `NotebookController` already provides natively. Rejected — pure cost, no benefit.
- **Webview-only chat panel, no notebook UI.** Loses every cell affordance V1 wants for free (cell selection, re-execution, persistent file format, mixed MIME output, familiar keybindings). Rejected — the notebook substrate is the point.
- **Use the Jupyter extension as-is and ship cells that contain Python wrappers calling daemon APIs.** Considered briefly in turn-080. Rejected — bakes Python and kernel-selection ceremony into the operator surface for what is fundamentally not a code-execution use case.

## Source

- **Source merged turn(s):** 067, 070 (in phase 06)
- **Raw sub-turns:**
  - [turn-080-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-080-assistant.md) — first sketch of forking vscode-jupyter, kernel-as-MCP-bridge proposal, recognition of structural fit between notebook UI and chat-over-MCP.
  - [turn-082-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-082-assistant.md) — the kernel-drop: keep cells, drop Jupyter kernel, use VS Code's `NotebookController` API directly. Architecture lock for DR-0009.
  - [turn-084-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-084-assistant.md) — synthesis of the substrate stack, layer-by-layer role of `NotebookController` in the final design.
- **Dev guide:** [chapter 06](../dev-guide/06-vscode-notebook-substrate.md)
