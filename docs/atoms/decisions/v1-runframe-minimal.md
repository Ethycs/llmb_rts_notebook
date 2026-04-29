# Decision: V1 RunFrame ships the minimal subset

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [KB-notebook-target.md §0.5](../../notebook/KB-notebook-target.md#05-runframes--minimal-v1-schema), [BSP-008 §7](../../notebook/BSP-008-contextpacker-runframes.md), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/run-frame](../concepts/run-frame.md), [concepts/context-manifest](../concepts/context-manifest.md), [decisions/v1-contextpacker-walk](v1-contextpacker-walk.md)

## The decision

**V1 RunFrame schema is the minimal subset needed for Inspect mode and replay correctness.** [KB-target §9](../../notebook/KB-notebook-target.md) lists a fuller schema; [BSP-008 §7](../../notebook/BSP-008-contextpacker-runframes.md) ships only:

```jsonc
RunFrame: {
  run_id: ulid,
  cell_id: string,
  executor_id: string,                  // agent_id
  turn_head_before: turn_id | null,
  turn_head_after: turn_id | null,
  context_manifest_id: ulid,            // points at the ContextPacker output
  status: "complete" | "failed" | "interrupted",
  started_at: iso8601,
  ended_at: iso8601 | null
}
```

**V1 explicitly does NOT ship**: `parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions`. Those land in V2 additively.

(This is the V1 narrow of KB-target §0.5; the broader KB-target §9 RunFrame is the V2+ target.)

## Rationale

1. **V1 needs only two questions answered per cell run** ([BSP-008 §6](../../notebook/BSP-008-contextpacker-runframes.md)): (a) "what context did the agent see?" (answered by `context_manifest_id`); (b) "what changed in the turn DAG?" (answered by `turn_head_before` / `turn_head_after`). The minimal schema answers both.

2. **The deferred fields require sibling V2 work.** `source_snapshot_id` requires content-addressed cell snapshots (V2 feature). `overlay_commit_id` requires the [BSP-007](../../notebook/BSP-007-overlay-git-semantics.md) commit graph to be wired into the AgentSupervisor's pre-run path (V1 ratifies the overlay-commit data model but the supervisor doesn't reference it from RunFrames yet). `artifact_windows[]` requires V2's streaming artifact materializer ([v1-artifact-shape](v1-artifact-shape.md) defers this). `tool_permissions` requires the [capabilities-deferred-v2](capabilities-deferred-v2.md) table.

3. **Additive forward path.** Per [BSP-008 §13](../../notebook/BSP-008-contextpacker-runframes.md), V2 readers learn the new fields; V1 readers ignore unknown fields. No schema migration; no shape change. The V1 RunFrame round-trips intact through V2 producers.

4. **Avoid premature abstraction.** Per [Engineering Guide §11.3](../../../Engineering_Guide.md#113-premature-abstraction): the V2 fields each require their own subsystem to be useful. Shipping the slot before the subsystem creates a `null`-everywhere field that nobody reads, which is dead weight per [Engineering Guide §11.2](../../../Engineering_Guide.md#112-backward-compat-shims-for-non-existent-legacy).

## Operational consequences

| Field | V1 producer behavior | V1 consumer behavior |
|---|---|---|
| `run_id` | ULID at run start (BSP-008 §9) | Required; primary key for Inspect mode |
| `cell_id` | Pinned at run start; survives [split-cell](../operations/split-cell.md) per Decision S5 | Required |
| `executor_id` | The agent's id at run dispatch | Required |
| `turn_head_before` | Agent's `head_turn_id` before the run | May be `null` for first turn |
| `turn_head_after` | Agent's `head_turn_id` after run terminal status | `null` if run failed before any turn committed |
| `context_manifest_id` | Points at the [ContextPacker](v1-contextpacker-walk.md) output for this run | Inspect mode resolves this to render "what the agent saw" |
| `status` | `complete \| failed \| interrupted` only | Reject other values per BSP-008 schema |
| `started_at`, `ended_at` | `started_at` at run start; `ended_at` updated on terminal status | `ended_at` may be `null` while running |
| (V2 fields) | NOT EMITTED in V1 | MUST tolerate absence |

## V1 vs V2+

- **V1**: minimal subset above. RunFrames are written through [BSP-003](../../notebook/BSP-005-cell-roadmap.md)'s `record_run_frame` intent kind. Idempotency on `run_id` allows the terminal-status update.
- **V2+**: gains `parent_run_id` (cross-agent handoff lineage), `source_snapshot_id` (cell-source pin), `overlay_commit_id` (pins overlay state for replay), `artifact_windows[]` (which artifact ranges were materialized), full `tool_permissions` (per [capabilities-deferred-v2](capabilities-deferred-v2.md)).

The shape doesn't change. Only fields are added.

## See also

- [concepts/run-frame](../concepts/run-frame.md) — the concept this constrains.
- [concepts/context-manifest](../concepts/context-manifest.md) — what `context_manifest_id` references.
- [decisions/v1-contextpacker-walk](v1-contextpacker-walk.md) — the V1 ContextPacker that produces the manifest.
- [decisions/capabilities-deferred-v2](capabilities-deferred-v2.md) — why `tool_permissions` is missing.
- [decisions/v1-artifact-shape](v1-artifact-shape.md) — why `artifact_windows[]` is missing.
- [BSP-008 §7](../../notebook/BSP-008-contextpacker-runframes.md) — the schema source.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
