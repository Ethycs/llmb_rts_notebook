# RunFrame

**Status**: V1 shipped (minimal schema only — `parent_run_id`, `source_snapshot_id`, `overlay_commit_id`, `artifact_windows[]`, full `tool_permissions` deferred to V2)
**Source specs**: [BSP-008 §6](../../notebook/BSP-008-contextpacker-runframes.md#6-runframe--purpose), [BSP-008 §7](../../notebook/BSP-008-contextpacker-runframes.md#7-runframe-v1-minimal-schema), [KB-notebook-target.md §0.5](../../notebook/KB-notebook-target.md#05-runframes--minimal-v1-schema), [KB-notebook-target.md §9](../../notebook/KB-notebook-target.md#9-self-reference-without-paradox)
**Related atoms**: [context-manifest](context-manifest.md), [cell](cell.md), [agent](agent.md), [turn](turn.md)

## Definition

A **RunFrame** is the immutable historical record of one cell run. It records which [cell](cell.md) ran, which [agent](agent.md) ran it, the agent's [turn](turn.md) head before and after, which [context-manifest](context-manifest.md) the agent saw, and the run's terminal status. RunFrames are the kernel's stack-frame analog ([KB-target §24](../../notebook/KB-notebook-target.md#24-the-strongest-framing) — "RunFrames = stack frames"); together with the manifest they answer the two Inspect-mode questions per cell: *"what context did the agent see?"* and *"what changed in the turn DAG as a result?"*

RunFrames are append-only; they survive notebook close → reopen via the `metadata.rts` hydrate path. They are NOT rewritten by [overlay commits](overlay-commit.md) — when a cell is split or merged, RunFrames keep pointing at the original `cell_id` (decision S5), and Inspect mode shows "this run was on cell c_5 (since split into c_5a + c_5b)."

## Schema (V1 minimal)

```jsonc
// metadata.rts.zone.run_frames.<run_id>
{
  "run_id":               "ulid",
  "cell_id":              "string",                  // immutable target cell
  "executor_id":          "string",                  // agent_id
  "turn_head_before":     "turn_id | null",          // null if first turn for this agent
  "turn_head_after":      "turn_id | null",          // null if run failed before any turn committed
  "context_manifest_id":  "ulid",                    // points at ContextManifest
  "status":               "complete | failed | interrupted",
  "started_at":           "iso8601",
  "ended_at":             "iso8601 | null"           // null while running; set on terminal status
}
```

## Invariants

- **Immutable historical record.** Once written, fields do not change with one exception: terminal-status update is allowed via `record_run_frame` idempotent on `run_id` (start frame writes `status: "complete"` placeholder; terminal frame sets the actual status + `ended_at`). V2 may split this into `update_run_frame_status` for cleanliness.
- **Append-only.** RunFrames are never deleted. Re-running a cell creates a NEW RunFrame; the prior one is preserved.
- **Pinned to original `cell_id` across overlay edits** (decision S5). Splits, merges, moves do not rewrite RunFrames. Inspect mode resolves the original `cell_id` against current overlay state and renders any "since split / since merged into ..." hints.
- **Pinned to original flag state** (decision F1). Toggling pin/exclude/scratch/checkpoint after a run does NOT modify the RunFrame. New runs see new flag state; old RunFrames record what was true at the time.
- **Validated by writer.** Duplicate `run_id` from a different cell, or other validator failure → K102.
- **Indexed by `cell_id`** so Inspect mode can list "all runs for this cell." V1 does linear scan; V2 may add a precomputed `cell_id → [run_id]` index.
- **Pairs with manifest.** Every RunFrame's `context_manifest_id` resolves to a [context-manifest](context-manifest.md) in `metadata.rts.zone.context_manifests`. The pair is what makes a run end-to-end inspectable.
- **`turn_head_after`'s diff vs `turn_head_before`** is the agent's contribution to the turn DAG for this run. A failed-early run has `turn_head_after: null` (no turn committed).

## V1 vs V2+

- **V1**: minimal schema above. Single trust boundary (operator → kernel → agents).
- **V2+**: adds `parent_run_id` (chains for cross-agent handoffs), `source_snapshot_id` (pins cell-source contents at run start for replay), `overlay_commit_id` (links the run to a BSP-007 [overlay commit](overlay-commit.md) so replay reconstructs the exact overlay state), `artifact_windows[]` (which [artifact-ref](artifact-ref.md) ranges were materialized), and full `tool_permissions` per [KB-target §20](../../notebook/KB-notebook-target.md#20-security-and-capabilities). All additive — V1 readers ignore unknown fields.

## See also

- [context-manifest](context-manifest.md) — pairs with the RunFrame.
- [agent](agent.md) — executor reference; `executor_id` matches `agent.id`.
- [operations/apply-overlay-commit](../operations/apply-overlay-commit.md) — overlay edits do NOT rewrite RunFrames.
- [decisions/v1-runframe-minimal](../decisions/v1-runframe-minimal.md) — why V1 ships only this subset.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — RunFrames are on the immutable side of the split.
