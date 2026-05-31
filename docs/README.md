# Documentation

`llmb_rts_notebook` is the operator interface for supervising a fleet
of autonomous coding agents — an RTS-style command surface for LLM
agents, delivered as a VS Code extension. V1 forks the
`vscode-jupyter` extension subtractively (cell paradigm in, Jupyter
kernel out), wires LLMKernel as the sole kernel, and uses
**bidirectional MCP** (Model Context Protocol) as the communication
channel between operator and agent.

The doc tree has three normative layers (definitions, contracts,
substrate) plus historical context (the original design ADRs and the
design-conversation dev guide). Substrate-level kernel documentation
lives under [`kernel/`](kernel/) — capture invariants, identity model,
the embeddable Kernel facade, deployment surfaces, and per-slice
implementation plans.

## Where to start

**For "what does this thing do today?":**
1. [`README.md`](../README.md) at repo root — Status section + slice
   ladder.
2. [`notebook/BSP-005-cell-roadmap.md §6.5`](notebook/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update) — current shipped/queued status per slice.
3. [`atoms/README.md`](atoms/README.md) — the canonical definitions
   layer; browse `concepts/`, `operations/`, etc.

**For someone implementing a slice:**
1. The relevant `notebook/PLAN-S*.md` slice plan.
2. The atoms it cites under `atoms/concepts/`, `atoms/operations/`,
   `atoms/protocols/`, `atoms/contracts/`.
3. The relevant RFC (wire / file format / transport).

**For an auditor / reviewer:**
1. [`decisions/README.md`](decisions/README.md) — the 16 original
   design ADRs (MADR-lite, with provenance back to the source
   conversation turns).
2. [`atoms/decisions/`](atoms/decisions/) — the V1/V2 implementation
   decisions (separate namespace from the formal ADRs above).
3. [`notebook/PLAN-atom-refactor.md §4`](notebook/PLAN-atom-refactor.md) — the 24-row V1 decision table that the
   atom-layer decisions are anchored against.

**For the design-as-of-source-conversation:**
- [`dev-guide/00-overview.md`](dev-guide/00-overview.md) — 8 chapters
  in reading order. Reflects the design as it stood at the end of the
  source conversation; superseded in places by atoms + BSPs/RFCs but
  still the best one-paragraph-per-chapter overview.

## Layout

```
docs/
├── README.md                  ← you are here
├── atoms/                     ← canonical definitions (~91 atoms, 7 subdirs)
│   ├── README.md
│   ├── concepts/              ← what things ARE — turn, cell, section, agent, etc.
│   ├── operations/            ← what you can DO — split-cell, merge-cells, etc.
│   ├── discipline/            ← project rules / invariants
│   ├── decisions/             ← V1/V2 implementation calls (D1-D8 / S1-S6 / etc.)
│   ├── anti-patterns/         ← already-hit traps with the lesson
│   ├── protocols/             ← wire formats (Family A-F, intent envelope, handshake)
│   └── contracts/             ← code-internal interfaces (Cell Manager, Writer, etc.)
├── rfcs/                      ← public boundary contracts (RFCs 001-009)
│   ├── README.md
│   └── RFC-001-…md … RFC-009-…md
├── notebook/                  ← BSPs / FSPs / PLAN-S* / KB-target
│   ├── BSP-002-…md … BSP-008-…md
│   ├── FSP-001-…md … FSP-003-…md
│   ├── PLAN-S*-…md            ← per-slice execution plans
│   ├── KB-notebook-target.md  ← target architecture; §0 pins V1 amendments
│   ├── PLAN-atom-refactor.md  ← executed plan for the atom-layer refactor
│   └── VERSIONING.md          ← spec versioning conventions
├── dev-guide/                 ← 8 chapters from the design conversation
│   ├── 00-overview.md         ← chapter index
│   └── 01-…md … 08-…md
├── decisions/                 ← 16 original design ADRs (MADR-lite)
│   ├── README.md
│   └── 0001-…md … 0016-…md
└── kernel/                    ← substrate-level docs for LLMKernel
    ├── README.md              ← index
    ├── identity-model.md      ← every kernel identifier in one place
    ├── capture-invariants.md  ← the "what to defend" charter
    ├── architecture.md        ← Kernel facade, Transport, Extension contracts
    ├── embedding.md           ← `from llm_kernel import Kernel` guide
    ├── deployment.md          ← the three surfaces; auth; session resumption
    ├── external-mcp-reference.md ← external MCP tool / resource / notification catalogs
    ├── extensions.md          ← extension authoring guide
    ├── pbx.md                 ← PBX reference
    └── PLAN-*.md              ← per-slice implementation plans
```

