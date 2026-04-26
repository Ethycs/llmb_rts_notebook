# llmb_rts_notebook

An RTS-style operator interface for supervising fleets of autonomous
coding agents, delivered as a VS Code extension. V1 forks
`vscode-jupyter` subtractively, wires LLMKernel as the sole kernel,
and uses bidirectional MCP as the structured communication channel
between operator and agent.

This repository is currently a **design notebook**. The design was
produced through an extended conversation that lives at the repo
root as `chat-export-2026-04-26T04-22-39.md`. The navigable
distillation of that conversation — dev guide, decision records,
phase manifests — lives under [`docs/`](docs/) and
[`_ingest/`](_ingest/).

## Start here

- [`docs/README.md`](docs/README.md) — top-level documentation index.
- [`docs/dev-guide/00-overview.md`](docs/dev-guide/00-overview.md) —
  the design told in reading order.
- [`docs/decisions/README.md`](docs/decisions/README.md) — 16 ADRs
  capturing every load-bearing commitment.

## Repo layout

```
llmb_rts_notebook/
├── README.md                            ← you are here
├── LICENSE                              ← GPL v3
├── CLAUDE.md                            ← Claude Code project guidance
├── pixi_guide.md                        ← Pixi CLI quick reference
├── pyproject.toml / pixi.lock           ← Pixi workspace
├── chat-export-2026-04-26T04-22-39.md   ← source-of-truth, never edited
├── docs/                                ← polished output (humans)
│   ├── README.md
│   ├── dev-guide/                       ← 8 chapters + overview
│   └── decisions/                       ← 16 ADRs + index
└── _ingest/                             ← decomposition pipeline
    ├── ARCHITECTURE.md                  ← how the pipeline works
    ├── PROCEDURE.md                     ← original plan
    ├── scripts/                         ← Python: turn-index, phase-split
    ├── manifests/                       ← turns.json, phases.json, decisions.json
    └── raw/                             ← per-turn slices with frontmatter
```

## How this repo was bootstrapped

The repo started as a single `LICENSE` and a 1.1 MB chat export. The
documentation tree, decision records, and per-phase raw archive were
produced by a deterministic + agent-assisted pipeline described in
[`_ingest/ARCHITECTURE.md`](_ingest/ARCHITECTURE.md). The original
procedure plan is preserved verbatim at
[`_ingest/PROCEDURE.md`](_ingest/PROCEDURE.md). The pipeline can be
re-run from `pixi run build-turn-index` and `pixi run split-into-phases`
on a clean checkout.

## Status

Implementation phase, week zero. The design notebook is frozen; the
Bell-System-discipline RFCs ([DR-0016](docs/decisions/0016-rfc-standards-discipline.md))
are the active gate before code lands. The four numbered RFCs live
under [`docs/rfcs/`](docs/rfcs/):

1. **[RFC-001](docs/rfcs/RFC-001-mcp-tool-taxonomy.md)** — V1 MCP tool taxonomy.
2. **[RFC-002](docs/rfcs/RFC-002-claude-code-provisioning.md)** — Claude Code provisioning procedure.
3. **[RFC-003](docs/rfcs/RFC-003-custom-message-format.md)** — custom Jupyter message format.
4. **[RFC-004](docs/rfcs/RFC-004-failure-modes.md)** — failure-mode analysis and fault-injection harness.

After the RFCs land, V1 implementation proceeds along two tracks:

- **Track B** — harden [LLMKernel](https://github.com/Ethycs/LLMKernel)
  into the MCP/PTY mediator ([DR-0015](docs/decisions/0015-kernel-extension-bidirectional-mcp.md)):
  embedded MCP server, LangSmith run-tracker, custom-message
  dispatcher, agent-process supervisor, LiteLLM endpoint.
- **Track C** — subtractive fork of
  [`microsoft/vscode-jupyter`](https://github.com/microsoft/vscode-jupyter)
  ([DR-0011](docs/decisions/0011-subtractive-fork-vscode-jupyter.md))
  into [`extension/`](extension/), with `.llmnb` registered as the
  exclusive file extension and `NotebookController` rebound to LLMKernel.

The integration target is a minimum-viable paper telephone: cell →
agent → MCP `notify` → LangSmith run record → cell-output renderer.

## Repo layout (post-bootstrap)

```
llmb_rts_notebook/
├── docs/
│   ├── dev-guide/            ← 8-chapter design (frozen)
│   ├── decisions/            ← 16 ADRs (frozen)
│   └── rfcs/                 ← V1 implementation gates (active)
├── extension/                ← VS Code extension (subtractive fork output)
├── kernel/                   ← LLMKernel mediator additions (Track B)
├── vendor/
│   ├── LLMKernel/            ← submodule, our fork
│   └── vscode-jupyter/       ← submodule, microsoft/vscode-jupyter (read-only baseline)
└── _ingest/                  ← decomposition pipeline (frozen)
```

## License

GPL v3 — see [`LICENSE`](LICENSE).
