# Operation: apply-overlay-commit

**Status**: V1 spec'd (BSP-007 K-OVERLAY slice)
**Source specs**: [BSP-007 §4.1](../../notebook/BSP-007-overlay-git-semantics.md#41-apply_commitoperations--new_commit_id) (primitive), [BSP-007 §2.1](../../notebook/BSP-007-overlay-git-semantics.md#21-overlaycommit) (commit data model), [BSP-007 §8](../../notebook/BSP-007-overlay-git-semantics.md#8-wire-integration) (wire integration), [BSP-003 §5](../../notebook/BSP-003-writer-registry.md) (intent registry — `apply_overlay_commit`)
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [revert-overlay-commit](revert-overlay-commit.md), [create-overlay-ref](create-overlay-ref.md), [discipline/save-is-git-style](../discipline/save-is-git-style.md)

## Definition

`apply_commit(operations[]) → new_commit_id` is the atomic primitive that records one [overlay commit](../concepts/overlay-commit.md) over the [cell](../concepts/cell.md) / [section](../concepts/section.md) arrangement and advances the overlay `HEAD` ref to it. All operator structural and editorial mutations — split, merge, move, section ops, promote, checkpoint, flag toggles, per-turn overlays — submit through `apply_commit`. **Atomic** means: every operation in `operations[]` validates and applies, or none does. No partial application.

## Operation signature

Per BSP-007 §4.1, the primitive's interface:

```jsonc
apply_commit({
  message: "human-readable summary",
  operations: [ /* ordered; applied in array order */ ]
}) → new_commit_id
```

Wire envelope (per BSP-007 §8 + BSP-003):

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "zone_mutate",
    intent_kind: "apply_overlay_commit",
    parameters: {
      message: "split In[12] before span 4",
      operations: [
        { kind: "split_cell", cell_id: "c_12", at: { kind: "span_boundary", before_span_index: 4 } }
      ]
    },
    intent_id: "01HZX7K3...",
    expected_snapshot_version: 42
  }
}
```

The individual operation kinds (the 17 in BSP-007 §3) do **not** submit independently — they are sub-kinds dispatched by the overlay applier inside `apply_commit`'s `operations[]`. This preserves the atomicity contract.

## Invariants / Preconditions

The writer (per BSP-007 §4.1):

1. **Validates each operation in order** against the current materialized state (`HEAD`-folded view).
2. **If any operation's preconditions fail** (per BSP-007 §6, §7), the entire commit is rejected (**K90** / **K93** / **K94**). No partial application — the writer rolls back to pre-commit state.
3. **On success**, mints `new_commit_id` (ULID, monotonic), sets `parent_id = HEAD`, appends to `commits[]`, advances `HEAD` to the new commit.
4. **Emits one `intent_applied` event** (BSP-003 §6) carrying the `commit_id` and resulting `snapshot_version`.

Additional invariants:

- A commit MAY contain a single op (the common case) or many (bulk reorganize). The `operations[]` array is the unit of atomicity.
- `commits[]` is **append-only** — entries are never edited or removed (BSP-007 §2.2).
- `expected_snapshot_version` provides CAS protection against concurrent commits; mismatch raises a BSP-003 stale-version error.
- Refs starting with `_` are reserved for kernel use; named refs in `commits[].refs[]` follow the rules in [create-overlay-ref](create-overlay-ref.md).

## V1 vs V2+

- **V1**: linear append-only history; HEAD is the only ref that auto-advances.
- **V2+**: branchable history (named refs become mutable branches); cherry-pick (apply one branch's commit on another); concurrent multi-operator commits with conflict resolution (V3+ per BSP-003 §9).

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the commit data model.
- [revert-overlay-commit](revert-overlay-commit.md) — the reverse primitive.
- [create-overlay-ref](create-overlay-ref.md) — the named-ref creation primitive.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — the design discipline this primitive embodies.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — every structural mutation flows through `apply_commit`.
