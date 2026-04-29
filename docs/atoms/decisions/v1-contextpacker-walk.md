# Decision: V1 ContextPacker is a dumb structural walker

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [KB-notebook-target.md §0.6](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract), [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/context-manifest](../concepts/context-manifest.md), [decisions/v1-runframe-minimal](v1-runframe-minimal.md), [discipline/scratch-beats-config](../discipline/scratch-beats-config.md), [concepts/section](../concepts/section.md)

## The decision

**V1 ContextPacker is a pure, deterministic, structure-only walker.** No ranking, no budget overflow strategy, no summary trust, no retrieval. Per [KB-target §0.6](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract) and [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md), the V1 algorithm is:

```
input:  current cell c, current section s, notebook overlay
output: ordered, deduplicated list of turn_ids

1. Pinned cells anywhere in the notebook
2. Previous cells in current section in chronological order
   (or document order if cell has no section)
3. Current cell's prior sub-turns (only when merges produced sub-turns)
4. exclude cells flagged scratch | excluded | obsolete
5. dedupe, preserving first-occurrence order
```

That's the entire policy. No tokens, no rankings, no policies.

## Rationale

1. **The operator controls context by reorganizing the notebook**, not by tuning policies. Per [KB-target §7](../../notebook/KB-notebook-target.md) and [discipline/scratch-beats-config](../discipline/scratch-beats-config.md): visible structure beats hidden config. The walker is the simplest realization — every inclusion/exclusion can be explained by pointing at a flag the operator set.

2. **Determinism is required for two downstream guarantees** ([BSP-008 §2](../../notebook/BSP-008-contextpacker-runframes.md)): Inspect mode replay (re-running on the same input must produce the same manifest byte-for-byte) and RunFrame replay (V2's `source_snapshot_id` + `overlay_commit_id` must reproduce the same context). Ranking and retrieval are inherently non-deterministic with model drift; deferring them keeps V1 replay tight.

3. **Inspectability without policy.** The manifest carries `inclusion_rules_applied` and `exclusions_applied` so the operator can see "this turn was included because cell c_3 is pinned." With no policy mesh, the explanation is a flat list of rules, one per included or excluded cell. Inspect mode renders this directly.

4. **V2 adds policy additively.** Per [BSP-008 §13](../../notebook/BSP-008-contextpacker-runframes.md), V2 gains ranking metadata, budget-overflow trace, `total_token_estimate`. The V1 manifest schema reserves the slot for `total_token_estimate` (nullable in V1) so V2 fills it without reshaping.

## Operational consequences

| V1 ContextPacker behavior | Where enforced |
|---|---|
| Pure function: no I/O, no agent calls, no tool calls | [BSP-008 §2](../../notebook/BSP-008-contextpacker-runframes.md) |
| Deterministic: same input → same `ContextManifest` byte-for-byte | [BSP-008 §2](../../notebook/BSP-008-contextpacker-runframes.md) |
| Reads flags `pinned`, `excluded`, `scratch`, `obsolete` from cell metadata | [KB-target §13.5](../../notebook/KB-notebook-target.md) |
| Walks `section.cells` in display order when current cell has a section_id; falls back to document order otherwise | [BSP-008 §3 step 3 fallback](../../notebook/BSP-008-contextpacker-runframes.md) |
| Includes current cell's prior sub-turns only when merges produced them ([sub-turn](../concepts/sub-turn.md)) | [KB-target §0.2](../../notebook/KB-notebook-target.md) |
| Dedupes preserving first-occurrence order (pinned cells appear at head if they would also have been included by section walk) | [BSP-008 §3 step 5](../../notebook/BSP-008-contextpacker-runframes.md) |
| `total_token_estimate` left `null` | [BSP-008 §4](../../notebook/BSP-008-contextpacker-runframes.md) |
| No ranking. No budget overflow. No summary trust. No retrieval. | [KB-target §0.6](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract) |

When the inputs are equal the output is equal — which is what makes the V1 [run-frame](../concepts/run-frame.md) replay story work at all.

## V1 vs V2+

| | V1 | V2+ |
|---|---|---|
| Algorithm | Structural walk + flag-based exclusion | Structural walk + ranking + retrieval |
| Manifest fields | `turn_ids`, `inclusion_rules_applied`, `exclusions_applied`, `total_turn_count`, `total_token_estimate: null` | Adds `included_by_rank`, `dropped_for_budget`, `total_token_estimate: <number>`, manifest diffing trace |
| Budget handling | None — emit everything that passes filters | Drop-oldest, summarize-and-include, or operator-policy-driven |
| Summary trust | None — checkpoint cells included by their flag, treated equal to other cells | Operator-approved-only mode for checkpoint summaries |
| Retrieval | None | Semantic search over excluded turns when budget allows |

## See also

- [concepts/context-manifest](../concepts/context-manifest.md) — the manifest data shape.
- [decisions/v1-runframe-minimal](v1-runframe-minimal.md) — RunFrame consumes `context_manifest_id`.
- [discipline/scratch-beats-config](../discipline/scratch-beats-config.md) — why visible flags beat policy languages.
- [concepts/section](../concepts/section.md) — the walk scopes by section when present.
- [concepts/sub-turn](../concepts/sub-turn.md) — sub-turns are emitted only after merges.
- [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md) — the algorithm source.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
