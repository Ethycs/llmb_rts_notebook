# Plan: V2 branch-switching UX (sidebar Branches subnode)

**Status**: shipped 2026-05-20 (slice 1)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: surface the existing V1 `/branch` data model in the sidebar so the operator can see — and navigate between — forked agents without reading raw `metadata.rts`. First V2 slice on top of S7 + S5.

---

## §1. Why this work exists

V1 ships the data model for `/branch` (PLAN-S5 §S5a, commit `5b5533e` + submodule `da3aa2f`) — the operator can fork an agent at its head (Case A) or at an ancestor turn (Case B), and the kernel persists a new `metadata.rts.zone.agents.<new_id>` entry plus a `fork_agent` intent envelope in `metadata.rts.zone.event_log[]`. What V1 didn't ship was any UX: the operator who runs `/branch alpha-fork-1 of:alpha at:t_abc` has to mentally track that `alpha-fork-1` is a branch of `alpha`. There's no visible relationship in either the activity tree (which renders the `agent_branch` event but not the standing relationship) or the agents tree (which lists agents flat alphabetically).

This slice closes that gap. The agents sidebar gets a "Branches" subnode per agent that has forked descendants; clicking a branch row reveals its first cell.

## §2. Goals and non-goals

### Goals

- A new `Branches` subnode appears under each agent that has at least one fork in `metadata.rts.zone.event_log[]`.
- Expanding `Branches` lists each branch as `branch-agent` rows with:
  - The branch agent id.
  - A description showing the lineage (`← <source> @ <short turn> [<case>]`) + `runtime_status`.
  - A `git-branch` icon coloured by `runtime_status` (reuses S7's badge palette).
- Clicking a branch row fires `llmnb.revealCell` against the branch agent's first turn `cell_id` (mirrors the top-level Agents row's reveal command).
- Branches sort by capture time (earliest fork first); unknown-timestamp forks sort last.
- Pure read-side. No kernel changes. No new envelope types.

### Non-goals

- **No tree-side fork mutation.** `/branch` still happens via the magic vocabulary or the CLI. Adding a "Fork from here" button on the agent row is V2.5+.
- **No "switch head" affordance.** Moving an agent's head between branches is `/revert`, not a separate sidebar action. Operators can already do this via the magic vocabulary; the sidebar's job here is navigation, not mutation.
- **No nested-branch tree of arbitrary depth.** Branches of branches DO appear under their immediate parent's Branches subnode (because the lineage map is recursive), but we don't collapse the visual hierarchy — each agent renders at its place in the flat top-level list AND under its parent's Branches subnode, so the operator can navigate from either entry point.
- **No detection of "which branch is currently active."** All branches are equal citizens of the agent map. The operator picks the active one by clicking a cell — the bound_agent_id on that cell determines which branch the next run engages.

## §3. Concrete work

### §3.1 Pure lineage builder

`extension/src/sidebar/agent-lineage.ts` — new module. Single entry point:

```ts
export function buildAgentLineage(
  snapshot: RtsSnapshot | undefined
): { parents: Map<string, ForkRecord>; children: Map<string, ForkRecord[]> };
```

The builder walks `metadata.rts.zone.event_log[]`, picks out captured envelopes with `payload.action_type === "zone_mutate"` and `payload.parameters.intent_kind === "fork_agent"`, and indexes the `source_agent_id` / `new_agent_id` pairs. Children buckets sort chronologically.

A helper `extractForkRecord(entry)` discriminates a single event-log entry. Legacy `agent_ref_move` records are silently skipped (those carry revert/branch *event* labels but not the lineage payload).

`rootAgentIds(agentIds, lineage)` filters the agent map to those that are NOT branches — used by future refinements if we want to fold the top-level list to roots only. The current slice keeps the flat list.

### §3.2 Tree extensions

`extension/src/sidebar/types.ts` — `AgentsNode` gains two new variants:

```ts
| { kind: 'branches-root'; parentAgentId: string }
| {
    kind: 'branch-agent';
    sourceAgentId: string;
    branchAgentId: string;
    atTurnId: string | null;
    case: 'A' | 'B' | undefined;
  };
```

`extension/src/sidebar/agents-tree.ts` — `getChildren` for an `agent` row now appends a `branches-root` node when `lineage.children.get(agentId).length > 0`. `branches-root` expands to one `branch-agent` per fork record. The `branch-agent` `getTreeItem` builds the row with the `git-branch` codicon, a coloured icon via `getAgentStatusBadgeColor`, and a `command: llmnb.revealCell` against the branch agent's `turns[0].cell_id`.

### §3.3 Test surface

| File | Tests |
|---|---|
| `extension/test/contract/sidebar-agent-lineage.test.ts` | 8 pure-unit tests pinning the extraction, sort, and root-filter logic. |
| `extension/test/contract/sidebar-agents-tree.test.ts` | 5 new tests (appended to the existing S7 file) covering no-forks / one-fork / reveal-command / lineage-description / multi-fork sort. |

Total: 13 new tests; 359 stub-tier passing after this slice.

## §4. Interface contracts

No wire changes. Pure read-side from `metadata.rts.zone.event_log[]` per [PLAN-S6.0 §3.A](PLAN-S6.0-event-log-substrate.md#3a-storage-location).

## §5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Lineage map rebuilds on every `getChildren` call (small N², no caching) | The event_log is small in practice (capped at 500 entries by S6.0). For larger logs the map could be cached against a snapshot-version key in a future iteration. Not blocking for V2. |
| The same agent renders twice (once at the top level, once under its parent's Branches subnode) | Intentional. Operators can navigate from either entry point; the duplication is informational, not a state machine. |
| Branch row's `runtime_status` reads from the LIVE agent map, which may be `idle` even when the kernel knows the process exists | The reveal command targets the branch agent's first cell regardless of runtime_status. If the branch hasn't run yet (zero turns), the reveal command no-ops with a logger warning — acceptable for V1. |

## §6. Atom + doc updates

- `docs/atoms/concepts/agent.md` — V1 vs V2+ section: branch-switching UX moves to "V2 partial-ship" with a back-reference to this PLAN.
- This file (`PLAN-V2-branch-switching-ux.md`) is the slice record.

## §7. Definition of done

- [x] All 13 new extension tests pass (8 lineage + 5 tree).
- [x] `Branches` subnode appears only when an agent has forks in the event_log.
- [x] Branch row description includes source agent id + short turn id + case tag.
- [x] Branch row click reveals the branch's first cell.
- [x] agent.md V2+ section updated.
- [x] BSP-005 changelog (V2 lane) reflects the slice — [BSP-005 §6.6](../03%20-%20Blueprint/BSP-005-cell-roadmap.md#66-v2-lane-post-v1-feature-complete) V2 lane section added 2026-05-30 with the branch-switching row (`667dd68`).
