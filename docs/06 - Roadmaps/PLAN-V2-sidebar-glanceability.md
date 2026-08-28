# Plan: V2 sidebar glanceability (live status, badges, inline actions)

**Status**: shipped 2026-08-27 (A1-A4 in one pass; three parallel agents wrote the pure modules + T0 tests, orchestrator composed the vscode wiring)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: make the existing S7 sidebar trees carry the "fleet at a glance" load the RTS pivot (DR-0001) promised — animated live-status, count badges, per-node decorations, and inline quick actions — using only stable VS Code API (`engines: ^1.92.0`, zero `enabledApiProposals`).

---

## §1. Why this work exists

DR-0001 kept the RTS framing as *interaction vocabulary*: select, assign, observe, override. V1 shipped select + observe as static TreeViews (S7, commit `8aaa3e3`): agents render as `person` codicons colored by `runtime_status` via `badge-style.ts`, and the operator reads state by expanding rows. That works, but it is a *directory*, not a *command display*: nothing moves when an agent is streaming, there is no fleet-level summary visible without opening the sidebar, and every action (interrupt, reveal, grant) requires either the cell toolbar or the command palette.

An evaluation of spatial-map alternatives (SVG+d3, WebGPU canvas, server-rendered snapshots) concluded the highest-ROI move is not a new render substrate — it is making the trees we already ship glanceable and actionable. Everything needed is stable API, most of it shipped years before our 1.92 floor:

| Capability | API | Stable since |
|---|---|---|
| Animated streaming indicator | `ThemeIcon('loading~spin')` | ~1.62 |
| Fleet count badge on the Activity Bar icon | `TreeView.badge` (`ViewBadge`) | 1.72 |
| 2-char colored badges per node | `FileDecorationProvider` + custom URI scheme | 1.53 |
| Inline hover actions | `view/item/context` menus, `"group": "inline"` | forever |
| Rich hover cards | `TreeItem.tooltip: MarkdownString` | 1.34 |

## §2. Goals and non-goals

### Goals

