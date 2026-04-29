# Contract: ContextPacker

**Status**: `contract` (V1 spec'd — BSP-008 K-CTXR slice; NOT yet present in `vendor/LLMKernel/llm_kernel/`)
**Module**: target `vendor/LLMKernel/llm_kernel/context_packer.py` (per BSP-008 §9)
**Source specs**: [BSP-008 §2](../../notebook/BSP-008-contextpacker-runframes.md#2-contextpacker--purpose) (purpose), [BSP-008 §3](../../notebook/BSP-008-contextpacker-runframes.md#3-contextpacker-v1-algorithm) (algorithm), [BSP-008 §4](../../notebook/BSP-008-contextpacker-runframes.md#4-contextmanifest-schema) (output schema), [decisions/v1-contextpacker-walk](../decisions/v1-contextpacker-walk.md)
**Related atoms**: [context-manifest](../concepts/context-manifest.md), [run-frame](../concepts/run-frame.md), [contracts/agent-supervisor](agent-supervisor.md), [contracts/metadata-writer](metadata-writer.md)

## Definition

The `ContextPacker` is a **pure function** that produces a [context manifest](../concepts/context-manifest.md) for one cell run from the notebook's overlay state. Per BSP-008 §2: `pack(notebook_state, current_cell, current_section) → ContextManifest`. Pure means deterministic, no side effects, inspectable (returns its inclusion-rule trace in the manifest itself). The packer is stateless across calls; it does not write to disk. The `AgentSupervisor` wraps each call in a `record_context_manifest` intent so the manifest is persisted.

## Public method signatures

```python
def pack(
    notebook_state: NotebookState,
    current_cell: Cell,
    current_section: Optional[Section],
) -> ContextManifest:
    """V1 deterministic structural walk per BSP-008 §3."""
```

`ContextManifest` is a dataclass / TypedDict matching the [context-manifest atom schema](../concepts/context-manifest.md):

```python
ContextManifest = TypedDict("ContextManifest", {
    "manifest_id":             str,                  # ULID
    "cell_id":                 str,
    "section_id":              Optional[str],
    "turn_ids":                list[str],            # ordered, deduplicated
    "inclusion_rules_applied": list[dict],           # operator-facing trace
    "exclusions_applied":      list[dict],           # operator-facing trace
    "total_turn_count":        int,
    "total_token_estimate":    Optional[int],        # V1: None
    "created_at":              str,                  # ISO 8601
})
```

## Invariants

- **Pure function.** No side effects, no I/O, no dispatcher calls. Reading the overlay only.
- **Deterministic.** Same `(notebook_state, current_cell, current_section)` → byte-identical manifest. This is the precondition for replay correctness and for [Inspect mode](../../notebook/KB-notebook-target.md#18-progressive-disclosure-modes) "explain why."
- **V1 walk algorithm (BSP-008 §3).** (1) pinned cells anywhere; (2) previous cells in current section (chronological by overlay position); (3) current cell's prior sub-turns; (4) deduplicate preserving first-occurrence order. Excludes cells flagged `scratch | excluded | obsolete`.
- **Section-fallback walk.** When `current_section is None`, the section-predecessor step degrades to "previous cells in document order."
- **`total_token_estimate` is `None` in V1.** V2 fills it once the budget-overflow strategy lands.
- **Returns a trace, not just turn ids.** `inclusion_rules_applied[]` and `exclusions_applied[]` are operator-facing telemetry consumed by Inspect mode; agents see only `turn_ids`.
- **Validation is delegated.** The packer does not validate `turn_ids` against persisted state — that happens at write time in `MetadataWriter` per [BSP-003 §6 step 4](../../notebook/BSP-003-writer-registry.md#6-apply-discipline) (K103 on unknown turn refs).

## K-class error modes (BSP-008 §10, K100+)

| Code | Trigger | Detected at |
|---|---|---|
| K100 | `current_cell` not present in the overlay (orphan) | inside `pack(...)` |
| K101 | Section-walk exceeds reasonable depth (cycle in `parent_section_id` chain) | inside `pack(...)`; pack returns the partial walk up to the cycle |
| K103 | `record_context_manifest` references unknown `turn_ids` | at intent-dispatch validation, not in `pack(...)` |

K100 / K101 surface from `pack(...)`; the AgentSupervisor catches them before submitting the manifest intent.

## Callers

- [contracts/agent-supervisor](agent-supervisor.md) — calls `pack(...)` before each operator turn (per BSP-008 §9), then submits two intents: `record_context_manifest` (with the manifest) and `record_run_frame` (with start state). Replaces the V0 BSP-002 §4.6 cross-agent context handoff.
- AgentSupervisor wraps the wire integration:

```python
manifest = ContextPacker.pack(notebook_state, current_cell, current_section)
metadata_writer.submit_intent({
    "type": "operator.action",
    "payload": {
        "action_type": "zone_mutate",
        "intent_kind": "record_context_manifest",
        "parameters": {"manifest": manifest},
        "intent_id":   ulid(),
    },
})
```

## Code drift vs spec

The module **does not exist in `vendor/LLMKernel/llm_kernel/` today.** BSP-008 K-CTXR is a ~2-day slice (BSP-008 §12) not yet implemented. The V0 stand-in is the BSP-002 §4.6 cross-agent context handoff baked into `AgentSupervisor`'s flow; that path will be replaced by `pack(...)` when the slice lands. The corresponding intent kinds (`record_context_manifest`, `record_run_frame`) are also missing from `_BSP003_INTENT_KINDS` — see [intent-dispatcher](intent-dispatcher.md) drift note.

## See also

- [context-manifest](../concepts/context-manifest.md) — the data shape this contract produces.
- [run-frame](../concepts/run-frame.md) — pairs with the manifest to record one run.
- [contracts/agent-supervisor](agent-supervisor.md) — the caller that wraps `pack(...)` in intents.
- [decisions/v1-contextpacker-walk](../decisions/v1-contextpacker-walk.md) — V1 simplification rationale.
- [discipline/scratch-beats-config](../discipline/scratch-beats-config.md) — why the V1 walk consults visible flags only.
