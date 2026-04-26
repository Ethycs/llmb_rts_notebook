# Documentation

`llmb_rts_notebook` is the operator interface for supervising a fleet
of autonomous coding agents — an RTS-style command surface for LLM
agents, delivered as a VS Code extension. V1 forks the
`vscode-jupyter` extension subtractively (cell paradigm in, Jupyter
kernel out), wires LLMKernel as the sole kernel, and uses
**bidirectional MCP** (Model Context Protocol) as the communication
channel between operator and agent — with the agent's free-text
output suppressed entirely in favor of structured tool calls.

This documentation tree captures the design as it stood at the end of
the source design conversation. The conversation itself is preserved
verbatim at the repo root as
[`chat-export-2026-04-26T04-22-39.md`](../chat-export-2026-04-26T04-22-39.md);
the documentation is the navigable distillation.

## Where to start

- **[Dev guide overview](dev-guide/00-overview.md)** — a 1-paragraph
  teaser per chapter, in reading order.
- **[Decision records index](decisions/README.md)** — every load-bearing
  commitment with one-line summary, tag, and source turns.
- **[`_ingest/ARCHITECTURE.md`](../_ingest/ARCHITECTURE.md)** — how this
  documentation tree was generated from the conversation.

## Layout

```
docs/
├── README.md                  ← you are here
├── dev-guide/                 ← imperative description of the design
│   ├── 00-overview.md         ← chapter index
│   ├── 01-vega-rendering-substrate.md
│   ├── 02-agent-orchestration-pivot.md
│   ├── 03-hypergraph-observability.md
│   ├── 04-isolation-and-mcp-placement.md
│   ├── 05-v1-scope-reduction.md
│   ├── 06-vscode-notebook-substrate.md
│   ├── 07-subtractive-fork-and-storage.md
│   └── 08-blockers-mediator-standards.md
└── decisions/                 ← ADRs in MADR-lite format
    ├── README.md              ← ADR index, supersession map, reading order
    └── 0001-…md … 0016-…md
```

## Reading paths

**For a newcomer who wants the design at a glance:**

1. Read [dev-guide/00-overview.md](dev-guide/00-overview.md).
2. Skip to [chapter 05](dev-guide/05-v1-scope-reduction.md) — what V1 IS
   and IS NOT.
3. Skip to [chapter 06](dev-guide/06-vscode-notebook-substrate.md) —
   where V1 actually lives (VS Code, NotebookController, MCP, forced
   tool use).
4. Skim the [decisions index](decisions/README.md) to anchor specific
   commitments.

**For a contributor about to start writing code:**

1. Read [chapter 08](dev-guide/08-blockers-mediator-standards.md) — the
   four RFCs that need to be written before implementation, plus the
   kernel mediator role.
2. Walk the chapters back to chapter 05 to ground each RFC in its
   architectural context.
3. Read the relevant ADRs in full when an RFC needs a "why" reference.

**For an auditor / reviewer:**

1. The [decisions index](decisions/README.md) is the audit trail — 16
   ADRs covering every load-bearing commitment.
2. Each ADR's `Source` section links back to the verbatim raw turns
   under [`_ingest/raw/`](../_ingest/raw/) — full provenance is one
   click away.
3. Reconciliation choices for how the conversation was decomposed are
   recorded in
   [`_ingest/manifests/reconciliation.md`](../_ingest/manifests/reconciliation.md).

## How this was built

The conversation was 1.1 MB of raw markdown. The pipeline that produced
this documentation is described in
[`_ingest/ARCHITECTURE.md`](../_ingest/ARCHITECTURE.md). The original
plan is preserved in [`_ingest/PROCEDURE.md`](../_ingest/PROCEDURE.md).
Both are version-controlled alongside the artifacts they produced, so
the decomposition is itself reproducible and auditable.
