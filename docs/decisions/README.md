# Decision records

This directory contains the architecture decision records (ADRs) for
`llmb_rts_notebook`, in **MADR-lite** format. Each ADR captures one
load-bearing commitment: what forced the decision, what was chosen,
what was given up, and what alternatives were considered.

The ADRs preserve context that the [dev guide](../dev-guide/) flattens
away. The dev guide states the design as fact (the endpoint of the
conversation); the ADRs preserve the journey, including reversals
and superseded commitments.

## Tags

| Tag | Meaning |
| --- | ------- |
| `PIVOT` | Direction change. The project's scope or approach shifted. |
| `LOCK-IN` | Architectural commitment. A specific design is chosen and downstream work depends on it. |
| `SCOPE-CUT` | V1 simplification. A feature, integration, or layer is removed to keep the first ship reachable. |

## Index

| ID | Title | Tag | Phase | Source turns |
| -- | ----- | --- | ----- | ------------ |
| [0001](0001-rts-as-agent-orchestrator.md) | Project pivots from Vega-game-engine to RTS-for-agent-orchestration | PIVOT | [02](../dev-guide/02-agent-orchestration-pivot.md) | 006, 007 |
| [0002](0002-agents-as-hypergraph-authors.md) | Agents modeled as hypergraph edge authors, not spatial entities | PIVOT | [02](../dev-guide/02-agent-orchestration-pivot.md) | 009, 010 |
| [0003](0003-six-tier-architecture-locked.md) | Six-tier architecture diagram committed | LOCK-IN | [03](../dev-guide/03-hypergraph-observability.md) | 028 |
| [0004](0004-per-zone-mcp-servers.md) | Per-zone MCP server instances chosen over host-shared servers | LOCK-IN | [04](../dev-guide/04-isolation-and-mcp-placement.md) | 034 |
| [0005](0005-v1-scope-cut.md) | V1 scope reduction: cut 3D/VR, macOS, SSH, MCP, bubblewrap, live policy, event sourcing, NATO, VegaFusion, magic CLI | SCOPE-CUT | [05](../dev-guide/05-v1-scope-reduction.md) | 036 |
| [0006](0006-reject-react-frontend-not-the-question.md) | Reject React; reframe frontend as not the load-bearing question | PIVOT | [05](../dev-guide/05-v1-scope-reduction.md) | 041 |
| [0007](0007-vscode-as-host.md) | VS Code adopted as unified host platform | PIVOT | [06](../dev-guide/06-vscode-notebook-substrate.md) | 063, 064 |
| [0008](0008-bidirectional-mcp-as-comm-channel.md) | MCP used bidirectionally as primary agent communication channel | LOCK-IN | [06](../dev-guide/06-vscode-notebook-substrate.md) | 060 |
| [0009](0009-notebook-controller-no-jupyter-kernel.md) | VS Code NotebookController API used; no Jupyter kernel, no Python runtime | LOCK-IN | [06](../dev-guide/06-vscode-notebook-substrate.md) | 067, 070 |
| [0010](0010-force-tool-use-suppress-text.md) | Agent text output suppressed; tool calls become sole communication | LOCK-IN | [06](../dev-guide/06-vscode-notebook-substrate.md) | 075, 076 |
| [0011](0011-subtractive-fork-vscode-jupyter.md) | Subtractive fork of vscode-jupyter | LOCK-IN | [07](../dev-guide/07-subtractive-fork-and-storage.md) | 079, 080 |
| [0012](0012-llmkernel-sole-kernel.md) | LLMKernel hardcoded as sole kernel; no kernel discovery | SCOPE-CUT | [07](../dev-guide/07-subtractive-fork-and-storage.md) | 083 |
| [0013](0013-v1-feasible-with-claude-code.md) | V1 scope confirmed feasible with Claude Code as collaborator | LOCK-IN | [07](../dev-guide/07-subtractive-fork-and-storage.md) | 085 |
| [0014](0014-three-storage-structures-embedded.md) | Three storage structures (layout tree, agent graph, chat flow) embedded in single .llmnb file | LOCK-IN | [07](../dev-guide/07-subtractive-fork-and-storage.md) | 081, 082, 083 |
| [0015](0015-kernel-extension-bidirectional-mcp.md) | Bidirectional 'paper-telephone' MCP between kernel and extension | LOCK-IN | [08](../dev-guide/08-blockers-mediator-standards.md) | 099 |
| [0016](0016-rfc-standards-discipline.md) | Bell System–inspired standards discipline: RFC-driven tool specs and provisioning | LOCK-IN | [08](../dev-guide/08-blockers-mediator-standards.md) | 103, 104, 105 |

## Reading order

If you read top-to-bottom, the ADRs tell the story of the design:

1. **DR-0001** establishes what the project is (an agent operator console, not a game).
2. **DR-0002** picks the data model (hypergraph edges, not spatial coordinates).
3. **DR-0003** lays down the pre-V1 architecture (6 tiers).
4. **DR-0004** resolves a major sub-question (where MCP servers run).
5. **DR-0005** is the inflection: V1 cuts most of DR-0003 and DR-0004.
6. **DR-0006** kills the framework debate and surfaces the real differentiator.
7. **DR-0007 → DR-0010** lock the V1 substrate: VS Code as host, bidirectional MCP, NotebookController without Jupyter kernel, forced tool use.
8. **DR-0011 → DR-0014** lock the V1 mechanics: subtractive fork, single kernel, single file, feasibility confirmed.
9. **DR-0015 → DR-0016** lock the meta-pattern: kernel as protocol mediator, RFC discipline for everything that comes next.

## Supersession

DR-0003 (six-tier architecture) and DR-0004 (per-zone MCP placement)
are substantially **superseded** by DR-0005 (V1 scope cut). The
original commitments remain valid as design intent for the eventual
post-V1 expansion, but V1 ships a heavily reduced subset. The status
line on DR-0003 and DR-0004 records this explicitly.

DR-0008 (bidirectional MCP as communication channel) is **refined** by
DR-0015 (paper-telephone MCP between kernel and extension): DR-0008
named the pattern, DR-0015 names the endpoints. Both stand.

## How to read an ADR

Each ADR has six sections in MADR-lite order:

1. **Title and metadata** (status, date, tag).
2. **Context** — what forced the decision.
3. **Decision** — the chosen path, stated as an imperative.
4. **Consequences** — positive, negative / cost, follow-ups.
5. **Alternatives considered** — what was rejected and why.
6. **Source** — links back to the raw conversation turns and the
   relevant dev-guide chapter.

The format is deliberately concise. For depth on the design's current
shape, follow the link to the dev-guide chapter. For depth on the
journey, follow the link to the raw turn files.
