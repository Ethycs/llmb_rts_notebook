# 0007. VS Code adopted as unified host platform

- **Status:** Accepted
- **Date:** 2026-04-26
- **Tag:** PIVOT

## Context

DR-0006 (chapter 05) reframed the V1 product: the framework is not the question, the 3D map is not the question, the policy engine is not the question. The chat surface is the actual differentiator. Once that reframing landed, the question collapsed into a placement problem: where does the chat live?

Off-the-shelf chat UIs do not satisfy what V1 needs. The operator has to review proposed diffs, navigate to files the agent references, watch terminal output from agent subprocesses, and approve actions inline with the conversation. A browser-based chat puts the operator in a second window, alt-tabbing to inspect the very edits being discussed. Building those affordances from scratch in a webview is weeks of work that will land worse than the existing tools the operator already uses.

The unexpected fit: the operators V1 is built for already have VS Code open to read the code the agents are editing. VS Code already provides — via extension APIs that ship with the product — every affordance V1 needs: a diff editor (`vscode.diff`), file navigation, workspace context, terminal embedding, marketplace distribution, and a notebook editor surface (NotebookController) that decouples cell UI from any kernel runtime. The placement question reduces to "use the editor that is already open" and the affordance question reduces to "inherit them."

## Decision

**V1 ships as a VS Code extension. VS Code is the host platform.**

- The operator surface is delivered through extension APIs, not a separate window or process.
- Diff review uses VS Code's native diff editor; no custom diff widget is built.
- File navigation hands off to VS Code's editor tabs; no in-app file viewer is built.
- Workspace context (open folder, dirty files, git status, active branch) is read from the extension API and made implicit in agent tool calls.
- Terminal output from agent subprocesses is rendered in VS Code terminals; no PTY/ANSI stack is built.
- Distribution is via the VS Code marketplace; no installer, signing pipeline, or auto-updater is built beyond what Microsoft already provides.
- The audience is narrowed to operators who use VS Code or one of its forks (Cursor, Windsurf, Code-OSS). This narrowing is accepted, not regretted.

## Consequences

- **Positive:**
  - No context switch between the chat and the code being edited.
  - Five major UI surfaces (diff, file navigation, workspace, terminal, distribution) are inherited rather than rebuilt.
  - The notebook editor primitive (DR-0009) is already present in the host, removing the need to design a custom turn-based UI.
  - The operator is operating equipment in the editor they already use, not learning a new application.
- **Negative / cost:**
  - V1 is unavailable to operators who do not use VS Code or a fork.
  - The extension is bound to VS Code's release cadence and API stability commitments — proposed APIs and breaking changes are now a project concern.
  - Cross-extension boundaries (chapter 06, turn-070) constrain how aggressively V1 can observe or coordinate with other agent extensions (Copilot, Continue, Cursor's built-ins). Coexistence, not control.
  - The "shell" is no longer ours; visual identity and gross UX shape are VS Code's.
- **Follow-ups:**
  - DR-0009 — keep the cell paradigm, drop the Jupyter kernel; cells dispatch via VS Code's `NotebookController` API directly. Made cleanly possible only because VS Code separates notebook UI from kernel.
  - DR-0010 — agent text suppressed; tool-only output. Made operationally clean by VS Code's MIME-renderer infrastructure for cell output.
  - DR-0011 (chapter 07) — subtractive fork of `microsoft/vscode-jupyter`: what to delete (Python integration, IPyWidgets, remote servers, debugging, viewers), what to keep (notebook editor, cell semantics, file persistence).

## Alternatives considered

- **Custom Chromium / custom shell.** Rejected — scope explosion. Owning the shell means rebuilding the editor, file tree, diff view, terminal, and marketplace. All exist in VS Code; all would land worse on the first attempt.
- **Electron app.** Rejected — distribution overhead (installer, signing, auto-update) and the same rebuild cost as a custom shell, with no compensating gain over targeting VS Code directly.
- **Pure web app in a browser tab.** Rejected — no diff API, no real terminal, no direct file system access without a paired native helper. The browser sandbox forces a daemon anyway, and once a daemon exists, the simplest UI to talk to it and render code edits is, again, VS Code.
- **Standalone TUI (terminal app).** Rejected implicitly — no diff editor, no rich MIME rendering for tool-call outputs, no notebook substrate. Wrong shape for the chat-as-cells design that DR-0009 commits to.

## Source

- **Source merged turns:** 063, 064 (phase 06)
- **Raw sub-turns:**
  - [turn-070-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-070-assistant.md) — VS Code extension model; what aggressive intervention is and is not; cross-extension boundary constraints; MCP as the standardization layer to bet on.
  - [turn-080-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-080-assistant.md) — the notebook insight as a chat substrate; first sketch of forking `vscode-jupyter`; the inherit-the-affordances argument made concrete.
  - [turn-084-assistant.md](../../_ingest/raw/phase-06-vscode-notebook-substrate/turn-084-assistant.md) — synthesis of the substrate stack and how each VS Code-provided layer earns its place.
- **Dev guide:** [chapter 06](../dev-guide/06-vscode-notebook-substrate.md)
