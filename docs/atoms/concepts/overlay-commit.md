# Overlay commit

**Status**: V1 shipped (`apply_commit`, `revert_to_commit`, `diff` ship; tag-style refs only — branches V2)
**Source specs**: [BSP-007 §2](../../notebook/BSP-007-overlay-git-semantics.md#2-the-overlay-commit-data-model), [BSP-007 §3](../../notebook/BSP-007-overlay-git-semantics.md#3-operations-enumerated), [BSP-002 §12](../../notebook/BSP-002-conversation-graph.md#12-overlays--operator-edits-as-a-second-git-style-graph), [KB-notebook-target.md §3](../../notebook/KB-notebook-target.md#3-the-central-architectural-split) (DAG vs overlay)
**Related atoms**: [cell](cell.md), [section](section.md), [turn](turn.md), [sub-turn](sub-turn.md)

## Definition

An **overlay commit** is the immutable record of one structural or editorial edit (or a small ordered set of them) applied to the cell/section overlay above the immutable [turn](turn.md) DAG. Overlay commits are the operator's mutable layer made durable: split, merge, move, section create/delete/rename, pin/exclude/scratch/checkpoint toggles, and within-turn overlays (annotations, replacements, redactions, tags) are all recorded as commits. Overlay commits are atomic — the whole `operations[]` array applies or the commit is rejected. The chain of commits is a linear history in V1; HEAD advances on `apply_commit` and is rewindable via `revert_to_commit` without rewriting history.

## Schema

```jsonc
// metadata.rts.zone.overlay.commits[]
{
  "commit_id":  "ovc_01HZX7K3...",         // ULID; monotonic
  "parent_id":  "ovc_01HZX7J9..." | null,  // null only for the root commit
  "author":     "operator",                // V1: literal "operator"; V3+ user id
  "timestamp":  "2026-04-28T14:00:00Z",
  "message":    "split In[12] before span 4; checkpoint architecture section",
  "operations": [                          // ordered; applied in array order
    { "kind": "split_cell",         "cell_id": "c_12", "at": { "kind": "span_boundary", "before_span_index": 4 } },
    { "kind": "checkpoint_section", "section_id": "s_arch", "summary": "..." }
  ]
}

// metadata.rts.zone.overlay.refs
{
  "HEAD":       "ovc_01HZX7K3...",         // current materialized commit
  "v1-ship":    "ovc_01HZX7J9..."          // operator-defined named refs (V1: tags)
}
```

## Operation kinds (17 total in V1)

Cell-level (8): `set_cell_metadata`, `update_ordering`, `set_pin`, `set_exclude`, `set_scratch`, `set_checkpoint`, `add_overlay`, `move_overlay_ref`. Cell-structural (3): `split_cell`, `merge_cells`, `move_cell`. Section-level (4): `create_section`, `delete_section`, `rename_section`, `move_cells_into_section`. Promote/checkpoint (2): `promote_span`, `checkpoint_section`.

## Invariants

- **Commits are immutable.** `commit_id`, `parent_id`, `operations[]`, `author`, `timestamp`, `message` never change once persisted. `revert_to_commit` moves HEAD; it does NOT rewrite history.
- **Atomic application.** [apply-overlay-commit](../operations/apply-overlay-commit.md) validates every operation against the HEAD-folded view; one failure rejects the whole commit. K90.
- **Linear history in V1.** `parent_id` is single-valued. V2+ generalizes to `parent_ids[]` for branch-merges; V1 stays on one chain.
- **The DAG never moves.** Overlay commits operate ABOVE the immutable [turn](turn.md) DAG. Merge produces [sub-turns](sub-turn.md) by reordering `cell_range` only.
- **Refs are strings; HEAD always exists** once the first commit lands. V1 named refs are tags (immutable after creation, K92 on conflict). V2 promotes them to mutable branches.
- **Reachability for revert/diff.** `revert_to_commit(c)` and `diff(a, b)` require the target commit_ids to be in `commits[]`; otherwise K91. V1 keeps dangling commits indefinitely (`git reflog` semantics on storage).
- **Wire-thru intent envelope.** All overlay operations submit through BSP-003's `submit_intent` as `intent_kind: "apply_overlay_commit"` (or `revert_overlay_to_commit` / `create_overlay_ref`). The 17 operation kinds in §3 are sub-kinds within the commit; they do NOT submit independently.

## V1 vs V2+

- **V1**: `apply_commit`, `revert_to_commit`, `diff`, named refs as tags, single linear history; the 17 operation kinds active.
- **V2+**: named refs become mutable branches; multi-tip parallel history; cherry-pick. Branch-merge reconciliation (multi-history with conflict) lands V3+ alongside multi-operator support.

## See also

- [operations/apply-overlay-commit](../operations/apply-overlay-commit.md) — the writer primitive.
- [operations/revert-overlay-commit](../operations/revert-overlay-commit.md) — HEAD rewind.
- [operations/create-overlay-ref](../operations/create-overlay-ref.md) — V1 tag creation.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — why this graph mirrors git.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — turn DAG immutable, overlay mutable.
- [run-frame](run-frame.md) — RunFrames are immutable historical records orthogonal to overlay commits.
