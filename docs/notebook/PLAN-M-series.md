# Plan: M-series — comment cells, annotations, promoted cells, per-agent panel

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship the four lightweight UX features grouped under M1-M4 — operator comment cells, in-cell annotations, promoted cells, and a per-agent inspection panel — as a single coordinated extension slice. Each is small enough that a per-letter PLAN doc is overkill; this single doc briefs all four.
**Time budget**: 1.5 days total. Pure extension. Single-agent (X-EXT-M).

---

## §1. Why this work exists

After S0.5 → S10, V1 ships. The M-series is a polish sprint over the V1 surface: small features that punch above their weight in operator quality-of-life and lay groundwork for V2's richer notebook narrative tools.

- **M1 — Comment cells.** Operator-prose cells (`kind: "markdown"` per [concepts/cell-kinds](../atoms/concepts/cell-kinds.md)) get first-class authoring affordances. `kind` is already wired in S0.5; this adds the UX.
- **M2 — Annotations.** Within-turn text annotations (highlights, notes) anchored to a span range, persisted as `add_overlay` intents per [concepts/overlay-commit](../atoms/concepts/overlay-commit.md).
- **M3 — Promoted cells.** Operator promotes a span out of an agent turn into its own cell. The kernel side ([operations/promote-span](../atoms/operations/promote-span.md)) already exists; M3 wires the operator-side gesture.
- **M4 — Per-agent panel.** A focused inspection view for one agent: head turn, recent runs, session id, work_dir, model. Complements the agents tree from [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md).

Drivers: BSP-005 follow-ups (the M-letter slices in earlier discussions; absorbed into BSP-005 §"Cross-cutting concerns" tail and folded into V1 polish). All four atoms exist already; this plan wires the extension UX around them.

Hard dependencies:
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) shipped (`kind: "markdown"` for M1).
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) shipped (overlay-commit machinery for M2 / M3).
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) shipped (RunFrame data feeds M4).
- [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) shipped (M4 augments the agents tree).

## §2. Goals and non-goals

### Goals

- **M1**: VS Code "Add markdown cell" creates a cell with `kind: "markdown"`, `bound_agent_id: null`, `section_id: <inherit>`. No agent, no execution, no run frame.
- **M2**: Operator selects text inside a cell output, right-click → "Annotate"; annotation persists as an `add_overlay` intent per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md). Annotations re-render on file open.
- **M3**: Operator right-clicks on an agent span, "Promote to cell" — submits `promote_span` operation per [operations/promote-span](../atoms/operations/promote-span.md); a new cell appears immediately after the source cell.
- **M4**: Sidebar agent node has a "Inspect" affordance opening a webview panel for that agent: head turn body, last 5 RunFrames, session id, work_dir, model.

### Non-goals

- AI-authored annotations (V2+; per [discipline/scratch-beats-config](../atoms/discipline/scratch-beats-config.md), V1 keeps annotations operator-authored).
- Annotation threads / replies (V2+).
- M3 cross-cell promotion (lifting a span from one cell into a different section) — V1 places the promoted cell immediately after the source cell per [operations/promote-span](../atoms/operations/promote-span.md).
- M4 timeline scrubbing or per-turn diff (V2+; V1 just lists the recent RunFrames).

## §3. Concrete work

### 3.1 M1 — Comment cells (~2h)

1. **Cell-creation hook.** When VS Code emits `vscode.workspace.onDidChangeNotebookDocument` with a new markdown cell, the extension's controller submits `set_cell_metadata` with `kind: "markdown"`, `bound_agent_id: null`. See [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md).
2. **Disable execution.** The notebook controller's `executeCells` handler skips cells of `kind: "markdown"` (no kernel dispatch).
3. **Visual treatment.** Apply a "comment" gutter color via the existing decoration provider (S1 + S10 layers). Operator-prose cells are visibly distinct from agent cells.
4. **Section inheritance.** New comment cell inherits its predecessor's `section_id` if present.

### 3.2 M2 — Annotations (~5h)

5. **Annotation model.** Annotations are `add_overlay` operations per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md) with `parameters: { kind: "annotation", target_span_id, range: { start, end }, body, author: "operator" }`. See [concepts/overlay-commit](../atoms/concepts/overlay-commit.md) for the operation kinds list.
6. **Selection → command.** `extension/src/notebook/annotations/annotate-command.ts` registers `llmnb.annotate.add` triggered from a selection's right-click menu. Reads `vscode.window.activeTextEditor.selection`, computes the target span id from the cell's output, opens an input box for the annotation body, submits the intent.
7. **Annotation rendering.** A renderer plugin reads `metadata.rts.zone.overlays.<turn_id>[]` filtered to `kind: "annotation"`, layers them as inline highlights via `vscode.TextEditorDecorationType`. Hover shows the body.
8. **Edit + delete.** Right-click on an existing annotation → "Edit" / "Delete". Edits submit a new `add_overlay` (annotations are append-only; edits create a successor that supersedes the predecessor by `range` overlap).

### 3.3 M3 — Promoted cells (~2h)

9. **Promotion command.** `extension/src/notebook/promote/promote-command.ts` registers `llmnb.promote.span`. Right-click on a span (text or tool-call output) → submits `apply_overlay_commit` with one `promote_span` operation per [operations/promote-span](../atoms/operations/promote-span.md).
10. **New cell placement.** Per the operation atom, the promoted cell is placed immediately after the source cell, same section. Cell `kind` is inferred per Decision D7: `propose_edit` → `artifact`; agent prose → `artifact`; `report_completion` → `checkpoint`.
11. **Rendering.** The new cell renders the promoted span as its primary content; the source cell is unaffected — promotion is a copy, not a move.

