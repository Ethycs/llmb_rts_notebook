# llmb_rts_notebook

An RTS-style operator interface for supervising fleets of autonomous
coding agents, delivered as a VS Code extension. V1 forks
`vscode-jupyter` subtractively, wires LLMKernel as the sole kernel,
and uses bidirectional MCP as the structured communication channel
between operator and agent.

The repo started life as a 1.1 MB design conversation
([`_ingest/chat-export-2026-04-26T04-22-39.md`](_ingest/chat-export-2026-04-26T04-22-39.md))
— that conversation is the historical source of truth for the original architectural choices.
The current normative reference is the doc tree under [`docs/`](docs/),
with [`docs/atoms/`](docs/04%20-%20Reference/atoms/) holding canonical definitions,
[`docs/notebook/`](docs/03%20-%20Blueprint/) + [`docs/rfcs/`](docs/05%20-%20Standards/rfcs/)
holding behavioral and wire-format specs, and
[`docs/kernel/`](docs/04%20-%20Reference/kernel/) holding substrate-level documentation
for the embeddable LLMKernel (capture invariants, identity model,
deployment surfaces, per-slice implementation plans).

## Status — **V1 shipped (v1.0.0, 2026-06-30)**; all 14 ship-ready rows ✅

V1 is shipped — tagged `v1.0.0` on 2026-06-30. Every row of the [PLAN-v1-roadmap §5 ship-ready checklist](docs/07%20-%20Status%20Reports/PLAN-v1-roadmap.md) is ✅ green. Rows 1-11 (operator-visible UX) shipped 2026-05-02 → 2026-05-19; the last two rows closed this cycle:

- **Row 13 (substrate gaps)** — all 9 gaps closed 2026-06-30 via [PLAN-substrate-gap-closure](docs/07%20-%20Status%20Reports/PLAN-substrate-gap-closure.md). Kernel test suite: **908/908 green.**
- **Row 14 (atom drift)** — full [PLAN-atom-hygiene](docs/07%20-%20Status%20Reports/PLAN-atom-hygiene.md) sweep landed 2026-06-30. All 3 verification checks (orphan / drift / Status-line consistency) return empty.

**Operator-visible V1 UX (feature-complete since 2026-05-19):** S5.5 sections (full collapse via native markdown fold), S7 sidebar trees (zones / agents / activity), S10 reduced V1 (streaming/artifact badges + bulk-collapse / find wrappers), S10 follow-on (sidebar Find-in-cells WebviewView with the full FSP-002 §2.1 search UX). S5.0.6 (nvim driver) deferred to whenever the nvim operator's dogfooding pressure justifies the per-cell affordance — the headless `llmnb execute --connect` CLI (`df95ad4`) covers file-level operation for nvim users in the interim.

**V2 lane opened 2026-05-20:** branch-switching UX (sidebar Branches subnode under each agent that has forked descendants — lineage recovered from `metadata.rts.zone.event_log[*]` `fork_agent` envelopes) and output-kind lens UI (5th sidebar view grouping every tagged span across the active notebook). Both are pure read-side — no kernel changes, no wire changes. See [docs/06 - Roadmaps/ROADMAP.md](docs/06%20-%20Roadmaps/ROADMAP.md) for the V2 short/long-horizon queue.

