# Contract: OverlayApplier

**Status**: `contract` (V1 spec'd — BSP-007 K-OVERLAY slice; NOT yet present in `vendor/LLMKernel/llm_kernel/`)
**Module**: target `vendor/LLMKernel/llm_kernel/overlay_applier.py` (per BSP-007 §11 implementation slice)
**Source specs**: [BSP-007 §4](../../notebook/BSP-007-overlay-git-semantics.md#4-operations-primitives) (primitives), [BSP-007 §6](../../notebook/BSP-007-overlay-git-semantics.md#6-merge-correctness-rules-cell-merge) (validators), [BSP-007 §7](../../notebook/BSP-007-overlay-git-semantics.md#7-failure-modes-k-class--overlay-commit-namespace-k90) (K-class), [BSP-007 §11](../../notebook/BSP-007-overlay-git-semantics.md#11-implementation-slice)
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [operations/apply-overlay-commit](../operations/apply-overlay-commit.md), [contracts/cell-manager](cell-manager.md), [contracts/metadata-writer](metadata-writer.md)

## Definition

The `OverlayApplier` is the kernel module that applies the four BSP-007 §4 primitives over `metadata.rts.zone.overlay.{commits,refs}`. It owns commit minting, atomic per-commit application of `operations[]`, HEAD advancement, revert (HEAD rewind), diff (operations between two commits), and named-ref creation. It plugs into `MetadataWriter`'s [intent dispatcher](intent-dispatcher.md) as the handler for `apply_overlay_commit`, `revert_overlay_to_commit`, and `create_overlay_ref` intents. The 17 operation kinds (split, merge, move, section ops, promote, checkpoint, flag toggles, within-turn overlays) are sub-kinds dispatched **inside** `apply_commit`'s `operations[]`; they do not submit independently.

## Public method signatures

```python
class OverlayApplier:
    def __init__(self, writer: "MetadataWriter") -> None: ...

    # BSP-007 §4.1 — atomic apply of one commit.
    def apply_commit(
        self,
        operations: list[dict],
        message: str,
        author: str = "operator",
    ) -> str: ...                              # returns new_commit_id (ULID)

    # BSP-007 §4.2 — rewind HEAD without rewriting history.
    def revert_to_commit(self, commit_id: str) -> None: ...

    # BSP-007 §4.3 — read-only ordered op sequence between two commits.
    def diff(self, commit_a: str, commit_b: str) -> list[dict]: ...

    # BSP-007 §4.4 — named-ref creation (V1: tags, immutable).
    def branch(self, commit_id: str, name: str) -> None: ...
```

## Invariants

- **Atomic per-commit.** Each `operations[]` entry is validated against the HEAD-folded view (BSP-007 §4.1 step 1). Any precondition failure rejects the whole commit (K90 / K93 / K94). No partial application — the writer rolls back to pre-commit state.
- **`commits[]` is append-only.** Entries are never edited or removed. Revert moves HEAD; it does NOT remove commits (`git reflog` semantics).
- **Linear history in V1.** `parent_id` is single-valued. V2+ generalizes to `parent_ids[]` for branch merges.
- **`commit_id` is a ULID** so chronological sort is meaningful. Mintage happens on apply.
- **Reachability for revert/diff.** `revert_to_commit(c)` and `diff(a, b)` require both commit_ids to be in `commits[]`; otherwise K91.
- **V1 named refs are tags** (immutable). Re-creating a named ref at a different commit raises K92.
- **Reserved ref names.** `HEAD` is reserved; refs starting with `_` are reserved for kernel use.
- **Cell-merge precondition rules (BSP-007 §6.1) are enforced structurally.** Same kind, same `bound_agent_id` for agent cells, no pin/exclude/checkpoint boundary, no executing run, valid turn ordering. Forbidden cross-provenance combinations (§6.3) raise K93 with a per-reason marker.
- **Split precondition (BSP-007 §6.2).** Split point is a turn boundary; both halves remain valid single-role cells; no orphaned tool calls; no executing run. Otherwise K94.
- **K95 execution guard.** Operations on a cell with an in-flight run are blocked until completion or explicit stop.

## K-class error modes (BSP-007 §7)

| Code | Trigger |
|---|---|
| K90 | One or more operations failed validation; commit rejected wholesale |
| K91 | Revert / diff target unreachable |
| K92 | Named-ref name conflict (V1 tag exists at a different commit) |
| K93 | Merge precondition violated (kind mismatch, provenance boundary, etc.) |
| K94 | Split precondition violated |
| K95 | Operation blocked by in-flight execution |

## Callers

- [contracts/intent-dispatcher](intent-dispatcher.md) — registers handlers for `apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`.
- [contracts/cell-manager](cell-manager.md) — operator-facing cell ops (split, merge, move, edit) are wrappers that produce overlay commits and call `apply_commit(...)` through the dispatcher.
- Extension: History-mode panel calls `diff(a, b)` (read-only) for rendering; the read path may go through Family C or a future read-only Comm message — TBD in BSP-007 §11 X-EXT slice.

## Code drift vs spec

The module **does not exist in `vendor/LLMKernel/llm_kernel/` today.** BSP-007 K-OVERLAY is a single ~3-day slice (BSP-007 §11) not yet implemented; the intent kinds are also missing from `_BSP003_INTENT_KINDS` (see [intent-dispatcher](intent-dispatcher.md) drift note). When implemented, the slice MUST also:

1. Add the three intent kinds to `_BSP003_INTENT_KINDS`.
2. Implement `_intent_handler_for("apply_overlay_commit")` etc. as bridges into this applier.
3. Round-trip the `metadata.rts.zone.overlay.*` substructure through hydrate / snapshot.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the data model this contract operates on.
- [operations/apply-overlay-commit](../operations/apply-overlay-commit.md) — the operator-facing operation atom.
- [contracts/cell-manager](cell-manager.md) — calls into this applier for split / merge / move.
- [contracts/metadata-writer](metadata-writer.md) — owns the writer this applier plugs into.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — the design discipline this contract embodies.
