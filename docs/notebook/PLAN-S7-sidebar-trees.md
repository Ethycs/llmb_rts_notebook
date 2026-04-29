# Plan: S7 — Sidebar Activity Bar trees

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship three `vscode.TreeDataProvider` implementations (zones, agents, recent activity) backed by `metadata.rts.{layout, agents, sections, event_log, run_frames}`, registered under a new VS Code Activity Bar entry. Live-update on every Family F snapshot.
**Time budget**: 1 day. Pure extension. Single-agent (X-EXT-S7).

---

## §1. Why this work exists

After S6, the kernel persists every conversation, every section, every RunFrame. The operator can see ONE notebook well, but cannot navigate across:
- Zones in the workspace (one per `.llmnb` file).
- Agents in the active zone (alpha, beta, …) — clicking an agent should jump to its first cell.
- Recent activity — event log entries with click-through to the relevant cell.

Driver: [BSP-005 §"S7"](BSP-005-cell-roadmap.md). Atoms: [concepts/zone](../atoms/concepts/zone.md), [concepts/agent](../atoms/concepts/agent.md), [concepts/section](../atoms/concepts/section.md), [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md), [protocols/family-f-notebook-metadata](../atoms/protocols/family-f-notebook-metadata.md).

Hard dependencies:
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) shipped — section nodes appear in the agents tree.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) shipped — RunFrames feed the recent-activity tree.

## §2. Goals and non-goals

### Goals

- New Activity Bar container `llmnb.activityBar` with three views.
- **Zones tree** — one node per open `.llmnb` workspace; expanding shows agents and sections.
- **Agents tree** — for the active notebook, lists agents with their `runtime_status`. Each agent expands to its head turn id and a "jump to first cell" affordance.
- **Recent activity tree** — chronological list of event-log entries (spawn, branch, revert, stop, ref-move, run start/end), most recent first; clicking an entry jumps to the relevant cell.
- Live updates — the trees re-render on every Family F snapshot via the metadata-applier's `onLastAcceptedVersion` hook.

### Non-goals

- No tree-side editing (rename agent, delete section). Mutations go through cell directives or commands per [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) / [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md).
- No cross-workspace search — that's [PLAN-S10-three-pane-search.md](PLAN-S10-three-pane-search.md).
- No tree drag-and-drop in V1.
- No avatar / per-agent color theming beyond what S1 already provides.

## §3. Concrete work

1. **Activity Bar container.** Add to `extension/package.json`:
   ```jsonc
   "contributes": {
     "viewsContainers": {
       "activitybar": [
         { "id": "llmnb", "title": "RTS Notebook", "icon": "$(notebook)" }
       ]
     },
     "views": {
       "llmnb": [
         { "id": "llmnb.zones",    "name": "Zones" },
         { "id": "llmnb.agents",   "name": "Agents" },
         { "id": "llmnb.activity", "name": "Recent activity" }
       ]
     }
   }
   ```

2. **`ZonesTreeProvider`** — `extension/src/sidebar/zones-tree.ts`:
   - Root nodes = open `.llmnb` workspace files.
   - Children = `Agents` virtual node + `Sections` virtual node.
   - `getChildren("Agents")` reads `metadata.rts.zone.agents` from the active document.
   - `getChildren("Sections")` reads `metadata.rts.zone.sections[]`.

3. **`AgentsTreeProvider`** — `extension/src/sidebar/agents-tree.ts`:
   - Root nodes = `metadata.rts.zone.agents.*`.
   - Each agent node carries `id`, `provider`, `runtime_status` (per [agent atom §"Schema"](../atoms/concepts/agent.md)), with the runtime_status rendered as a colored badge (matching S1 conventions).
   - Children of an agent: `head_turn_id`, `last_seen_turn_id`, `claude_session_id`, `pid`, `model`.
   - Inline action: "Jump to first cell" — uses the kernel-side back-reference `turn.cell_id` from the agent's first turn.

4. **`ActivityTreeProvider`** — `extension/src/sidebar/activity-tree.ts`:
   - Source: `metadata.rts.event_log[]` plus `metadata.rts.zone.run_frames.*`.
   - Render most-recent-first.
   - Entry types: `agent_spawn`, `agent_branch`, `agent_revert`, `agent_stop`, `ref_move`, `run_start`, `run_end`.
   - Click → `vscode.commands.executeCommand("revealNotebookCell", entry.cell_id)`.