**Genuinely blocked on VS Code API:** per-cell gutter color decoration (`notebookCellDecoration` is not even a Microsoft API proposal, per a probe against the vendored `vscode-jupyter`'s `enabledApiProposals`). The literal "floating search bar above the editor" is the same ceiling — no overlay-above-editor API. Both surface UX is now in the sidebar instead.

## Earlier status — Cell↔file magic matrix symmetric + Tier-2 CLI attach (2026-05-16)

V1 cell-side substrate is shipped end-to-end. Operator `@@spawn` /
`@@agent` / `@<flag>` cell-magic dispatches; agent processes spawn and
persist via `--resume`; multi-turn cells, cross-agent context handoff,
and the headless executor all work. The cell schema collapsed in S5.0
to `{text, outputs, bound_agent_id}` with kind/flags parse-derived from
text via the `@@` cell-magic + `@` line-magic vocabulary
([magic atom](docs/04%20-%20Reference/atoms/concepts/magic.md)).

**V1.6+ shipped since 2026-05-02 (most recent first):**

- **PLAN-S5.0.5 — cell-magic file encode/decode** (commits `ce214ba` Phase 1
  / `1c9e81f` Phase 2; submodule `7139a3f` → `02fb2d3`). `@@import` extended
  to accept `.magic` and `.ipynb` in addition to native `.llmnb`; new
  `@@export path:"…" [format:…] [overwrite:…]` cell-magic serializes the
  current notebook to disk. Kernel-speaks-magic throughout — no
  operator-action envelope round-trip, no RFC-006 bump, no extension
  changes. Three new K-classes (K3M path-outside-workspace, K3N
  overwrite-refused, K3O bundled I/O failure with `cause` sub-code). The
  cell↔file matrix is now symmetric in all four quadrants.
  ([PLAN-S5.0.5](docs/07%20-%20Status%20Reports/PLAN-S5.0.5-magic-file-encode-decode.md))
- **PLAN-S5.0.4 — privileged magic emission** (extension `838aa85`;
  kernel `2306aef` / `bc24720` / `987b7ef`). `emit_magic_cell` MCP tool
  + `magic_emit_privileges[]` store + `promote_stream_magic` operator
  action. Privileged agents can produce cells via the structural
  channel; unprivileged stream emissions stay sanitized.
- **Tier-2 `llmnb execute --connect`** (commit `df95ad4`, 2026-05-14). The
  CLI can now attach to a long-lived `llmnb serve` kernel instead of
  spawning a fresh PTY-loopback each invocation. Token from
  `--auth-token-env` (default `LLMNB_AUTH_TOKEN`); never on argv.
  Unblocks per-cell execution against a shared kernel from any non-VS
  Code driver.

- **BSP-007 overlay graph** — operator-side, git-style commits over
  the agent turn DAG. `apply_commit` / `revert_to_commit` / `diff` /
  `branch` primitives; 17 V1 op kinds; §6 cell-merge correctness
  validators; K90-K95 failure modes. ([commit `3a430cb`](docs/03%20-%20Blueprint/BSP-007-overlay-git-semantics.md))
- **BSP-008 RunFrames + ContextPacker integration** — every agent
  turn now persists a `record_context_manifest` + start/terminal
  `record_run_frame` trail through the BSP-003 intent path.
  ([commit `3a430cb`](docs/03%20-%20Blueprint/BSP-008-contextpacker-runframes.md))
- **PLAN-S6.0 in-tree event log + hydrate-replay safety** — the
  event log lives in `metadata.rts.event_log[]`; `EventLogReplayer`
  asserts `dispatcher.is_writable() == False` at the boundary to
  prevent double-emission on reopen. ([commit `03de446`](vendor/LLMKernel/llm_kernel/event_log.py))
- **Inspect mode V1 (read-only)** — per-cell status bar item shows
  latest RunFrame + ContextManifest summary; click opens manifest
  detail QuickPick rendering the inclusion/exclusion trace per
  BSP-008 §11. ([commit `92c7412`](extension/src/inspect/))
- **Standalone TCP server** — `python -m llm_kernel serve` with
  bearer-token auth lets external drivers (CLI, future Rust/Go
  orchestrators) attach over TCP. Validation task filed at
  [`docs/ops/validate-serve-mode.md`](docs/02%20-%20Implementation/ops/validate-serve-mode.md).
- **Tier-3 live OAuth+mitm smoke green** — 6 Anthropic API calls
  intercepted; notify + report_completion emitted by the agent.
  Three latent harness bugs surfaced and fixed in `28c3658`
  (LogRecord `name` collision, missing `send_user_turn` after spawn,
  missing stdin close).
- **Engineering Guide §11.9** — new anti-pattern entry on
  `logger.*(..., extra={...})` keys colliding with reserved
  `LogRecord` attribute names; codifies the rule from the
  magic-injection-defense atom on the path of anyone editing logging.
- **Repo hygiene** — legacy `vendor/LLMKernel/vscode-llm-kernel-extension/`
  removed (74 files); platforms expanded to `win-64`+`linux-64`+`osx-arm64`;
  ESLint 9 flat config landed for the active extension.

Test surface: **857 kernel tests + 374+ stub contract tests + 109
outer driver tests** all green at last verified run (kernel + driver:
2026-05-16; stub: 2026-05-29 pre-output-kind-lens). The stub tier
grew ~50 tests during the V1-UX-feature-complete sweep and V2 lane
opening; the final V2 output-kind-lens slice (`85bd5e4`) added 20
more whose verification is pending a Windows VS Code installer
mutex release. Full kernel suite runs in ~20s under xdist.

Shipped slices (per [BSP-005 §6.5](docs/03%20-%20Blueprint/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update)):

| | Slice | Commit |
|---|---|---|
| ✅ | S0.5 cell-kinds typed enum | `14873a1` |
| ✅ | S1 cell-as-agent badges | `26ac581` |
| ✅ | S2 persistent Claude `--resume` | `26ac581` |
| ✅ | S3 multi-turn `@<agent>` continuation | `ac2bb4d` + `b4cb550` |
| ✅ | S3.5 ContextPacker walker | `64a34d4` |
| ✅ | S4 cross-agent context handoff | `fe2121a` |
| ✅ | S5.0 cell-magic vocabulary + S5.0.1 injection defenses | `336a6c7` + `88ffb15` |
| ✅ | S5.0.3.x headless executor (TCP + handshake + live mode) | `ae7b1a6` → `27c0fcc` |
| ✅ | S5a / S8 partial / S9 interrupt | `5b5533e` / `8d9bd39` / `5de3401`+`64a34d4` |
| ✅ | S5c stop | `wip/s5c-stop` merged |
| ✅ | S6.0 in-tree event log + hydrate-replay safety | `264b69c` + `03de446` |
| ✅ | BSP-007 overlay applier + BSP-008 RunFrames | `3a430cb` |
| ✅ | Inspect mode V1 (read-only per-cell + manifest detail) | `92c7412` |
| ✅ | Tier-2 `llmnb execute --connect` (attach to running kernel) | `df95ad4` |
| ✅ | S5.0.4 privileged magic emission (`emit_magic_cell` + promotion chip) | `838aa85` + submodule `987b7ef` |
| ✅ | S5.0.5 Phase 1 — multi-format `@@import` (`.magic` / `.ipynb`) + `notebook_format` public module | `ce214ba` + submodule `7139a3f` |
| ✅ | S5.0.5 Phase 2 — `@@export` cell-magic + K3M/K3N/K3O | `1c9e81f` + submodule `02fb2d3` |
| ✅ | **S5.5 sections** — overlay-based section CRUD; cell `kind: "section"`; Phase 5 ships native markdown-fold collapse | `645e23a` + `8251a5a` |
| ✅ | **S7 sidebar trees** — `onLastAcceptedVersion` event + 3-view activity-bar (zones / agents / activity) | `03976c7` + `8aaa3e3` + `2260ce0` |
| ✅ | **S10 reduced V1** — streaming + artifact cell badges + `llmnb.collapseAll*` / `llmnb.expandAll*` / `llmnb.findInCells` wrappers fanning out to engine builtins | `b07e6f9` |
| ✅ | **S10 follow-on** — sidebar `Find in cells` WebviewView with full FSP-002 §2.1 search UX (scope filter / case / whole-word / regex / M-of-N / click-to-reveal) | `426051f` |
| ⏸ | PLAN-S5.0.6 Nvim driver V1 — design locked, implementation deferred 2026-05-19 (`llmnb execute --connect` covers file-level in interim) | `8639949` (PLAN doc) + `b7e50cc` (deferral) |
| 🚫 | Per-cell gutter color decoration (the "three-pane" colored gutter) — `notebookCellDecoration` API not exposed and not a Microsoft proposal | blocked |
| 🚫 | Floating search bar literally above the notebook editor — no overlay API on v1.92 | blocked |

V2 lane (shipped this session, both pure read-side):

| | Slice | Commit |
|---|---|---|
| ✅ | **V2 branch-switching UX** — sidebar `Branches` subnode under each agent with forked descendants; lineage recovered from `metadata.rts.zone.event_log[*]` `fork_agent` envelopes | `667dd68` |
| ✅ | **V2 output-kind lens UI** — 5th sidebar view grouping every span tagged with `llmnb.output.kind` by kind; high-attention kinds first; forward-compat `<other>` bucket | `85bd5e4` |
| 🔵 | V2 output-kind lens — per-cell decoration (dim non-matching cells) | queued (same `notebookCellDecoration` ceiling) |
| 🔵 | FSP-002 collapse state promotion (option B: `metadata.rts.cells[<id>].metadata.rts.cell.collapsed`) | queued |
| 🔵 | Inspect mode session lineage (which `claude_session_id` produced each turn across `/branch` / `/revert`) | queued |
| 🔵 | FSP-001 OpenUI button (cells as clickable UI affordances) | queued |
| 🔵 | Multi-provider campaign (`gpt-cli` / `gemini` / `ollama`) | design doc not yet authored |

Observed velocity is roughly 10× the BSP-005 "working day" budget
(which was sized for one mega-round agent in series); see [BSP-005 §6.5](docs/03%20-%20Blueprint/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update).

## Where definitions live

The doc tree has three normative layers:

- **[`docs/atoms/`](docs/04%20-%20Reference/atoms/)** — canonical definitions for every reusable
  noun, verb, rule, decision, and anti-pattern. ~91 atoms across 7 subdirectories
  (`concepts`, `operations`, `discipline`, `decisions`, `anti-patterns`,
  `protocols`, `contracts`). When an atom and a longer spec disagree on what a
  thing IS, the atom wins.
- **[`docs/rfcs/`](docs/05%20-%20Standards/rfcs/)** — public boundary contracts (wire format, file
  format, transport, failure surface). Normative for behavior + wire shape.
- **[`docs/notebook/`](docs/03%20-%20Blueprint/)** — BSPs (build sequence proposals),
  FSPs (feature spec proposals), PLAN-S* slice plans. Normative for substrate
  behavior + slice sequencing.

[`docs/decisions/`](docs/02%20-%20Implementation/decisions/) holds the original 16 design ADRs
(MADR-lite format, design-conversation provenance). The newer
[`docs/atoms/decisions/`](docs/04%20-%20Reference/atoms/decisions/) holds the V1/V2 implementation
decisions (PLAN-§4 row IDs like D1-D8 / S1-S6 / etc.) — distinct namespace.

## RFCs (V1)

| # | Title | Status |
|---|---|---|
| [001](docs/05%20-%20Standards/rfcs/RFC-001-mcp-tool-taxonomy.md) | V1 MCP tool taxonomy | Draft; implemented (13 tools) |
| [002](docs/05%20-%20Standards/rfcs/RFC-002-claude-code-provisioning.md) | Claude Code provisioning procedure | Draft v1.0.1; implemented |
| [003](docs/05%20-%20Standards/rfcs/RFC-003-custom-message-format.md) | Custom Jupyter message format | **Superseded by RFC-006** |
| [004](docs/05%20-%20Standards/rfcs/RFC-004-failure-modes.md) | Failure-mode analysis + fault-injection harness | Draft; implemented |
| [005](docs/05%20-%20Standards/rfcs/RFC-005-llmnb-file-format.md) | `.llmnb` file format | Draft v1.0.2; implemented |
| [006](docs/05%20-%20Standards/rfcs/RFC-006-kernel-extension-wire-format.md) | Kernel↔extension wire format | Draft v2.1.0; implemented |
| [007](docs/05%20-%20Standards/rfcs/RFC-007-tape-otlp-logs.md) | `.tape` files (OTLP/JSON Logs) | Queued; stub spec |
| [008](docs/05%20-%20Standards/rfcs/RFC-008-kernel-host-integration.md) | Kernel host integration (PTY + socket + TCP) | Draft v1.0.1; implemented |
| [009](docs/05%20-%20Standards/rfcs/RFC-009-zone-control-and-config.md) | Zone control + config precedence | Draft; implemented |

## BSPs / FSPs / PLAN-S* slice plans

[`docs/notebook/`](docs/03%20-%20Blueprint/) holds:

- **BSP-002** — conversation graph (turns + agents-as-refs)
- **BSP-003** — writer / intent registry (canonical mutation path)
- **BSP-004** — kernel runtime (legacy `main()` dispatch path)
- **BSP-005** — cell roadmap (the current slice ladder)
- **BSP-006** — embedded ASGI sketch (deferred V2)
- **BSP-007** — overlay git semantics (commits, refs, merge correctness)
- **BSP-008** — ContextPacker + RunFrames module spec
- **FSP-001 / 002 / 003** — cells → OpenUI, in-cell search + collapse, test campaign
- **PLAN-S\* series** — per-slice execution plans (S0.5 through S10, plus the
  S5.0.x cell-magic + executor + injection-defense substreams)
- **KB-notebook-target.md** — the target architecture; §0 pins V1 amendments
- **PLAN-atom-refactor.md** — the executed plan for the atom-layer refactor

## Repo layout

```
llmb_rts_notebook/
├── README.md                            ← you are here
├── LICENSE                              ← GPL v3
├── CLAUDE.md                            ← Claude Code project guidance
├── pixi_guide.md                        ← Pixi CLI quick reference
├── pyproject.toml / pixi.lock           ← Pixi workspace
├── Engineering_Guide.md                 ← project-level engineering practices
├── Testing.md                           ← test architecture reference
├── docs/                                ← normative documentation
│   ├── README.md
│   ├── atoms/                           ← canonical definitions (~91 atoms, 7 subdirs)
│   ├── rfcs/                            ← public boundary contracts (RFCs 001-009)
│   ├── notebook/                        ← BSPs / FSPs / PLAN-S* / KB-target
│   ├── decisions/                       ← 16 original design ADRs (MADR-lite)
│   └── dev-guide/                       ← 8 chapters from the design conversation
├── extension/                           ← VS Code extension (subtractive fork output)
├── llm_client/                          ← Python CLI + executor + transport (`llmnb`)
├── tests/                               ← Python driver/CLI test suite
├── tools/                               ← one-off maintenance scripts
├── vendor/
│   ├── LLMKernel/                       ← submodule, our kernel fork
│   └── vscode-jupyter/                  ← submodule, microsoft/vscode-jupyter (read-only baseline)
└── _ingest/                             ← decomposition pipeline (frozen)
```

## Quick start

```bash
# Build the extension
pixi run -e kernel npm --prefix extension install
pixi run -e kernel npm --prefix extension run build
pixi run -e kernel npm --prefix extension run package

# Run extension contract tests
pixi run -e kernel npm --prefix extension run test:contract

# Run kernel tests (LLMKernel submodule)
pixi run pytest vendor/LLMKernel/tests/

# Open VS Code on a .llmnb file → cells dispatch via @@spawn / @@agent / @
```

See [extension/README.md](extension/README.md) for extension-specific build
+ test detail, and [pixi_guide.md](pixi_guide.md) for the Pixi env setup.

## License

GPL v3 — see [LICENSE](LICENSE).