- An agent that is actively running (`runtime_status === 'alive'` with an in-flight run) renders a **spinning `loading~spin` icon** instead of the static `person` icon. The status is visible in the periphery without reading text.
- The **Agents view carries a numeric badge** on its Activity Bar container: the count of currently-alive agents. Zero alive → no badge. The operator sees fleet load without opening the sidebar.
- Every agent row gets a **`FileDecorationProvider` badge** (2-char, colored) encoding the highest-attention condition: `!!` needs-attention (pending permission / question output-kind), `▶` running, `✗` terminated abnormally. Decorations propagate to parent nodes, so a zone with a needs-attention agent shows it at the zone level too — the closest stable analog to NATO-style categorical glyphs.
- Agent rows get **inline quick actions** on hover: reveal first cell (`llmnb.revealCell`), interrupt (`llmnb.interruptCell` routed to the agent's active cell), and open the branch subtree. Preemption is the operator's core right per DR-0001; interrupt earns its place on the row.
- Agent rows get a **Markdown tooltip card**: agent id, status, provider, turn count, last-activity timestamp, active section — the "unit card" an operator would otherwise assemble from three trees.
- Pure read-side except interrupt, which reuses the existing S9 command. No kernel changes, no wire changes, no new envelope types.

### Non-goals

- **No drag-and-drop.** `TreeDragAndDropController` is stable, but reparenting an agent has no backing kernel intent — a drop target with no `zone_mutate` to fire is mutation theater. Out until a real re-zone intent exists.
- **No tree-side spawn/fork buttons.** ROADMAP §5 non-goal stands: `/spawn` and `/branch` happen via the magic vocabulary or CLI. Interrupt is the one mutation allowed on the row, because preemption ≠ orchestration.
- **No checkbox bulk-select.** `TreeItem.checkboxState` is stable (1.80) and tempting for bulk interrupt, but bulk mutation needs a confirm surface we haven't designed. V2.5+ candidate; noted, not scoped.
- **No per-cell gutter decoration.** Still the known ceiling — `notebookCellDecoration` does not exist even as a proposal. This slice's cell-level analog remains the existing `NotebookCellStatusBarItemProvider` surface (Inspect mode).

## §3. Concrete work

Four sub-slices, ordered so each ships independently.

### §3.1 A1 — live-status icons + tooltip cards (~½ day)

`extension/src/sidebar/agents-tree.ts`:

- `getTreeItem` for `agent` rows: when the run-state map (see below) says the agent has an in-flight run, use `new vscode.ThemeIcon('loading~spin', getAgentStatusBadgeColor(status))`; otherwise keep the current `person` icon ([agents-tree.ts:138](../../extension/src/sidebar/agents-tree.ts#L138)).
- Add `item.tooltip = buildAgentTooltip(agent)` returning a `vscode.MarkdownString` (agent id, `runtime_status`, provider, turn count, last event timestamp, active section). `supportThemeIcons: true` so codicons render in the card.
- New pure helper `extension/src/sidebar/agent-run-state.ts`: derive `hasInFlightRun(agentId, snapshot)` from `metadata.rts.zone.run_frames` (a frame with `executor_id === agentId`, null `ended_at`, and a non-terminal `status`). Pure function over the snapshot — same pattern as `agent-lineage.ts` from the branch-switching slice.

### §3.2 A2 — fleet badge on the Agents view (~2 h)

`extension/src/extension.ts`:

- The four `createTreeView` calls at [extension.ts:517-577](../../extension/src/extension.ts#L517-L577) currently discard their return values. Capture the `llmnb.agents` handle.
- On every snapshot refresh: `agentsView.badge = aliveCount > 0 ? { value: aliveCount, tooltip: `${aliveCount} agents alive` } : undefined`.
- Refresh hook rides the same `onDidChangeNotebookDocument` path the providers already use — no new listener plumbing.

### §3.3 A3 — inline quick actions (~½ day)

`extension/package.json`:

- `view/item/context` contributions keyed on the existing `contextValue`s (`llmnb.sidebar.agent`, `llmnb.sidebar.branchAgent` — already set at [agents-tree.ts:140](../../extension/src/sidebar/agents-tree.ts#L140)):
  - `llmnb.revealCell` — `"group": "inline"`, icon `go-to-file`. Both contexts.
  - `llmnb.sidebar.interruptAgent` (new thin command) — `"group": "inline"`, icon `debug-stop`, `when` clause gated on a new contextValue variant `llmnb.sidebar.agent.running`.
- `extension/src/sidebar/interrupt-agent-command.ts` — resolves the agent's active cell from the run-state helper (§3.1) and delegates to the existing S9 interrupt path. No new kernel surface.
- `agents-tree.ts` — running agents get `contextValue = 'llmnb.sidebar.agent.running'` so the stop button only appears where it can act.

### §3.4 A4 — FileDecorationProvider badges (~1 day)

- `extension/src/sidebar/agent-decorations.ts` — new `vscode.FileDecorationProvider` registered for a custom scheme. Tree items gain `resourceUri: vscode.Uri.from({ scheme: 'llmnb-agent', path: `/${zoneId}/${agentId}` })`.
- `provideFileDecoration` maps the agent's condition to `{ badge, color, propagate: true }`:
  - `!!` + `charts.yellow` — needs attention (latest tagged span in `question`/`decision` output-kind, or pending privileged-emission grant).
  - `▶` + `charts.green` — in-flight run.
  - `✗` + `charts.red` — `terminated`.
  - No decoration otherwise (avoid badge noise; decorations are for exceptions, not steady state).
- `propagate: true` bubbles the badge to zone rows in the Zones tree, which shares the same `resourceUri` scheme.
- Priority ordering: needs-attention > running > terminated (one badge per node; highest-attention wins) — mirrors the output-kind lens ordering convention.
- Fire `onDidChangeFileDecorations` from the same snapshot-refresh hook as A2.

### §3.5 Test surface

| File | Tests |
|---|---|
| `extension/test/contract/sidebar-agent-run-state.test.ts` | ~8 pure-unit: in-flight detection, completed/errored runs, missing event_log, multi-agent. |
| `extension/test/contract/sidebar-agents-tree.test.ts` (append) | ~6: spin icon iff in-flight, tooltip content, `running` contextValue gating. |
| `extension/test/contract/sidebar-agent-decorations.test.ts` | ~8: badge selection per condition, priority ordering, propagate flag, no-decoration steady state. |
| `extension/test/contract/sidebar-view-badge.test.ts` | ~4: count derivation, zero → undefined. |

Total: ~26 new stub-tier tests.

## §4. Interface contracts

No wire changes. Reads `metadata.rts.zone.{agents, event_log}` per [PLAN-S6.0 §3.A](PLAN-S6.0-event-log-substrate.md). The one new command (`llmnb.sidebar.interruptAgent`) is a thin resolver over the existing S9 interrupt path — no new kernel intent.

## §5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `loading~spin` renders static in some themes/older hosts | It is the same mechanism core VS Code uses in its own trees; 1.92 floor is far past stabilization. Fallback is a static icon — degraded, not broken. |
| `FileDecorationProvider` badge is capped at 2 characters and composes with Explorer file decorations conventions | We only use it on our custom `llmnb-agent://` scheme, so no collision with Git/file decorations. 2 chars is enough for the three exception states. |
| Run-state derivation disagrees with actual kernel process state (event_log lag) | Same staleness class the S7 trees already accept; the interrupt command re-resolves the active cell at click time and no-ops with a warning if the run already completed. |
| Badge/decoration churn on every snapshot refresh causes flicker | Decoration events are keyed per-URI; only fire for agents whose derived condition changed (memoize last-emitted condition per agent). |
| Inline stop button misfires on a row the operator meant to expand | `when`-gated to `.running` contextValue; interrupt is already recoverable (agent restart machinery, SE-03/04 supervisor). |

## §6. Atom + doc updates

- `docs/04 - Reference/atoms/concepts/agent.md` — V2 section gains the glanceability surfaces (spin icon, decoration badge vocabulary, unit-card tooltip).
- [BSP-005 §6.6](../03%20-%20Blueprint/BSP-005-cell-roadmap.md) V2 lane table — add this slice row on ship.
- [ROADMAP §2.2](ROADMAP.md) — add to the short-horizon queue table (this plan is the scope column's target).
- This file is the slice record.

## §7. Definition of done

- [x] A1: streaming agents spin; every agent row has a Markdown unit-card tooltip. (`agent-run-state.ts`, 10 T0 tests)
- [x] A2: Agents view badge shows alive count; absent at zero. (`view-badge.ts`, 5 T0 tests)
- [x] A3: reveal + interrupt inline actions render on hover; stop button only on running rows (`.running` contextValue gate); interrupt re-resolves the run frame at click time and delegates to the S9 path. (`interrupt-agent-resolver.ts` + `interrupt-agent-command.ts`, 5 T0 tests)
- [x] A4: `!!` / `▶` / `✗` decorations render with priority ordering; propagation lands on the Zones tree's Agents subnode rather than the zone row itself — the zone row keeps its file URI so git decorations on the `.llmnb` file stay intact. (`agent-decoration-logic.ts` + `agent-decorations.ts`, 10 T0 tests)
- [x] 30 new T0 unit tests pass (63 unit total); stub tier 379 passing, no S7/V2 sidebar regressions. (Two kernel-handshake smokes flaked on a cold machine and passed on rerun — not sidebar-related.)
- [x] `package.json` still declares zero `enabledApiProposals`.
- [x] agent.md, BSP-005 §6.6, ROADMAP §2.1/§2.2 updated.

**Deviation notes (composition pass):**
- §3.1's original wording derived run state from `event_log.runs`; the real substrate is `zone.run_frames` (`executor_id` / `ended_at` / terminal-status set). §3.1 corrected.
- A4's attention condition reads OTLP spans from the top-level `metadata.rts.event_log.runs[]` (the lens's own extractor is vscode-bound and cell-output-based, so the pure module re-derives the walk — `// TODO(A4)` marks the fold-back condition).
- An inline reveal wrapper command (`llmnb.sidebar.revealAgent`) was added because menu invocations pass the tree element, not the `{cell_id}` shape `llmnb.revealCell` expects.