5. **Live updates.** All three providers wire to the metadata-applier's `onLastAcceptedVersion` hook (existing per [protocols/family-f-notebook-metadata](../atoms/protocols/family-f-notebook-metadata.md)). On every accepted snapshot, fire `onDidChangeTreeData`. Throttle to 200ms to avoid flicker on bursty turns.

6. **Empty states.** Each tree shows "No zones open", "No agents", "No recent activity" with helpful hints. Empty-state copy lives in `extension/src/sidebar/empty-states.ts`.

## §4. Interface contracts

This is a pure read-side slice. No new wire envelopes.

The trees consume:
- `metadata.rts.layout.*` — for zone display order ([protocols/family-b-layout](../atoms/protocols/family-b-layout.md)).
- `metadata.rts.zone.agents.*` — agent state ([concepts/agent](../atoms/concepts/agent.md)).
- `metadata.rts.zone.sections[]` — section state ([concepts/section](../atoms/concepts/section.md)).
- `metadata.rts.event_log[]` — event entries ([protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md)).
- `metadata.rts.zone.run_frames.*` — run records ([concepts/run-frame](../atoms/concepts/run-frame.md)).

Internal `TreeNode` types defined in `extension/src/sidebar/types.ts`; no public API.

## §5. Test surface

In `extension/test/sidebar/`:

- `zones-tree.test.ts`:
  - `test_zones_tree_lists_open_workspaces`.
  - `test_zones_tree_expands_to_agents_and_sections`.
- `agents-tree.test.ts`:
  - `test_agents_tree_renders_runtime_status_badge`.
  - `test_agents_tree_jump_to_first_cell_command`.
  - `test_agents_tree_live_updates_on_snapshot`.
- `activity-tree.test.ts`:
  - `test_activity_tree_chronological_order`.
  - `test_activity_tree_click_reveals_cell`.
  - `test_activity_tree_includes_run_frames`.
- `empty-states.test.ts`:
  - `test_empty_state_no_zones`.
  - `test_empty_state_no_agents`.

Expected count: 9 extension tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Live-update storm during a long agent run (many spans / Family F snapshots) | 200ms throttle; the providers diff incoming snapshots against last-rendered state and only emit `onDidChangeTreeData` if a tree-relevant field changed. |
| Stale tree after a notebook close (provider holds onto disposed metadata-applier) | Each provider listens for `vscode.workspace.onDidCloseNotebookDocument` and clears state. |
| Click-through fails for a `cell_id` that no longer exists (deleted overlay) | Reveal command falls back to "cell not found" notification with the entry's `created_at` for context. |
| Section status badges drift from cell decorations (S1 + S5.5 share style assumptions) | Single source: a `getStatusBadgeColor(status)` helper in `extension/src/sidebar/badge-style.ts` consumed by both. |
| Rendering 10k event-log entries blocks the UI | Virtual-scroll handled by `TreeView` natively; the activity tree caps loaded entries at 500 most-recent and shows a "Load more" affordance. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/zone.md](../atoms/concepts/zone.md) — verify the kernel-side zone definition is still the only normative source.
- [concepts/agent.md](../atoms/concepts/agent.md) — sidebar uses every field; verify atom and code agree on enum values.
- [concepts/section.md](../atoms/concepts/section.md) — sidebar reads `cell_range[]` order; confirm atom invariant about ordering.
- [protocols/family-d-event-log.md](../atoms/protocols/family-d-event-log.md) — verify the entry kinds the sidebar consumes are all enumerated.
- [protocols/family-f-notebook-metadata.md](../atoms/protocols/family-f-notebook-metadata.md) — `onLastAcceptedVersion` hook contract verified.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 10](PLAN-v1-roadmap.md) — ship-ready bullet flipped here.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — sections appear in the zones tree.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrames feed the activity tree.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — event log entries from `/branch`, `/revert`, `/stop` render in the activity tree.
- [PLAN-S10-three-pane-search.md](PLAN-S10-three-pane-search.md) — search results may surface sidebar entries; minor coordination.
- [PLAN-M-series.md](PLAN-M-series.md) — M4 (per-agent panel) lives logically alongside the agents tree; could be a tab on the agent node detail.

## §9. Definition of done

- [ ] All 9 new extension tests pass.
- [ ] Activity Bar entry visible; clicking opens the three-tree sidebar.
- [ ] Live-update smoke: spawn an agent → tree updates within 200ms; emit a turn → activity tree gets a new top entry.
- [ ] Click-through smoke: click an event log entry → the corresponding cell is revealed and selected in the editor.
- [ ] Empty-state smoke: open a fresh workspace with no `.llmnb` files → all three trees show their empty-state copy.
- [ ] BSP-005 changelog updated with slice commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
