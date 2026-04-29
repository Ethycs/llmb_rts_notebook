# Context manifest

**Status**: V1 shipped (deterministic structural walk; ranking/budget/summary-trust deferred to V2; K-AS-A walker landing, submodule commit `87cb127`)
**Source specs**: [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md#3-contextpacker-v1-algorithm), [BSP-008 §4](../../notebook/BSP-008-contextpacker-runframes.md#4-contextmanifest-schema), [PLAN-S3.5-context-packer.md](../../notebook/PLAN-S3.5-context-packer.md), [KB-notebook-target.md §0.6](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract), [KB-notebook-target.md §22.2](../../notebook/KB-notebook-target.md#222-contextpacker-algorithm)
**Related atoms**: [run-frame](run-frame.md), [cell](cell.md), [section](section.md), [turn](turn.md), [contracts/context-packer](../contracts/context-packer.md)

## Definition

A **context manifest** is the deterministic, persisted output of ContextPacker for one cell run. It is an ordered, deduplicated list of *cell refs* that the agent will see as input, plus an inclusion/exclusion trace recording WHY each cell was included or excluded so [Inspect mode](../../notebook/KB-notebook-target.md#18-progressive-disclosure-modes) can render "what the agent saw and why." The manifest is the single answer to *"what context did the agent have when this cell ran?"* — referenced by every [run-frame](run-frame.md) via `context_manifest_id`.

ContextPacker is a pure function: same notebook overlay + same current cell ⇒ byte-identical manifest, modulo the freshly-generated `manifest_id` and `generated_at` stamps.

## Schema

```jsonc
// metadata.rts.zone.context_manifests.<manifest_id>
{
  "manifest_id":  "uuid",                           // fresh per pack() call
  "cell_id":      "string",                         // the cell being run
  "cell_refs":    ["<cell_id>", ...],               // ordered, deduplicated; the agent's input
  "inclusion_rules_applied": [                      // operator-facing telemetry
    { "rule": "pinned",                 "cells": [<cell_id>, ...] },
    { "rule": "section_predecessor",    "cells": [<cell_id>, ...] },
    { "rule": "current_cell_sub_turns", "cells": [<cell_id>, ...] }
  ],
  "exclusions_applied": [
    { "reason": "scratch",   "cells": [<cell_id>, ...] },
    { "reason": "excluded",  "cells": [<cell_id>, ...] },
    { "reason": "obsolete",  "cells": [<cell_id>, ...] }
  ],
  "generated_at": "iso8601"                         // fresh per pack() call
}
```

**Field-name reconciliation**: an earlier draft of this atom referenced `turn_ids` / `created_at` / `total_turn_count` / `total_token_estimate` (`section_id` slot, V1-null token-estimate field). The shipped K-AS-A walker uses **`cell_refs`** (the ordered, deduplicated cell IDs the agent will see) and **`generated_at`** (the ISO-8601 stamp). PLAN-S3.5 brief used these names; the atom is now aligned with the shipped code. The earlier alternates are recorded here so future readers know about the prior naming.

## Invariants

- **Append-only.** Manifests are never deleted; Inspect mode needs historical access ("what manifest did this run see three sessions ago?").
- **Deterministic.** Re-running ContextPacker on the same input produces the same manifest, byte-for-byte. This is the precondition for replay correctness and for Inspect mode's "explain why" view.
- **Pure-function output.** ContextPacker reads the overlay; it does NOT mutate state, write to disk, or call agents/tools. Persistence is handled by the AgentSupervisor wrapping the call in a `record_context_manifest` intent.
- **Order is significant.** `cell_refs[]` is the order the agent sees. Pinned cells appear at the head (first-occurrence dedupe ordering — see [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md#3-contextpacker-v1-algorithm) step 5).
- **Trace is operator-facing only.** `inclusion_rules_applied` and `exclusions_applied` are NOT consulted by the agent — they exist solely so Inspect mode can render the V1 walk.
- **Validation rejects unknown cell refs.** A `record_context_manifest` whose `cell_refs[]` reference unknown cells is rejected at write time (K103).
- **Referenced by RunFrame.** Every [run-frame](run-frame.md) carries a `context_manifest_id` pointing here; the pair is what makes a run inspectable end-to-end.
- **Token-estimate is V2.** A budget-overflow strategy (and the corresponding `total_token_estimate` field) lands in V2; V1 omits the slot entirely.

## V1 vs V2+

- **V1**: structural walk only. Pinned cells (anywhere) → previous cells in current [section](section.md) → current cell's prior [sub-turns](sub-turn.md). Excludes `scratch | excluded | obsolete`. No ranking, no budget overflow, no summary trust, no retrieval, no diffing.
- **V2+**: ranking policies (semantic weight, recency decay), budget overflow (drop-oldest, summarize-and-include), summary trust (operator-approved checkpoints), retrieval (semantic search over excluded turns when budget allows), manifest diffing.

## See also

- [run-frame](run-frame.md) — pairs with the manifest to record one cell run.
- [cell-kinds](cell-kinds.md) — `scratch` and `checkpoint` kinds drive exclusion / substitution.
- [section](section.md) — defines the predecessor walk.
- [discipline/scratch-beats-config](../discipline/scratch-beats-config.md) — why the V1 walk consults visible flags only.
- [decisions/v1-contextpacker-walk](../decisions/v1-contextpacker-walk.md) — the V1 simplification.