Several `kernel/` files above are planned but not yet written — see
[`kernel/README.md`](kernel/README.md) for which are present.

## Two decision namespaces

Two distinct kinds of "decisions" live in this tree:

- [`decisions/`](decisions/) — the **formal MADR-lite ADRs** (DR-0001
  through DR-0016) that come from the original 1.1 MB design
  conversation. Each ADR has provenance back to specific source turns.
  These are the load-bearing architectural lock-ins (LOCK-IN, PIVOT,
  SCOPE-CUT tags). New ADRs (DR-0017+) are added only when a new
  load-bearing decision surfaces.

- [`atoms/decisions/`](atoms/decisions/) — the **V1/V2 implementation
  decisions** that surfaced during execution. Each maps to a row in the
  24-decision table at [`notebook/PLAN-atom-refactor.md §4`](notebook/PLAN-atom-refactor.md). These are operational pins
  ("V1 sections are flat", "section.status is the interruptibility
  lock", "RunFrame minimal schema", etc.).

The two namespaces don't compete — formal ADRs frame the architecture;
atom-layer decisions pin the implementation.

## Reading paths

**For a newcomer who wants the design at a glance:**
1. Read [dev-guide/00-overview.md](dev-guide/00-overview.md).
2. Skip to [chapter 05](dev-guide/05-v1-scope-reduction.md) — what V1 IS
   and IS NOT.
3. Skip to [chapter 06](dev-guide/06-vscode-notebook-substrate.md) —
   where V1 actually lives.
4. Skim the [decisions index](decisions/README.md) to anchor specific
   commitments.
5. Then jump to [atoms/README.md](atoms/README.md) and browse the
   concepts that interest you.

**For a contributor about to write code:**
1. The relevant slice plan in [`notebook/PLAN-S*`](notebook/).
2. The atoms it touches (each slice plan lists "atoms touched").
3. The relevant RFC for any wire / file-format work.
4. [Engineering_Guide.md](../Engineering_Guide.md) §11 (anti-patterns)
   before debugging anything.

**For an auditor / reviewer:**
1. [decisions/README.md](decisions/README.md) — the formal ADR audit
   trail (16 records, provenance back to raw turns).
2. [atoms/decisions/](atoms/decisions/) — the implementation decisions
   that surfaced post-conversation.
3. [notebook/PLAN-atom-refactor.md](notebook/PLAN-atom-refactor.md) —
   the executed plan that produced the atom layer.

**For substrate / kernel work (embedding, transports, extensions):**
1. [kernel/README.md](kernel/README.md) — index for the substrate doc
   tree.
2. [kernel/capture-invariants.md](kernel/capture-invariants.md) — the
   "what to defend" charter (planned; see kernel/README.md for status).
3. [kernel/identity-model.md](kernel/identity-model.md) — every kernel
   identifier in one reference (planned).
4. [kernel/PLAN-kernel-facade.md](kernel/PLAN-kernel-facade.md) —
   implementation plan for the embeddable `Kernel` facade (slice 2 of
   the substrate trajectory).

## How this was built

The conversation was 1.1 MB of raw markdown
([`chat-export-2026-04-26T04-22-39.md`](../chat-export-2026-04-26T04-22-39.md)). The pipeline that
produced the original dev-guide + ADRs is described in
[`_ingest/ARCHITECTURE.md`](../_ingest/ARCHITECTURE.md). The original
plan is preserved in [`_ingest/PROCEDURE.md`](../_ingest/PROCEDURE.md).

The atom layer was added later via [`notebook/PLAN-atom-refactor.md`](notebook/PLAN-atom-refactor.md) (executed 2026-04-28; ~91 atoms
across 7 subdirs). BSPs, FSPs, and PLAN-S* slice plans accumulated as
implementation progressed.
