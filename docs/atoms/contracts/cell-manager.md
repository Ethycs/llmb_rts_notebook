# Contract: CellManager

**Status**: `contract` (V1 spec'd — discipline ratified; module NOT yet present in `vendor/LLMKernel/llm_kernel/`)
**Module**: target `vendor/LLMKernel/llm_kernel/cell_manager.py` (per BSP-005 / BSP-007 implementation slices)
**Source specs**: [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md), [BSP-007 §6](../../notebook/BSP-007-overlay-git-semantics.md#6-merge-correctness-rules-cell-merge), [BSP-002 §13.2.3](../../notebook/BSP-002-conversation-graph.md#1323-cell-kind-merge-invariants-kb-target-221-forward-reference) (merge invariants), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md) (split/merge invariants)
**Related atoms**: [contracts/overlay-applier](overlay-applier.md), [operations/split-cell](../operations/split-cell.md), [operations/merge-cells](../operations/merge-cells.md), [operations/move-cell](../operations/move-cell.md), [operations/promote-span](../operations/promote-span.md)

## Definition

The `CellManager` is the **single component that owns cell structure** (split, merge, move, promote, edit-with-overlay-commit). Per [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md), every operator-side cell-structural mutation flows through this module — the extension MUST NOT manipulate `metadata.rts.cells[].section_id` or `cell_range[]` directly. Each call produces an [overlay commit](../concepts/overlay-commit.md) routed through the [overlay applier](overlay-applier.md), which routes through `MetadataWriter.submit_intent`.

## Public method signatures

```python
class CellManager:
    def __init__(self, applier: "OverlayApplier") -> None: ...

    # BSP-007 §3 / KB-target §22.1 — produces an `apply_overlay_commit` intent
    # whose `operations[]` carries one `split_cell`.
    def split(
        self,
        cell_id: str,
        at: dict,                                    # {kind: "span_boundary", before_span_index: int}
                                                     #  OR {kind: "char_offset", offset: int}
    ) -> str: ...                                    # returns new_commit_id

    # Merge two cells (same section, same kind, see precondition list below).
    def merge(self, cell_a: str, cell_b: str) -> str: ...

    # Cross-section move (M1 allowed; M2 forbids cross-checkpoint per
    # decisions/v1-no-nesting; D5).
    def move(
        self,
        cell_id: str,
        target_section_id: str,
        position_index: int,
    ) -> str: ...

    # Promote a span out of its parent turn into a new cell.
    def promote(self, cell_id: str, span_index: int) -> str: ...

    # Edit-with-overlay-commit: cell text edits route here so the change is
    # tracked in the overlay graph (V1.5+ for non-trivial edits; V1 records
    # only set_cell_metadata via the writer).
    def edit_with_overlay_commit(
        self,
        cell_id: str,
        new_body: str,
        overlay_kind: str = "replacement",
    ) -> str: ...
```

## Invariants

- **Single ownership of structure.** No other module mutates `metadata.rts.cells[].section_id`, `cell_range[]`, or sub-turn numbering directly. Per [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md).
- **Every method produces an overlay commit.** No silent in-place mutations. The commit goes through `OverlayApplier.apply_commit(...)` for atomicity.
- **Split preconditions (BSP-007 §6.2).** Span-aware boundary; both halves remain valid single-role cells; no orphaned tool calls; no executing run. Otherwise K94.
- **Split-single-turn cell forbidden** (S2). Need ≥2 turns or ≥2 worth-splitting spans.
- **Merge preconditions (BSP-007 §6.1, §13.2.3).** Same `kind`; for `kind: "agent"`, same `bound_agent_id`; same section; no pin/exclude/checkpoint boundary between them; no executing run; turn ordering preserved. Otherwise K93.
- **No re-merge of an already-merged cell** (D6, [decisions/v1-no-nesting](../decisions/v1-no-nesting.md)). K94. Operator splits first.
- **Cross-section move allowed (M1); cross-checkpoint move forbidden (M2).** Checkpoints are unmergeable boundaries.
- **Move requires explicit `(target_section_id, position_index)`** (M3). No auto-tail.
- **Sub-turn renumbering on split** resets to flat (no sub-index) per S3.
- **Flag inheritance on split** (S4). Both halves inherit kind / section / pinned / excluded / scratch.
- **RunFrames are not rewritten** by these operations (S5). RunFrames are immutable historical records; they keep pointing at the original `cell_id`.

## K-class error modes (BSP-007 §7)

| Code | Trigger |
|---|---|
| K90 | One operation in the produced commit failed validation; commit rejected wholesale |
| K93 | Merge preconditions violated (kind mismatch, provenance boundary, etc.) |
| K94 | Split preconditions violated (mid-turn, would orphan tool calls, re-merge attempt) |
| K95 | Operation blocked by in-flight execution |

## Callers

- The extension's notebook controller and the operator-facing UI route every "split this cell," "merge these," "move to section X" operator gesture into one of these methods, indirectly via the [submit-intent envelope](../protocols/submit-intent-envelope.md) carrying an `apply_overlay_commit` payload. The kernel-side CellManager is what unwraps the intent.
- Future kernel-internal callers: `AgentSupervisor` may emit a `split` overlay commit when a cell directive parses to a fork (TBD).

## Code drift vs spec

- **Module does not exist.** `vendor/LLMKernel/llm_kernel/cell_manager.py` is absent. The discipline atom ratifies the design but no slice has landed yet — partial wiring will arrive with K-OVERLAY (BSP-007 §11) and BSP-005 S5/S5.5/S6.
- **`edit_with_overlay_commit`** is the future-proofing slot for V1.5+ structured cell edits. V1 ships only `set_cell_metadata` (via writer's intent registry) for cell-metadata changes; full text-edit-as-overlay is V1.5+.

## See also

- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — the rule this contract enforces.
- [contracts/overlay-applier](overlay-applier.md) — every method routes through here.
- [operations/split-cell](../operations/split-cell.md), [operations/merge-cells](../operations/merge-cells.md), [operations/move-cell](../operations/move-cell.md), [operations/promote-span](../operations/promote-span.md) — operator-facing op atoms this contract serves.
- [decisions/v1-no-nesting](../decisions/v1-no-nesting.md) — re-merge forbidden; sections flat.
