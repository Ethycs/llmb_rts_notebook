# Roadmap

**Status:** **V1 shipped — `v1.0.0` tagged 2026-06-30.** All 14 rows of the [PLAN-v1-roadmap §5](../07%20-%20Status%20Reports/PLAN-v1-roadmap.md) ship-ready checklist ✅. Historical milestones: V1 UX feature-complete 2026-05-19; V2 lane open with two slices shipped (2026-05-20 + 2026-05-29); substrate gap closure + atom hygiene sweeps landed 2026-06-30. V2 campaign continues in §2.
**Owners:** project lead + future you.
**Cadence:** updated when a campaign closes, when a ceiling is discovered, or when an honest deferral changes the queue.

This is the strategic narrative — *where the project is going and why*. The operational analogs:

- **What's done?** → [`../07 - Status Reports/PLAN-v1-roadmap.md §5`](../07%20-%20Status%20Reports/PLAN-v1-roadmap.md) — the 14-row V1 ship-ready checklist.
- **What's the next slice?** → [`../03 - Blueprint/BSP-005-cell-roadmap.md`](../03%20-%20Blueprint/BSP-005-cell-roadmap.md) — V1 slice ladder (§6.5) and V2 lane queue (§6.6).
- **How do I implement it?** → individual `PLAN-S*.md` / `PLAN-V2-*.md` slice plans under [`../07 - Status Reports/`](../07%20-%20Status%20Reports/).

The forward-looking strategic bets live here.

---

## 1. Where we are (2026-06-30)

**V1 shipped — `v1.0.0` tagged 2026-06-30.** The operator-supervision UX ships on the public VS Code extension API surface. Every BSP-005 ladder slice from S0.5 through S10 either landed or is formally deferred with a documented reason. Row 13 (substrate gaps) and Row 14 (atom drift) of the V1 ship-ready checklist both closed 2026-06-30 — the kernel test suite is 908/908 green and all three atom-hygiene verification checks return empty.

The repo's headline shape:

- **Kernel substrate** (LLMKernel) — feature-complete since the BSP-007 overlay applier + BSP-008 RunFrames landed (`3a430cb`). Persistent agents, turn DAG, sections, RunFrames + ContextManifests, in-tree event log, magic-driven file encode/decode, headless `--connect` TCP attach all in place.
- **Extension** — Activity Bar entry with 5 sidebar views (Zones / Agents / Recent activity / Find in cells / Output kinds), per-cell streaming + artifact badges, sections rendered as native markdown folds, in-cell search via WebviewView, bulk-collapse + find wrapper commands.
- **CLI** — `llmnb execute` + `llmnb serve` + `llmnb execute --connect tcp://…` for non-VS-Code drivers.

The next campaign is **V2**: build on V1's persisted data with operator-visible read-side surface, plus the substantive scope expansions V1 explicitly deferred (multi-provider, gutter decoration when the API exposes).

## 2. V2 lane

### 2.1 Shipped (2026-05-20 → 2026-05-29)

Both pure read-side, no kernel changes:

- **Branch-switching UX** (`667dd68`) — Agents sidebar surfaces a `Branches` subnode under each agent that has forked descendants. Lineage recovered from `metadata.rts.zone.event_log[*]` `fork_agent` envelopes. Click a branch → reveal its first cell. Sets the precedent: existing V1-persisted data is fair game for V2 sidebar surface without re-shaping the wire.
- **Output-kind lens UI** (`85bd5e4`) — 5th sidebar view (`llmnb.outputKinds`) grouping every span tagged with `llmnb.output.kind` by kind. High-attention kinds (decision / question / warning / diagnostic) render first; forward-compat `<other>` bucket for unknown values. Realizes the V1 promise that "V1 ships the tag; V2 ships the lens."

### 2.2 Queued — short horizon (next 1-3 sessions)

| Slice | Scope | Why now |
|---|---|---|
| **Output-kind lens — per-cell decoration** | Dim cells whose outputs don't match the active filter | Closes the lens story. Blocked on `notebookCellDecoration` API surface (same ceiling as the V1 three-pane gutter); see §4. |
| **FSP-002 collapse state promotion** (option B) | Per-cell collapse state travels with the `.llmnb` file | Adds `set_cell_metadata_bulk` intent to BSP-003 writer registry; ~1 day. Unblocks collaborative scenarios. |
| **Inspect mode session lineage** | Inspect mode shows which `claude_session_id` produced each turn across `/branch` / `/revert` | Pure read-side; session ids already persisted. ~half day. |
| **FSP-001 OpenUI button** | Cells as clickable UI affordances (turn a cell into a button) | Requires re-reading FSP-001; new cell-kind + renderer work. ~1-2 days. |

### 2.3 Queued — long horizon (multi-session campaigns)

- **Multi-provider campaign** — agents beyond `claude-code`. The headline V2 feature. Requires authoring `PLAN-V2-multi-provider.md` first, then dispatching per-provider implementations (`gpt-cli`, `gemini`, `ollama`). Touches `AgentSupervisor` (provider abstraction), the wire envelope (already has a `provider` slot per turn), per-provider drivers + tests. Estimate: ~1 week per provider; ~2-3 weeks for the campaign to feel complete.

## 3. V2.5+ / V3 territory (longer horizon)

These are tracked here so they don't get re-discovered every session:

