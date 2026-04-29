# Context manifest

**Status**: V1 shipped (deterministic structural walk; ranking/budget/summary-trust deferred to V2)
**Source specs**: [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md#3-contextpacker-v1-algorithm), [BSP-008 §4](../../notebook/BSP-008-contextpacker-runframes.md#4-contextmanifest-schema), [KB-notebook-target.md §0.6](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract), [KB-notebook-target.md §22.2](../../notebook/KB-notebook-target.md#222-contextpacker-algorithm)
**Related atoms**: [run-frame](run-frame.md), [cell](cell.md), [section](section.md), [turn](turn.md)

## Definition

A **context manifest** is the deterministic, persisted output of ContextPacker for one cell run. It is an ordered, deduplicated list of [turn](turn.md) ids that the agent will see as input, plus an inclusion/exclusion trace recording WHY each cell was included or excluded so [Inspect mode](../../notebook/KB-notebook-target.md#18-progressive-disclosure-modes) can render "what the agent saw and why." The manifest is the single answer to *"what context did the agent have when this cell ran?"* — referenced by every [run-frame](run-frame.md) via `context_manifest_id`.

ContextPacker is a pure function: same notebook overlay + same current cell + same current section ⇒ byte-identical manifest.

## Schema

```jsonc
// metadata.rts.zone.context_manifests.<manifest_id>
{
  "manifest_id":  "ulid",
  "cell_id":      "string",                        // the cell being run
  "section_id":   "string | null",                 // null if no section context
  "turn_ids":     ["t_...", ...],                  // ordered, deduplicated; the agent's input
  "inclusion_rules_applied": [                     // operator-facing telemetry
    { "rule": "pinned",                "cells": [<cell_id>, ...] },
    { "rule": "section_predecessor",   "cells": [<cell_id>, ...] },
    { "rule": "current_cell_sub_turns","cells": [<cell_id>], "turn_ids": [...] }
  ],
  "exclusions_applied": [
    { "reason": "scratch",   "cells": [<cell_id>, ...] },
    { "reason": "excluded",  "cells": [<cell_id>, ...] },
    { "reason": "obsolete",  "cells": [<cell_id>, ...] }
  ],
  "total_turn_count":     "number",                // == turn_ids.length
  "total_token_estimate": "number | null",         // V1: null; V2 fills
  "created_at":           "iso8601"
}
```

## Invariants

- **Append-only.** Manifests are never deleted; Inspect mode needs historical access ("what manifest did this run see three sessions ago?").
- **Deterministic.** Re-running ContextPacker on the same input produces the same manifest, byte-for-byte. This is the precondition for replay correctness and for Inspect mode's "explain why" view.
- **Pure-function output.** ContextPacker reads the overlay; it does NOT mutate state, write to disk, or call agents/tools. Persistence is handled by the AgentSupervisor wrapping the call in a `record_context_manifest` intent.
- **Order is significant.** `turn_ids[]` is the order the agent sees. Pinned cells appear at the head (first-occurrence dedupe ordering — see [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md#3-contextpacker-v1-algorithm) step 5).
- **Trace is operator-facing only.** `inclusion_rules_applied` and `exclusions_applied` are NOT consulted by the agent — they exist solely so Inspect mode can render the V1 walk.
- **Validation rejects unknown turn refs.** A `record_context_manifest` whose `turn_ids[]` reference unknown turns is rejected at write time (K103).
- **Referenced by RunFrame.** Every [run-frame](run-frame.md) carries a `context_manifest_id` pointing here; the pair is what makes a run inspectable end-to-end.
- **`total_token_estimate` is reserved.** V1 may leave it null; V2 fills it once budget-overflow strategy lands. The field's presence is forward-compatible.

## V1 vs V2+

- **V1**: structural walk only. Pinned cells (anywhere) → previous cells in current [section](section.md) → current cell's prior [sub-turns](sub-turn.md). Excludes `scratch | excluded | obsolete`. No ranking, no budget overflow, no summary trust, no retrieval, no diffing.
- **V2+**: ranking policies (semantic weight, recency decay), budget overflow (drop-oldest, summarize-and-include), summary trust (operator-approved checkpoints), retrieval (semantic search over excluded turns when budget allows), manifest diffing.

## See also

- [run-frame](run-frame.md) — pairs with the manifest to record one cell run.
- [cell-kinds](cell-kinds.md) — `scratch` and `checkpoint` kinds drive exclusion / substitution.
- [section](section.md) — defines the predecessor walk.
- [discipline/scratch-beats-config](../discipline/scratch-beats-config.md) — why the V1 walk consults visible flags only.
- [decisions/v1-contextpacker-walk](../decisions/v1-contextpacker-walk.md) — the V1 simplification.
