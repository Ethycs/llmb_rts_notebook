# Dev guide — overview

## What this project is

`llmb_rts_notebook` is the operator interface for supervising a fleet of
autonomous coding agents. It is **not** a real-time strategy game. The
RTS metaphor is the UX vocabulary the interface borrows: agents are
units, jobs are objectives, the host system is terrain, and the human
supervisor is the operator. The goal is to make a working session with
many concurrent coding agents glanceable, interruptible, and
auditable — using categorical visual encoding, structured
communication, and zone-based isolation rather than free-form chat.

V1 ships as a VS Code extension. It forks the `vscode-jupyter`
extension subtractively (delete what doesn't apply to LLM agents,
keep the cell paradigm), wires LLMKernel as the sole kernel, and
uses **bidirectional MCP** (Model Context Protocol) as the
communication channel between operator and agent — with the agent's
free-text output suppressed entirely in favor of structured tool
calls. The design records below capture every load-bearing
commitment.

## How to read this guide

The chapters tell the design story in chronological order, but each
chapter is self-contained: it describes a coherent slice of the
system as it stands at the end of the design phase, with reversals
flagged but not narrated. Read top-to-bottom for context; jump in
anywhere for reference.

For decision context (what was considered, why each choice was made,
what was rejected), see [the ADR index](../decisions/README.md). For
the verbatim source conversation that produced this guide, see
[`_ingest/raw/`](../../_ingest/raw/) — every chapter footer links the
specific turns it draws from.

## Chapters

### [01 — Vega as RTS rendering substrate](01-vega-rendering-substrate.md)

Why the project starts with "can Vega render an RTS?" and why the
answer is "no for a literal RTS, yes for the observability layer
underneath one." The Option-B framing (Vega as debug overlay over a
real engine) is the artifact that survives the pivot — it reappears
as the hypergraph observability layer in chapter 03.

### [02 — Agent orchestration pivot](02-agent-orchestration-pivot.md)

The reframe that fixes the project identity: this is not a game, it
is an operator interface for coding agents. The RTS metaphor maps
unit→agent, objective→job, terrain→host, and operator→human
supervisor. Introduces the dual-view model (2D command-post +
inspection-only 3D), NATO-style symbology (later cut for V1), the
integration target list (Claude Code, OpenCode, ACP), and the pivot
from agents-as-spatial-entities to **agents-as-hypergraph-edge-authors**.

### [03 — Hypergraph observability architecture](03-hypergraph-observability.md)

The pre-V1 high-water mark of the architecture. Agents emit edges
(`agent_id, verb, object, metadata, timestamp`); the world is a
multiplex graph; visualization is a temporal stream rendering
problem. Lands the **6-tier architecture** (DR-0003): operator
surface → RTS core → adapters → process supervisor → isolation
engine → agent processes. This is the shape that V1 cuts down from.

### [04 — Zone isolation and MCP placement](04-isolation-and-mcp-placement.md)

How filesystem isolation makes agent zones structurally enforceable.
Walks the primitive ladder (chroot → pivot_root → namespaces →
bubblewrap → systemd-nspawn → containers → microVMs) and lands on
chroot as the V1-compatible default. Resolves where MCP servers run
(per-zone instances by default, host-shared for cheap commons).
**Most of this is cut for V1**; the chapter is the design intent for
the eventual upgrade path.

### [05 — V1 scope reduction](05-v1-scope-reduction.md)

The most important inflection in the project. The architectural
mode flips from "add" to "subtract." Documents what V1 IS (single
host, single agent type via Claude Code SDK, plain chroot, basic
SVG, in-memory + SQLite, three CLI commands) and what V1 IS NOT
(3D/VR, macOS, SSH, MCP-as-integration-layer, bubblewrap,
namespaces, live policy, event sourcing as source-of-truth, NATO
symbology, VegaFusion, magic CLI). React is rejected, and the
frontend itself is reframed as the wrong question: the differentiator
is the **chat surface**, not the framework underneath it.

### [06 — VS Code notebook as chat substrate](06-vscode-notebook-substrate.md)

Where V1 actually lives. Four lock-ins: VS Code as the host
(DR-0007), bidirectional MCP as the operator–agent protocol
(DR-0008), the VS Code NotebookController API with no Jupyter
kernel (DR-0009), and the agent's text output suppressed in favor
of forced tool use (DR-0010). The chat surface is rendered MCP
calls in cells, not parsed prose.

### [07 — Subtractive fork and storage](07-subtractive-fork-and-storage.md)

The fork mechanics: delete from `vscode-jupyter` rather than build
on top of it. Cuts: Python integration, IPyWidgets, remote Jupyter
servers, debugging UI, dataframe/plot viewers, kernel discovery.
Keeps: cell editor, notebook UI, NotebookController surface.
LLMKernel hardcoded as sole kernel. Three storage structures
(layout tree, agent state graph, chat flow JSON) embedded in a
single `.llmnb` file (a JSON-compatible extension of `.ipynb`) for
atomic operations and clean git diffs. V1 feasibility confirmed.

### [08 — Blockers, mediator role, and standards discipline](08-blockers-mediator-standards.md)

The final chapter and the meta-pattern for everything still
outstanding. LLMKernel is positioned as the **MCP/PTY mediator**
between agent and extension, with a "paper-telephone" bidirectional
MCP topology where both sides expose tools to each other. Adopts
**Bell System engineering discipline** — numbered RFCs before
implementation, backward-compatibility analysis, layered
abstractions (LiteLLM as the stable provider-API layer, MCP at a
layer above). Names four RFCs to write before V1 implementation
begins: tool taxonomy, Claude Code provisioning, custom message
envelope, fault-injection harness.

## Decision records

Each significant commitment is preserved as an ADR under
[docs/decisions/](../decisions/). The ADR records what was
considered, what was chosen, why, and what was given up — the
context that the dev-guide endpoint flattens away. Sixteen ADRs
total, tagged `PIVOT` (direction change), `LOCK-IN` (commitment),
or `SCOPE-CUT` (V1 simplification).

## Source

- The original conversation is preserved verbatim at the repo
  root as `chat-export-2026-04-26T04-22-39.md`.
- Per-turn slices with frontmatter live under
  [`_ingest/raw/`](../../_ingest/raw/).
- The decomposition manifests (`turns.json`, `phases.json`,
  `decisions.json`, `reconciliation.md`) live under
  [`_ingest/manifests/`](../../_ingest/manifests/).
- The pipeline that produced this guide is documented in
  [`_ingest/ARCHITECTURE.md`](../../_ingest/ARCHITECTURE.md).
