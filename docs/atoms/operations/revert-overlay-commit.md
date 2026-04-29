# Operation: revert-overlay-commit

**Status**: V1 spec'd (BSP-007 K-OVERLAY slice)
**Source specs**: [BSP-007 §4.2](../../notebook/BSP-007-overlay-git-semantics.md#42-revert_to_commitcommit_id--null) (primitive), [BSP-007 §2.2](../../notebook/BSP-007-overlay-git-semantics.md#22-persistence) (refs persistence), [PLAN-atom-refactor.md §4 row CK3](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [apply-overlay-commit](apply-overlay-commit.md), [create-overlay-ref](create-overlay-ref.md), [discipline/save-is-git-style](../discipline/save-is-git-style.md)

## Definition

`revert_to_commit(commit_id) → null` rewinds the overlay `HEAD` ref to a prior commit **without rewriting history**. This is `git reset --hard` semantics on the ref + `git reflog` semantics on the storage: `commits[]` is append-only, so the previously-reachable-but-now-dangling commits remain inspectable in History mode (KB-target §18). Future commits build from the new HEAD.

## Operation signature

Wire envelope (per BSP-007 §8):

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "zone_mutate",
    intent_kind: "revert_overlay_to_commit",
    parameters: {
      commit_id: "ovc_01HZX7J9..."
    }
  }
}
```

## Invariants / Preconditions

Per BSP-007 §4.2:

1. **Verify reachability**: `commit_id` MUST be reachable from the root (an ancestor of current HEAD, or reachable via any other named ref). Otherwise **K91** (`overlay_commit_unreachable`).
2. **Set `HEAD = commit_id`.** No mutation to `commits[]`.
3. **Future commits build from the new HEAD.** The previously-reachable-but-now-dangling commits remain in `commits[]` and are still inspectable in History mode (KB-target §18). V1 keeps them indefinitely; V2 may add operator-driven garbage collection.

Additional invariants:

- Reverting **does not remove or edit any commit.** `commits[]` is append-only forever.
- Named refs (created via [create-overlay-ref](create-overlay-ref.md)) are unchanged by revert; they continue to point at their pinned commits. This is what keeps the dangling commits reachable for inspection / future cherry-pick (V2+).
- A revert is itself NOT a new commit — it's a ref-move event. History mode renders it as a separate timeline annotation.
- **Decision CK3 — checkpoint reversibility**: an applied checkpoint (created via the [pin-exclude-scratch-checkpoint](pin-exclude-scratch-checkpoint.md) `set_checkpoint(true)` op) is reverted via this primitive by passing the commit immediately before the checkpoint commit. The covered cells return to their pre-checkpoint state. An explicit `uncheckpoint_section` op is also allowed but reduces to the same mechanism.

### Failure modes

| Code | Symptom |
|---|---|
| **K91** | `commit_id` not in `commits[]` (wrong ID, or refers to a different zone) |
| **K95** | Revert blocked by in-flight execution on a cell affected by the rewind (KB-target §22.7); operator must wait or stop the run |

## V1 vs V2+

- **V1**: single-chain history; revert moves HEAD on the one and only chain. Dangling commits kept indefinitely.
- **V2+**: branched history; revert may need explicit branch context (which branch's HEAD to move). Operator-driven GC of unreachable commits.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the entity HEAD points at.
- [apply-overlay-commit](apply-overlay-commit.md) — the inverse direction (advance HEAD).
- [create-overlay-ref](create-overlay-ref.md) — pin a commit_id with a named ref before reverting if you want to return.
- [pin-exclude-scratch-checkpoint](pin-exclude-scratch-checkpoint.md) — checkpoint flag uses this to satisfy decision CK3.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — the git-style design that makes "non-destructive revert" possible.
