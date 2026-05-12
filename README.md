# llmb_rts_notebook

An RTS-style operator interface for supervising fleets of autonomous
coding agents, delivered as a VS Code extension. V1 forks
`vscode-jupyter` subtractively, wires LLMKernel as the sole kernel,
and uses bidirectional MCP as the structured communication channel
between operator and agent.

The repo started life as a 1.1 MB design conversation
(`chat-export-2026-04-26T04-22-39.md`) — that conversation is the
historical source of truth for the original architectural choices.
The current normative reference is the doc tree under [`docs/`](docs/),
with [`docs/atoms/`](docs/atoms/) holding canonical definitions and
[`docs/notebook/`](docs/notebook/) + [`docs/rfcs/`](docs/rfcs/)
holding behavioral and wire-format specs.

## Status — V1 kernel feature-complete + Inspect mode shipped (2026-05-07)

V1 cell-side substrate is shipped end-to-end. Operator `@@spawn` /
`@@agent` / `@<flag>` cell-magic dispatches; agent processes spawn and
persist via `--resume`; multi-turn cells, cross-agent context handoff,
and the headless executor all work. The cell schema collapsed in S5.0
to `{text, outputs, bound_agent_id}` with kind/flags parse-derived from
text via the `@@` cell-magic + `@` line-magic vocabulary
([magic atom](docs/atoms/concepts/magic.md)).

**V1.6+ shipped since 2026-05-02:**

- **BSP-007 overlay graph** — operator-side, git-style commits over
  the agent turn DAG. `apply_commit` / `revert_to_commit` / `diff` /
  `branch` primitives; 17 V1 op kinds; §6 cell-merge correctness
  validators; K90-K95 failure modes. ([commit `3a430cb`](docs/notebook/BSP-007-overlay-git-semantics.md))
- **BSP-008 RunFrames + ContextPacker integration** — every agent
  turn now persists a `record_context_manifest` + start/terminal
  `record_run_frame` trail through the BSP-003 intent path.
  ([commit `3a430cb`](docs/notebook/BSP-008-contextpacker-runframes.md))
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
  [`docs/ops/validate-serve-mode.md`](docs/ops/validate-serve-mode.md).
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

Test surface: **795 kernel tests + 225 stub contract tests + 100
outer driver tests** all green; full kernel suite runs in ~30s under
xdist.

Shipped slices (per [BSP-005 §6.5](docs/notebook/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update)):

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
| ⬜ | S5.5 sections, S7 sidebar trees, History mode panel, S10 three-pane + search | queued |

Observed velocity is roughly 10× the BSP-005 "working day" budget
(which was sized for one mega-round agent in series); see [BSP-005 §6.5](docs/notebook/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2--and-observed-velocity-2026-05-02-update).

## Where definitions live

The doc tree has three normative layers:

- **[`docs/atoms/`](docs/atoms/)** — canonical definitions for every reusable
  noun, verb, rule, decision, and anti-pattern. ~91 atoms across 7 subdirectories
  (`concepts`, `operations`, `discipline`, `decisions`, `anti-patterns`,
  `protocols`, `contracts`). When an atom and a longer spec disagree on what a
  thing IS, the atom wins.
- **[`docs/rfcs/`](docs/rfcs/)** — public boundary contracts (wire format, file
  format, transport, failure surface). Normative for behavior + wire shape.
- **[`docs/notebook/`](docs/notebook/)** — BSPs (build sequence proposals),
  FSPs (feature spec proposals), PLAN-S* slice plans. Normative for substrate
  behavior + slice sequencing.

[`docs/decisions/`](docs/decisions/) holds the original 16 design ADRs
(MADR-lite format, design-conversation provenance). The newer
[`docs/atoms/decisions/`](docs/atoms/decisions/) holds the V1/V2 implementation
decisions (PLAN-§4 row IDs like D1-D8 / S1-S6 / etc.) — distinct namespace.

## RFCs (V1)

| # | Title | Status |
|---|---|---|
| [001](docs/rfcs/RFC-001-mcp-tool-taxonomy.md) | V1 MCP tool taxonomy | Draft; implemented (13 tools) |
| [002](docs/rfcs/RFC-002-claude-code-provisioning.md) | Claude Code provisioning procedure | Draft v1.0.1; implemented |
| [003](docs/rfcs/RFC-003-custom-message-format.md) | Custom Jupyter message format | **Superseded by RFC-006** |
| [004](docs/rfcs/RFC-004-failure-modes.md) | Failure-mode analysis + fault-injection harness | Draft; implemented |
| [005](docs/rfcs/RFC-005-llmnb-file-format.md) | `.llmnb` file format | Draft v1.0.2; implemented |
| [006](docs/rfcs/RFC-006-kernel-extension-wire-format.md) | Kernel↔extension wire format | Draft v2.1.0; implemented |
| [007](docs/rfcs/RFC-007-tape-otlp-logs.md) | `.tape` files (OTLP/JSON Logs) | Queued; stub spec |
| [008](docs/rfcs/RFC-008-kernel-host-integration.md) | Kernel host integration (PTY + socket + TCP) | Draft v1.0.1; implemented |
| [009](docs/rfcs/RFC-009-zone-control-and-config.md) | Zone control + config precedence | Draft; implemented |

## BSPs / FSPs / PLAN-S* slice plans

[`docs/notebook/`](docs/notebook/) holds:

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
├── chat-export-2026-04-26T04-22-39.md   ← historical source of truth
├── Engineering_Guide.md                 ← project-level engineering practices
├── docs/                                ← normative documentation
│   ├── README.md
│   ├── atoms/                           ← canonical definitions (~91 atoms, 7 subdirs)
│   ├── rfcs/                            ← public boundary contracts (RFCs 001-009)
│   ├── notebook/                        ← BSPs / FSPs / PLAN-S* / KB-target
│   ├── decisions/                       ← 16 original design ADRs (MADR-lite)
│   └── dev-guide/                       ← 8 chapters from the design conversation
├── extension/                           ← VS Code extension (subtractive fork output)
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