### 3.4 M4 — Per-agent panel (~3h)

12. **Inspect command.** `extension/src/sidebar/agent-inspect-panel.ts` registers `llmnb.agent.inspect`, surfaced from the agents tree node's inline action.
13. **Webview content.** Renders:
    - Agent identity: id, provider, model, work_dir, claude_session_id.
    - Runtime status: alive/idle/exited badge with PID.
    - Head turn: body preview (first 500 chars, linkified to the source cell).
    - Last 5 RunFrames: cell_id link, status, started/ended, manifest summary count.
14. **Live updates.** Subscribes to the same `onLastAcceptedVersion` hook as [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md). Refreshes on every snapshot.

## §4. Interface contracts

No new wire envelopes. All M-series operations route through existing intent kinds:

- M1: `set_cell_metadata` (existing).
- M2: `add_overlay` (existing per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md) registry).
- M3: `apply_overlay_commit` containing `promote_span` (existing per [operations/promote-span](../atoms/operations/promote-span.md)).
- M4: pure read-side; no envelopes.

Internal extension API additions: `extension/src/notebook/annotations/types.ts`, `extension/src/notebook/promote/types.ts`, `extension/src/sidebar/inspect-types.ts`. None are public.

## §5. Test surface

In `extension/test/notebook/`:

- `m1-comment-cells.test.ts`:
  - `test_new_markdown_cell_sets_kind_markdown`.
  - `test_markdown_cell_skips_execution`.
  - `test_markdown_cell_inherits_section_id`.
- `m2-annotations.test.ts`:
  - `test_annotate_command_submits_add_overlay`.
  - `test_annotation_renders_after_reload`.
  - `test_edit_annotation_supersedes_predecessor_by_range`.
  - `test_delete_annotation_creates_tombstone`.
- `m3-promote.test.ts`:
  - `test_promote_span_submits_apply_overlay_commit`.
  - `test_promoted_cell_placed_after_source`.
  - `test_promoted_cell_kind_inferred_correctly` — parameterized on D7's three cases.

In `extension/test/sidebar/`:

- `m4-agent-inspect.test.ts`:
  - `test_inspect_panel_renders_agent_identity`.
  - `test_inspect_panel_lists_last_five_runframes`.
  - `test_inspect_panel_live_updates_on_snapshot`.

Expected count: 12 extension tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| M1 markdown cells accidentally trigger spawn (operator types `/spawn` in a markdown cell) | Cell controller short-circuits BEFORE directive parsing for `kind: "markdown"`. Test: `test_markdown_cell_skips_execution`. |
| M2 annotation overlay grows unbounded with edits | Append-only with range supersession is correct per [discipline/save-is-git-style](../atoms/discipline/save-is-git-style.md); V2 may add compaction. |
| M3 promotion duplicates content (a copy is intentional, but operator confusion possible) | Tooltip + confirm dialog on first promote per session: "This creates a new cell with the selected span. Continue?" |
| M3 produces an `artifact` kind which is V2-reserved per [concepts/cell-kinds](../atoms/concepts/cell-kinds.md) | The atom says reserved kinds render inert; M3 produces them but the renderer handles them via [concepts/output-kind](../atoms/concepts/output-kind.md) — verify this works in practice or scope D7 to map to `agent` for V1. Decision flagged for operator. |
| M4 panel becomes stale across notebook switches | Panel listens to `vscode.window.onDidChangeActiveNotebookEditor` and either re-targets or shows an empty state. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/cell-kinds.md](../atoms/concepts/cell-kinds.md) — `markdown` row's "Shipped" status confirmed live in M1; `artifact` reserved-kind handling decision flagged in M3 risk.
- [operations/promote-span.md](../atoms/operations/promote-span.md) — Status flips to `V1 shipped (operator-side gesture wired)`.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `add_overlay` row's atom link points at a real annotation use case after M2.
- [concepts/overlay-commit.md](../atoms/concepts/overlay-commit.md) — `add_overlay` and `promote_span` entries among the 17 operation kinds now actively used.
- [discipline/save-is-git-style.md](../atoms/discipline/save-is-git-style.md) — annotations as commits reinforce this discipline; no change.
- [concepts/run-frame.md](../atoms/concepts/run-frame.md) — M4 panel reads RunFrames; no shape change.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 12](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — M1 builds on `kind` field.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — overlay-commit machinery for M2 / M3.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section inheritance for M1; section_id propagation on M3.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrame data feeds M4.
- [PLAN-S7-sidebar-trees.md](PLAN-S7-sidebar-trees.md) — M4 panel surfaces from the agent node's inline action.
- [PLAN-S10-three-pane-search.md](PLAN-S10-three-pane-search.md) — gutter coordination with annotation decorations.

## §9. Definition of done

- [ ] All 12 new extension tests pass.
- [ ] M1 smoke: add a markdown cell with `Add markdown` button → snapshot shows `kind: "markdown"`, no execution attempt.
- [ ] M2 smoke: select text in an output, "Annotate" → enter body → close & reopen → annotation re-renders inline.
- [ ] M3 smoke: right-click an agent span → "Promote" → new cell appears immediately after; original span unaffected.
- [ ] M4 smoke: from the agents tree, click "Inspect" on alpha → panel opens, shows current head turn body, last 5 RunFrames, live-updates on a new turn.
- [ ] [operations/promote-span.md](../atoms/operations/promote-span.md) Status updated.
- [ ] BSP-005 changelog updated with the M-series commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