- **Bulk-collapse promotion to `metadata.rts`** (V2.5+) — FSP-002 §4 option B. Becomes operator-collaborative (machine A collapses, machine B sees it). Depends on `set_cell_metadata_bulk` (§2.2).
- **Operator-defined custom lenses** (V2.5+) — saved filter sets ("my triage lens"). Builds on §2.1 output-kind lens.
- **Cross-zone / cross-notebook concepts** (V3+) — currently V1's data model is per-zone; no cross-notebook agents, turns, or sections.
- **L3 full event-sourcing** (V3+) — demote `metadata.rts.*` from primary persisted form to *only* derived from `event_log[]`. PLAN-S6.0 was explicit that V1 ships L2 (in-tree event log + snapshot cache) and V3 territory is "snapshot becomes purely derived."
- **V3 RTS "live filter" search mode** (FSP-002 §7) — cells matching the search pattern stay visible; non-matching dim. Useful for incident response.
- **V4 multi-everything** — search across notebooks (workspace-scoped); operator orchestrating cross-zone fleets.

## 4. Genuine ceilings (and what would unlock them)

Things that don't ship not because we haven't done them but because the platform doesn't expose them:

| Ceiling | What blocks it | What would unlock |
|---|---|---|
| **Per-cell gutter color / focused border** | `vscode.NotebookCellDecorationProvider` does not exist in v1.92 and is **not a Microsoft API proposal**. Probe against vendored `vscode-jupyter`'s `enabledApiProposals` confirms no internal escape hatch. | Microsoft proposing + graduating a `notebookCellDecoration` API. We watch the proposal stream. |
| **Literal floating search bar above the editor** | No overlay-above-editor API on v1.92. Native Ctrl+F find widget isn't extension-customizable. `vscode-jupyter` accepts this too. | Same — a `notebookEditorOverlay` API proposal that hasn't been made. |
| **Per-cell collapse via cell metadata** | `NotebookCell.metadata` is read-only at runtime; the renderer doesn't honor a `collapsed` key. | A renderer-honored `collapsed` metadata field, which Microsoft hasn't proposed. |

**Distribution escape hatches** (if any of these were ever load-bearing for us):

1. **Side-loaded VSIX** with `--enable-proposed-api ethycs.llmb-rts-notebook` — works per-machine; doesn't scale to fleet deployment.
2. **Bundled VS Code distribution** with our extension pre-installed + proposed APIs baked in. Heavy install (~200 MB).
3. **Editor fork** (Cursor-style). Months of work + ongoing upstream maintenance.

None are worth pursuing today; the sidebar placement already delivers the operator-visible UX these ceilings were supposed to enable.

## 5. Architectural non-goals (out of scope)

What we will *not* build, so we don't have to re-justify it every session:

- **Jupyter-domain features** — interactive Python REPL window (`interactiveWindow` proposal), variables view (`notebookVariableProvider`), kernel-source picker (`notebookKernelSource`). The operator's mental model is multi-agent supervision, not single-language REPL.
- **Cross-notebook search** — Workspace search (Ctrl+Shift+F) covers file content. FSP-002 search is intentionally notebook-scoped.
- **Tree-side mutation of agents / branches** — `/spawn` and `/branch` happen via the magic vocabulary or CLI. The sidebar is for navigation, not mutation. ("Add a Fork from here button" → V2.5+ at earliest.)
- **Streaming token-by-token rendering** — V1 waits for `run.complete`. Streaming spans live; rendering them word-by-word is V2+ if the operator demand justifies the renderer complexity.

## 6. Open questions for the next session

These are queued for the next strategic check-in:

1. **When does V1 stamp a release SHA?** — Rows 1-11 of [PLAN-v1-roadmap §5](../07%20-%20Status%20Reports/PLAN-v1-roadmap.md) are ✅; row 13 (substrate gaps) verification ran 2026-05-07 against [`PLAN-substrate-gap-closure §3`](../07%20-%20Status%20Reports/PLAN-substrate-gap-closure.md) — **5 of 9 closed** (G2 / G4 / G5 / G8 / G9 confirmed shipped via BSP-007 + BSP-008 + S4.1 + S5 + S3.5 commits). Remaining substrate-gap blockers before V1 SHA: **G10 (CellManager module — likely unblocked since the overlay-applier covers the 17 op kinds), G11 (RunFrame in-progress truncation at hydrate), G12 (DriftDetector API alignment, ≤2h), G13 (MCP `validate_tool_input` hardening, ≤4h)**. Row 14 (atom drift) still needs a full detector run. Once G10-G13 close and the atom drift run is clean, the V1 SHA is justified.
2. **What's the multi-provider order?** — `gpt-cli` first (OpenAI API is best-documented), `gemini` second, `ollama` last (local-LLM concerns differ). Or alphabetical for deterministic pick? Author `PLAN-V2-multi-provider.md` to decide.
3. **Should we ship a side-loaded VSIX track** alongside the main Marketplace build? Only justified if a feature ever genuinely needs proposed APIs. Not today.
4. **Nvim driver revival** — PLAN-S5.0.6 is deferred pending nvim-operator dogfooding pressure. When does it return to the queue? Tied to the operator's actual nvim usage.

## 7. Trajectory summary (one-paragraph)

V1 is a vertical-slice supervisor UX for multi-agent Claude fleets, shipping today on a stable VS Code extension surface. V2 widens both axes: heterogeneous providers (multi-provider campaign) and richer read-side affordances (lens / branches / Inspect lineage / FSP-001 buttons). V2.5+ promotes operator-local state (collapse, custom lenses) into the `.llmnb` file so the supervision experience travels with the notebook. V3 expands beyond per-notebook to workspace-scope concerns (cross-notebook search, live filters). Throughout, we ship against the stable VS Code API and accept the genuine API ceilings (`notebookCellDecoration` is not Microsoft's roadmap) — the sidebar placement already covers the operator-visible UX the ceilinged surfaces were supposed to enable.

---

**Last updated:** 2026-05-30. Next review when a V2 short-horizon slice ships or when a new ceiling is discovered.
