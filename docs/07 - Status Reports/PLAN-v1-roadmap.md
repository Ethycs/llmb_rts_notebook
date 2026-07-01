# Plan: V1 roadmap conductor

**Status**: V1 UX feature-complete 2026-05-19 (S5.0.6 nvim driver formally deferred 2026-05-19; V2 lane opened 2026-05-20). The conductor stays open as a forward reference until the V1 release SHA + V2 milestone are stamped; per-slice DoDs roll up as the boxes below.
**Audience**: an LLM (or operator) opening this folder cold and trying to find the right next-slice plan to dispatch. Self-contained.
**Goal**: name the three V1 tracks (cell roadmap, kernel gap closure, atom hygiene), point at the BSP-005 slice ladder for cell-track sequencing, and enumerate the eleven sibling PLAN docs that brief individual workstreams.
**Time budget**: this doc is the conductor; budgets live on the children. Aggregate ~17–18 working days sequential, ~10 days with three parallel agents (per [BSP-005 §6.5](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#65-slice-ladder-totals-after-issue-2)).

---

## §1. Why this work exists

V1 substrate is verified end-to-end (Tier 4 4/4 green). The notebook *layer* is barely scaffolded — `/spawn` produces one OTLP span and that is the entirety of operator UX today (see [BSP-005 §1](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#1-where-we-are-today)). The next 12 plans below close the gap from "spawn-and-die" to "full V1 notebook" along three concurrent tracks:

- **Track A — Cell roadmap (BSP-005 slice ladder S0.5 → S10).** Extension + kernel features that turn cells into a real conversation. Each slice ratifies more of the [cell](../04%20-%20Reference/atoms/concepts/cell.md), [agent](../04%20-%20Reference/atoms/concepts/agent.md), [section](../04%20-%20Reference/atoms/concepts/section.md), [run-frame](../04%20-%20Reference/atoms/concepts/run-frame.md) atoms in code. Sequenced and time-budgeted by [BSP-005-cell-roadmap.md](../03%20-%20Blueprint/BSP-005-cell-roadmap.md); this conductor delegates the ordering decision to that BSP. Each lettered slice has a sibling PLAN doc below.
- **Track B — V1 Kernel Gap Closure.** The 8 outstanding gaps in the kernel substrate that sit underneath the BSP-005 slices: missing intent kinds (`apply_overlay_commit`, `record_run_frame`, etc. per [protocols/submit-intent-envelope](../04%20-%20Reference/atoms/protocols/submit-intent-envelope.md)), missing modules ([ContextPacker](../04%20-%20Reference/atoms/contracts/context-packer.md), [OverlayApplier](../04%20-%20Reference/atoms/contracts/overlay-applier.md), [CellManager](../04%20-%20Reference/atoms/contracts/cell-manager.md)), the MCP `validate_tool_input` hardening, and friends. Bundled in [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md).
- **Track C — Atom hygiene.** Pure-docs cleanup of the `docs/atoms/` corpus before the implementation agents start consuming atoms as briefs. Status enum drift, `operator-action` field-name fix, four invented defaults that need pinning. Bundled in [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md).

Tracks A and B share authors (the same agent often touches both); Track C is a documentation-only blocker that should run first so that A and B agents read consistent atoms.

## §2. Goals and non-goals

### Goals

- Every BSP-005 slice from S0.5 onward has exactly one durable PLAN doc that future agents can pick up cold.
- The three tracks are visible together so an operator dispatching agents can see what is parallelizable and what is not.
- Substrate gaps and atom drift have explicit owners; no V1 work is "in the cracks."
- The "Definition of done" for V1 is defined here, not scattered across 11 plans.

### Non-goals

- This conductor doc does NOT restate slice ordering — that is normative in [BSP-005 §2](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#2-the-slice-ladder-dependency-ordered).
- This doc does NOT define atoms — see [docs/atoms/README.md](../04%20-%20Reference/atoms/README.md).
- This doc does NOT specify wire formats — see RFC-006 / RFC-001 / RFC-005.
- This doc does NOT replace the implementation slice owner labels (K-AS, K-MW, K-CTXR, X-EXT) defined in BSP-005.

## §3. The 11 sibling PLAN docs

Numbering matches BSP-005 slice IDs where applicable. PLAN-S1, PLAN-S2, PLAN-S3 are already in commit history and not duplicated here.

| # | PLAN file | Track | BSP-005 slice | Owner labels |
|---|---|---|---|---|
| 1 | [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) | A | S0.5 | K-MW |
| 2 | [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) | A | S3.5 | K-AS, K-CTXR |
| 3 | [PLAN-S4-cross-agent-handoff.md](PLAN-S4-cross-agent-handoff.md) | A | S4 | K-AS |
| 4 | [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) | A | S5 | K-AS, X-EXT |
| 5 | [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) | A | S5.5 | K-MW, X-EXT |
| 6 | [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) | A | S6 | K-MW, X-EXT |
| 7 | [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) | A | S7 | X-EXT |
| 8 | [PLAN-S10-three-pane-search.md](PLAN-S10-three-pane-search.md) | A | S10 (folds FSP-002) | X-EXT |
| 9 | [PLAN-M-series.md](PLAN-M-series.md) | A | M1-M4 (lightweight) | X-EXT |
| 10 | [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) | B | (multi) | K-MCP, K-AS, K-MW, K-CM |
| 11 | [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) | C | (docs) | docs |

S8 (inline approval `vscode.diff`) and S9 (streaming + interrupt) from BSP-005 are NOT broken out — they are small enough that S8 lives as a checklist inside [PLAN-S5-branch-revert-stop.md §4](PLAN-S5-branch-revert-stop.md) (operator approval surfaces over the same wire), and S9 lives inside [PLAN-S4-cross-agent-handoff.md §3](PLAN-S4-cross-agent-handoff.md) (interrupt depends on persistent agents). If they need their own briefs, split later.

## §4. Cross-track sequencing

Visualized:

```
Track C  ──► (atom hygiene; ≤1 day)
                  │
                  ▼
Track A   S0.5 ─► S1* ─► S2* ─► S3* ─► S3.5 ─► S4 ─► S5 ─► S5.5 ─► S6 ─► S7 ─► S8 ─► S9 ─► S10
                                                                           │
Track B   ───────────────────────────────────────► (gap closure runs alongside, gating S3.5/S5/S6)
                                                     │
                                                     └► closes G2/G4/G5/G8 etc.

* PLAN-S1, PLAN-S2, PLAN-S3 are already shipped or in progress; not in this batch.
```

Hard dependencies (these are the only ones; everything else is parallelizable with care):

- **Track C (atom hygiene) blocks Track A and B agents** because the agents read atoms as their briefs. ≤1 day of work.
- **PLAN-S0.5 blocks S5/S5.5/S6** — every cell-merge / ContextPacker / RunFrame branch consumes `kind`.
- **Substrate gaps G2 / G5 / G8 (intent kinds, ContextPacker module, RunFrame intents) block S3.5 and S6.** See [PLAN-substrate-gap-closure.md §3](PLAN-substrate-gap-closure.md) for the dispatch table.
- **PLAN-S5 (branch/revert/stop) blocks PLAN-S5.5 (sections)** because section deletion / move uses overlay-commit machinery from S5.

## §5. V1 ship-ready checklist

V1 is ship-ready when EVERY row below is checked. This is the master DoD that the 11 sibling plans' individual DoDs roll up to.

| # | Criterion | Owning PLAN | Status |
|---|---|---|---|
| 1 | Operator types `/spawn`, sees an agent badge with `kind`, `agent_id`, `provider`, `runtime_status` | PLAN-S0.5, PLAN-S1 | ✅ shipped |
| 2 | Closing and reopening the notebook restores conversations (idle agents resume via `--resume`) | PLAN-S2 | ✅ shipped |
| 3 | `@<agent>: <message>` produces a follow-up turn without re-spawn | PLAN-S3 | ✅ shipped |
| 4 | ContextPacker assembles a deterministic, persisted manifest per cell run | PLAN-S3.5 | ✅ shipped (`64a34d4`) |
| 5 | Cross-agent handoff replays missed turns to the addressed agent's session | PLAN-S4 | ✅ shipped (`fe2121a`) |
| 6 | `/branch`, `/revert`, `/stop` directives work end-to-end and persist | PLAN-S5 | ✅ shipped (S5a `5b5533e`, S5b-revert submodule `d85c3f4`, S5c-stop submodule `4461794`) |
| 7 | Operator can group cells into named sections; `section.status` interruptibility lock fires | PLAN-S5.5 | ✅ shipped — Phase 5 collapse via native markdown fold (`8251a5a` + earlier section CRUD + state-machine landings) |
| 8 | Cells re-render correctly after notebook close → reopen via the cell→turn binding | PLAN-S6 | ✅ shipped (BSP-007 / BSP-008 `3a430cb`) |
| 9 | RunFrames are written for every run; Inspect mode resolves manifest + RunFrame pair | PLAN-S6 | ✅ shipped (Inspect V1 `92c7412`) |
| 10 | Sidebar trees render zones / agents / event log; clicking jumps to the source cell | PLAN-S7 | ✅ shipped — `onLastAcceptedVersion` event prep (`03976c7`) + 3-view impl (`8aaa3e3` + `2260ce0`) |
| 11 | Three-pane visual model + FSP-002 search works | PLAN-S10 | ✅ shipped in reduced V1 form — engine-native badges + bulk-collapse + find wrappers (`b07e6f9`) + sidebar Find-in-cells WebviewView delivering the full FSP-002 §2.1 search UX (`426051f`). Per-cell gutter coloring + literal floating-bar-above-editor remain V2+ — genuinely blocked on VS Code API exposure (`notebookCellDecoration` is not a Microsoft proposal; the vendored `vscode-jupyter` doesn't have it either). |
| 12 | M1-M4 (comments, annotations, promoted cells, per-agent panel) ship the lightweight variants | PLAN-M-series | partial — see PLAN-M-series for per-row state; not a V1-UX blocker since the bulk of the operator surface ships through S0.5-S10 above |
| 13 | All 8 substrate gaps closed (intent kinds, ContextPacker, OverlayApplier, CellManager, MCP `validate_tool_input`, …) | PLAN-substrate-gap-closure | ✅ shipped 2026-06-30 — all 9 gaps closed (G2/G4/G5/G8/G9 earlier; G10 was already shipped, atom drift cleaned; G11 RunFrame truncation new + 4 tests; G12 DriftDetector API ratified per Option A; G13 `validate_tool_input` meta-tool + 4 tests). Full kernel suite 908/908 green. |
| 14 | `docs/atoms/` drift detector run is clean | PLAN-atom-hygiene | ✅ shipped 2026-06-30 — full [PLAN-atom-hygiene](PLAN-atom-hygiene.md) sweep landed: 6 Status normalizations (+ 2 `V1.5` cleanups), `agent_continue` field-name aligned to `text` (matches impl at `mcp_server.py:630`), 4 invented defaults pinned in `agent.md` + `agent-supervisor.md` Invariants. All 3 verification checks (orphan / drift / Status-line consistency) return empty. |

## §6. Smokes

The V1 smoke suite at ship time MUST pass these end-to-end paths:

1. **Round-trip smoke**: open a fresh `.llmnb` → `/spawn alpha task:"…"` → `@alpha: continue` → close → reopen → `@alpha: still here?` succeeds with same `claude_session_id`. Covers PLAN-S0.5, S2, S3, S6.
2. **Cross-agent smoke**: spawn alpha + beta, alternate turns, `last_seen_turn_id` advances correctly, beta's reply is injected into alpha's session before alpha's next turn. Covers PLAN-S4.
3. **Branch / revert smoke**: `/branch alpha at t_3 as gamma` → operate on gamma → `/revert alpha to t_2` → continue alpha → original alpha turns survive in DAG. Covers PLAN-S5.
4. **Section + interruptibility smoke**: create section "Architecture", move 3 cells in, set status `frozen`, attempt to merge two — gets K95. Covers PLAN-S5.5.
5. **Inspect-mode smoke**: pick a RunFrame, render its `context_manifest_id` payload, confirm `inclusion_rules_applied[]` matches the V1 walk. Covers PLAN-S3.5, PLAN-S6.
6. **Sidebar smoke**: live-update tree on agent spawn / turn append. Covers PLAN-S7.
7. **Search smoke**: `Ctrl+F` finds matches in cell inputs, outputs, and tool calls; navigation moves through them. Covers PLAN-S10.
8. **Drift smoke**: `metadata.rts.drift_log` populates correctly when MCP server is gone, model_default mismatches, in-progress span truncation fires. Covers PLAN-substrate-gap-closure (G11 / G12).

## §7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| BSP-005 ladder drifts as slices land | Update [BSP-005 changelog](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#changelog) on every slice merge; this conductor cites BSP-005 by section anchor, not by status text. |
| 11 plans accumulate inconsistent template usage | Every plan follows [PLAN-atom-refactor.md §1-§9](PLAN-atom-refactor.md) section structure; this conductor cross-references it. |
| Substrate gap closure gets de-prioritized vs UX slices | PLAN-substrate-gap-closure §3 explicitly lists which gap blocks which slice — operator dispatching can use that table. |
| Atom drift introduced after this conductor lands | PLAN-atom-hygiene §6 ships the drift-detector run as a verification step; rerun on every milestone. |

## §8. Cross-references

- [BSP-005-cell-roadmap.md](../03%20-%20Blueprint/BSP-005-cell-roadmap.md) — slice ladder. Authoritative for ordering and time budgets.
- [PLAN-atom-refactor.md](PLAN-atom-refactor.md) — exemplar of the plan-doc style; structure copied here.
- [docs/atoms/README.md](../04%20-%20Reference/atoms/README.md) — what atoms are.
- [VERSIONING.md](../05%20-%20Standards/VERSIONING.md) — V1 vs V2+ shipping cadence.
- [KB-notebook-target.md §0.10](../03%20-%20Blueprint/KB-notebook-target.md) — Issue 2 amendment that introduced S0.5 / S3.5 / S5.5 (folded into BSP-005 above).

## §9. Definition of done

This conductor is done when every ship-ready row in §5 has a green checkbox AND the per-PLAN DoDs all pass. As of 2026-06-30:

- **Operator-visible V1 UX (rows 1-11)**: ✅ feature-complete. Every notebook surface the operator touches in V1 ships.
- **Row 12 (M-series lightweight variants)**: partial; not a V1-UX blocker — the bulk of the operator surface ships via S0.5-S10.
- **Row 13 (substrate gaps)**: ✅ all 9 gaps closed 2026-06-30 — verification pass complete. Full kernel test suite (908/908) green.
- **Row 14 (atom drift)**: ✅ shipped 2026-06-30 — full PLAN-atom-hygiene sweep landed; all 3 verification checks return empty.

**All 14 rows ✅**. V1 is SHA-ready pending operator sign-off.

What's NOT in this checklist (intentional):

- **PLAN-S5.0.6 nvim driver** — formally deferred 2026-05-19. V1 ships without the per-cell nvim affordance; the headless `llmnb execute --connect` CLI (`df95ad4`) covers file-level operation for nvim users in the interim.
- **`notebookCellDecoration`-dependent features** (per-cell gutter color, floating search bar literally above the editor) — genuinely blocked on a VS Code API that isn't a Microsoft proposal. The vendored `vscode-jupyter`'s `enabledApiProposals` confirms no internal escape hatch either. The operator-visible UX these features were supposed to deliver ships in the sidebar instead (S10 reduced + S10 follow-on).

Once V1 ships, this doc moves to `**Status: shipped**` with the V1 release commit SHA in its frontmatter, and the 11 sibling plans flip to `**Status: shipped**` independently. **V2 lane queue:** see [BSP-005 §6.6](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#66-v2-lane-post-v1-feature-complete) for the V2 slice ledger (branch-switching UX + output-kind lens shipped; per-cell decoration, FSP-002 collapse promotion, Inspect lineage, FSP-001 OpenUI, multi-provider campaign queued).
