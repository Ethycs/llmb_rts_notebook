# BSP-008: ContextPacker and RunFrames

**Status**: Issue 1 — Draft, 2026-04-28
**Related**: KB-notebook-target.md §0 (V1 amendments), §0.5 (RunFrames minimal), §0.6 (ContextPacker simple), §7 (scope from structure), §9 (RunFrame full schema), §18 (Inspect mode), §22.2 (ContextPacker open questions); BSP-002 (conversation graph; §4.6 cross-agent handoff is the V0 stand-in for ContextPacker); BSP-003 (writer registry — persistence path); BSP-007 (overlay git semantics — sibling, supplies stable `cell_id` across overlay commits); BSP-005 (V1 cell-roadmap slice ladder)

## 1. Scope and motivation

KB-target §7 declares: *"the kernel derives behavior from structure."* The operator reorganizes cells; pinned/excluded/checkpoint/scratch flags are visible toggles; the kernel turns that arrangement into the agent's context pack. That deriver must be a real, named module — not implicit logic scattered across the supervisor.

This BSP names two modules and pins their V1-minimal contracts:

- **ContextPacker** (KB-target §0.6, §22.2) — a pure function `pack(notebook_state, current_cell, current_section) → ContextManifest`. Walks the overlay structure, applies V1 inclusion/exclusion rules, emits a deterministic, ordered manifest of `turn_id`s.
- **RunFrame** (KB-target §0.5, §9) — a persisted snapshot of every cell run. Records which manifest the agent saw, what the turn head was before/after, and run status. Supplies the data Inspect mode (KB-target §18) needs to answer "what context did the agent see when this cell ran?"

Both modules persist through BSP-003's intent envelope. New `intent_kind` entries are added to BSP-003 §5.

**Out of scope (deferred to V2)**, per KB-target §0.6 and §22.2:

- Ranking policies (semantic weight, recency decay)
- Budget overflow strategies (drop-oldest, summarize-and-include)
- Summary trust model (operator-approved checkpoints vs auto-generated)
- Manifest diffing (when does adding a turn invalidate prior cache?)
- Retrieval (semantic search over excluded turns when budget allows)
- Full RunFrame fields beyond V1 (`parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions`)

The V1 contract intentionally underdelivers so Inspect mode has something concrete to render and so V2 can extend additively without reshaping the schema.

## 2. ContextPacker — purpose

ContextPacker is a **pure function**. Given a snapshot of notebook state, it returns a `ContextManifest` with no side effects.

```
pack(notebook_state, current_cell, current_section) → ContextManifest
```

"Pure function" means:

- **Deterministic.** Re-running on the same input produces the same manifest, byte-for-byte.
- **No side effects.** Reads the overlay; does not mutate it. Does not write to disk. Does not call agents or tools.
- **Inspectable.** Returns its inclusion-rule trace in the manifest itself (§4) so Inspect mode can show the operator *why* each turn was included or excluded.

Determinism is required for two downstream guarantees:

1. **Inspect mode (KB-target §18)** — replaying a manifest's input must reproduce the manifest exactly, otherwise "what the agent saw" is unfalsifiable.
2. **Replay** — re-running a run from its `RunFrame` (V2's `source_snapshot_id` + `overlay_commit_id`) must reproduce the same context.

ContextPacker is called by the AgentSupervisor (BSP-002 K-AS slice) before each operator turn is sent to its agent. Per KB-target §0.6, V1 ships a *dumb structural walker*; the existing BSP-002 §4.6 cross-agent context handoff is the V0 stand-in and is replaced by ContextPacker.

## 3. ContextPacker V1 algorithm

The V1 contract is pinned in [decisions/v1-contextpacker-walk.md](../atoms/decisions/v1-contextpacker-walk.md); the algorithm below is the implementation. Per KB-target §0.6, V1 is a deterministic structural-only walk. No ranking, no budget overflow, no summary trust.

```
input:  current cell c
        current section s (the section c belongs to; may be null if no sections defined)
        notebook overlay (cells, sections, flags, bindings)
output: ContextManifest = ordered, deduplicated list of turn_ids

V1 algorithm:

  1. include = []

  2. # Pinned cells, anywhere in the notebook
     for cell in notebook.cells where cell.flags.pinned:
       include += cell.bound_turn_ids

  3. # Previous cells in current section, chronological by overlay position
     if s is not null:
       for cell in s.cells where cell.position < c.position:
         if not (cell.flags.scratch or cell.flags.excluded or cell.flags.obsolete):
           include += cell.bound_turn_ids
     else:
       # No section context — fall back to "previous cells in document order"
       for cell in notebook.cells where cell.position < c.position:
         if not (cell.flags.scratch or cell.flags.excluded or cell.flags.obsolete):
           include += cell.bound_turn_ids

  4. # Current cell's prior sub-turns (only when merges have produced sub-turns;
     # KB-target §0.2 — fresh cells have no sub-turn numbering)
     include += c.sub_turn_ids[:current_sub_turn_index]

  5. # Deduplicate, preserving first-occurrence order.
     # First-occurrence order means pinned cells appear at the head of the
     # manifest if they would also have been included by the section walk.
     return dedupe(include)
```

The flags consulted (`pinned`, `excluded`, `scratch`, `obsolete`) are defined in KB-target §13.5 cell flags. Section membership is defined in BSP-002 Issue 2 (sibling K-BSP-002-AMEND); see KB-target §0.1 for the Zone→Section rename.

V2 will add, per KB-target §22.2:

- Ranking policies (semantic weight, recency decay)
- Budget overflow strategies (drop-oldest? summarize-and-include?)
- Summary trust ("did the operator approve this checkpoint?")
- Retrieval (semantic search over excluded turns when budget allows)
- Manifest diffing (when does adding a turn invalidate prior cache?)

V1 does none of those. The walk is structural and total.

## 4. ContextManifest schema

See [context-manifest atom](../atoms/concepts/context-manifest.md) for the schema and invariants. The V1 fields are listed below for the kernel implementer's convenience.

```jsonc
ContextManifest: {
  manifest_id: ulid,                            // unique; written via intent (§5)
  cell_id: string,                              // the cell being run
  section_id: string?,                          // the section the cell belongs to; null if unsectioned
  turn_ids: [turn_id, ...],                     // ordered, deduplicated; the agent's input
  inclusion_rules_applied: [                    // for Inspect mode (§11)
    { rule: "pinned",                  cells: [cell_id, ...] },
    { rule: "section_predecessor",     cells: [cell_id, ...] },
    { rule: "current_cell_sub_turns",  cells: [cell_id], turn_ids: [...] }
  ],
  exclusions_applied: [                         // for Inspect mode (§11)
    { reason: "scratch",     cells: [cell_id, ...] },
    { reason: "excluded",    cells: [cell_id, ...] },
    { reason: "obsolete",    cells: [cell_id, ...] }
  ],
  total_turn_count: number,                     // == turn_ids.length
  total_token_estimate: number?,                // V1 may leave null; V2 fills
  created_at: iso8601
}
```

`inclusion_rules_applied` and `exclusions_applied` are present for Inspect mode. They are not consulted by the agent; they are operator-facing telemetry. The agent only sees `turn_ids`.

`total_token_estimate` is reserved as `null` in V1. V2 fills it once the budget-overflow strategy lands. Adding the field non-null in V2 is additive and does not break V1 readers.

## 5. ContextManifest persistence

Manifests are persisted in `metadata.rts.zone.context_manifests.<manifest_id>`. This is a new collection per KB-target §19's persisted list ("context_manifests").

- **Append-only.** Manifests are not deleted. Inspect mode (KB-target §18) needs historical access — "what manifest did this run see three sessions ago?"
- **Referenced by RunFrame.** Each `RunFrame.context_manifest_id` points at one entry here.
- **Written through BSP-003 intent.** New `intent_kind: record_context_manifest`. Adds a row to BSP-003 §5 registry; payload is the full ContextManifest object.

```jsonc
// BSP-003 §5 addition:
| record_context_manifest | kernel (ContextPacker output) | context_manifests.<manifest_id> | Append-only; idempotent on manifest_id |
```

Validation (BSP-003 §6 step 4): the writer rejects a `record_context_manifest` whose `turn_ids` reference unknown turns (K103).

## 6. RunFrame — purpose

A RunFrame is a snapshot of every cell run. It records:

- Which cell ran (`cell_id`)
- Which agent ran it (`executor_id`)
- The agent's head turn before and after (`turn_head_before`, `turn_head_after`)
- Which manifest the agent saw (`context_manifest_id` → §4)
- Whether the run completed, failed, or was interrupted (`status`)

RunFrames are persisted so Inspect mode can answer two questions per cell:

1. *"What context did the agent see when this cell ran?"* — by following `context_manifest_id`.
2. *"What changed in the turn DAG as a result?"* — by diffing `turn_head_before` and `turn_head_after`.

Per KB-target §9, the full RunFrame includes more fields (parent run, snapshot, overlay commit, artifact windows, tool permissions). V1 ships only the minimum needed for Inspect mode and replay correctness; V2 adds the rest additively.

## 7. RunFrame V1 minimal schema

See [run-frame atom](../atoms/concepts/run-frame.md) for the schema and invariants (and [decisions/v1-runframe-minimal.md](../atoms/decisions/v1-runframe-minimal.md) for the V1 minimal-shape decision). Per KB-target §0.5, V1 ships:

```jsonc
RunFrame: {
  run_id: ulid,
  cell_id: string,
  executor_id: string,                          // agent_id (BSP-002 §2.2)
  turn_head_before: turn_id | null,             // null if first turn for this agent
  turn_head_after: turn_id | null,              // null if run failed before any turn committed
  context_manifest_id: ulid,                    // points at §4 ContextManifest
  status: "complete" | "failed" | "interrupted",
  started_at: iso8601,
  ended_at: iso8601?                            // null while running; set on terminal status
}
```

V2 adds, per KB-target §9:

- `parent_run_id` — chains for `@<agent>` follow-up turns (cross-agent handoff lineage)
- `source_snapshot_id` — pins the cell-source contents at run start
- `overlay_commit_id` — links the run to a BSP-007 overlay commit, so replay reconstructs the exact overlay state
- `artifact_windows[]` — which artifact ranges were materialized for the run
- `tool_permissions` — full capability table per KB-target §20

These are additive. V1 readers ignore unknown fields; V2 readers read the new fields when present.

## 8. RunFrame persistence

RunFrames are persisted in `metadata.rts.zone.run_frames.<run_id>`. New collection per KB-target §19.

- **Append-only.** Frames are not deleted.
- **Survives notebook close → reopen** via the existing `metadata.rts` hydrate path (RFC-005).
- **Indexed by `cell_id`** so Inspect mode can list "all runs for this cell." V1 implements the index as a linear scan over `run_frames.*`; V2 may add a precomputed `cell_id → [run_id]` index if scan cost matters.
- **Written through BSP-003 intent.** New `intent_kind: record_run_frame`.

```jsonc
// BSP-003 §5 addition:
| record_run_frame | kernel (AgentSupervisor) | run_frames.<run_id> | Append-only; idempotent on run_id |
```

A single run produces multiple intents over its lifetime: one `record_run_frame` at start (`status: "complete" | "failed" | "interrupted"` set at end via a follow-up `record_run_frame` with the same `run_id` — idempotency-on-`run_id` allows update-in-place for the terminal status field). V2 may split this into a separate `update_run_frame_status` intent if cleaner; V1's idempotency-by-id covers it.

## 9. Module placement

- **ContextPacker** — pure module at `vendor/LLMKernel/llm_kernel/context_packer.py`. Stateless. Imports `notebook_state` types, exports `pack(...) → ContextManifest`. Called by the AgentSupervisor (BSP-002 K-AS slice) before each operator turn is sent to its agent. Replaces the V0 stand-in in BSP-002 §4.6.
- **RunFrame writes** — through BSP-003's `submit_intent("record_run_frame", ...)`. The AgentSupervisor records start/end frames; the writer persists them (§8).
- **ContextManifest writes** — through BSP-003's `submit_intent("record_context_manifest", ...)`. The AgentSupervisor records the ContextPacker output (§5).

ContextPacker does not write directly. Pure function in, intent out — the AgentSupervisor wraps the call:

```
manifest = ContextPacker.pack(notebook_state, current_cell, current_section)
metadata_writer.submit_intent({
  intent_kind: "record_context_manifest",
  parameters: { manifest: manifest }
})
metadata_writer.submit_intent({
  intent_kind: "record_run_frame",
  parameters: {
    run_id: ulid(),
    cell_id: current_cell.id,
    executor_id: agent.id,
    turn_head_before: agent.head_turn_id,
    context_manifest_id: manifest.manifest_id,
    status: "complete",                  // updated on finish
    started_at: now(),
  }
})
agent.send_turn(operator_message, manifest.turn_ids)
# ... on completion, submit follow-up record_run_frame with same run_id and final status
```

## 10. Failure modes (K-class numbering, K100+)

K90s are reserved for BSP-007; K80s for RFC-009; K70s for FSP-003 test-infra. K100+ is clean for this BSP.

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K100 | ContextPacker called with a cell not present in the overlay (orphan cell) | `contextpacker_orphan_cell` with `cell_id` | Likely a stale reference; the cell was deleted from the overlay between scheduling and packing. Re-issue the run. |
| K101 | ContextPacker section-walk exceeds reasonable depth (cycle in section parent chain — section nesting bug) | `contextpacker_section_cycle` with `section_id`, `depth` | Corrupt overlay; report the section graph state. The pack returns the partial walk up to the cycle to keep the run from blocking; Inspect mode shows the truncation. |
| K102 | RunFrame write rejected (e.g., duplicate `run_id` from a different cell, validator failure) | `runframe_write_rejected` with `run_id`, `reason` | Surface to operator; the in-flight run continues but its provenance is degraded. |
| K103 | ContextManifest write rejected (e.g., references nonexistent `turn_ids`) | `manifest_write_rejected` with `manifest_id`, `unknown_turn_ids` | Likely a race between a turn-revert and a pack call. Re-pack; the operator may need to re-issue the run. |

K100 and K101 are detected inside ContextPacker. K102 and K103 are detected inside the BSP-003 writer's validator step (BSP-003 §6 step 4) and surface as `intent_validation_failed` (K42) refined with the ContextPacker-specific marker.

## 11. Inspect mode minimum

The V1 UX surface for these modules. KB-target §18 promises Inspect mode "reveals the machine"; without these views, the §0.6 ContextPacker discipline is invisible to the operator.

**Per-cell view** (cell-status-item or cell decoration; UX up to X-EXT):

> *"this cell ran 3 times; latest run = `run_X` (status: complete) with manifest = `manifest_Y` (12 turns included, 4 excluded as scratch/excluded)"*

Click → expands to show the latest manifest's inclusion/exclusion trace.

**Per-manifest view** (panel or detail pane):

> *"manifest `manifest_Y`:*
> - *included by rule `pinned`: cells [c_3, c_8]*
> - *included by rule `section_predecessor`: cells [c_12, c_13, c_14]*
> - *included by rule `current_cell_sub_turns`: cell c_15, turns [t_72.1]*
> - *excluded as `scratch`: cells [c_11]*
> - *excluded as `excluded`: cells [c_5]*
> - *total turns: 8; total tokens: (V1: not estimated)"*

This is the minimum Inspect mode promised by KB-target §18. **Without it, the §0.6 V1 ContextPacker discipline is invisible to operators** — they would see "the agent gave a different answer" without seeing "because the manifest changed when you pinned cell 3."

## 12. V1 implementation slice

Single ~2-day slice owned by **K-CTXR** (new owner code; coordinates with K-MW for intent-registry additions and K-AS for AgentSupervisor integration).

| Sub-slice | Time | Description |
|---|---|---|
| ContextPacker pure module + tests | ~0.5 day | `vendor/LLMKernel/llm_kernel/context_packer.py`. Deterministic walk per §3. Unit tests for each rule (pinned, section predecessor, sub-turns, scratch/excluded/obsolete exclusion, dedupe order). |
| Schemas + BSP-003 registry additions | ~0.5 day | ContextManifest (§4) and RunFrame (§7) schemas in `vendor/LLMKernel/llm_kernel/schemas/`. Add `record_context_manifest` and `record_run_frame` intent kinds to BSP-003 §5; implement validators for K103 (manifest turn_id validity) and K102 (run_id uniqueness). |
| AgentSupervisor integration | ~0.5 day | K-AS slice: call ContextPacker before each turn (replaces BSP-002 §4.6 V0 handoff); submit manifest + start RunFrame intents; submit terminal RunFrame intent on run end. |
| Extension Inspect mode minimum | ~0.5 day | X-EXT slice: cell-status item showing latest run + manifest summary (§11 per-cell view). Click-to-expand opens the per-manifest panel. Read-only in V1. |

**Prerequisites:**

- BSP-002 Issue 2 (sibling K-BSP-002-AMEND) — supplies the Section concept (KB-target §0.1 Zone→Section rename) that ContextPacker's algorithm walks.
- BSP-007 (sibling K-BSP-007) — supplies stable `cell_id` references across overlay commits, so RunFrame's `cell_id` field survives split/merge/reorder.

If either prerequisite is delayed, ContextPacker falls back to document-order walk (§3 step 3 fallback branch is the V1 graceful-degradation path).

## 13. Forward-compat

What V1 shapes do not need reshaping for V2:

- **ContextManifest** gains `total_token_estimate` (currently nullable), ranking metadata (`included_by_rank: [...]`), and budget-overflow trace (`dropped_for_budget: [...]`) without changing the existing fields. V1 readers ignore the new fields.
- **RunFrame** gains `parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, `tool_permissions` (KB-target §9 full schema). All additive.
- **Inspection UI** gets richer (token estimates, ranking explanations, budget-overflow visibility) on top of the existing per-cell + per-manifest views.
- **BSP-003 intents** gain new validators but the registry table only grows.
- **K-class codes** K104+ stay reserved for V2 ContextPacker failure modes (budget overflow rejected, ranking divergence detected, etc.).

The discipline: **V1 underdelivers in policy but commits to the schema shape.** V2 fills in the policy without migrating the data.

## Changelog

- **Issue 1, 2026-04-28**: initial draft. ContextPacker pure-function contract (§2, §3); ContextManifest schema (§4) and persistence (§5); RunFrame V1 minimal schema (§7) and persistence (§8); module placement (§9); K-class K100–K103 (§10); Inspect mode V1 (§11); single ~2-day implementation slice K-CTXR (§12); forward-compat notes (§13). Two new BSP-003 §5 intent kinds: `record_context_manifest`, `record_run_frame`.
- **2026-04-28 (atom-refactor Phase 4)**: §3 algorithm pinned to [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md); §4 ContextManifest schema and §7 RunFrame schema collapsed to atom links per `docs/notebook/PLAN-atom-refactor.md`. JSON shapes preserved inline for the kernel implementer's convenience. Behavioral content (algorithm, persistence rules, module placement, failure modes, Inspect-mode minimum, slice plan) untouched. Definitions now live in `docs/atoms/`. No behavioral or wire-format changes.
