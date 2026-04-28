# BSP-007: Overlay Git Semantics

**Status**: Issue 1 — Draft, 2026-04-28
**Related**: BSP-002 (conversation graph; §12 names "overlay graph (operator edits as second git-style layer)" but does not develop it), BSP-003 (writer registry; intent envelope pattern that overlay operations submit through), BSP-005 (cell roadmap), KB-notebook-target.md §0.1 (V1 amendments — "Section" replaces "Zone"; this BSP fills the §0.11 BSP-007 gap), §3 (DAG vs overlay), §5 (split/merge as overlay commits), §22.1 (split/merge invariants)
**Defers to V2/V3**: parallel overlay branches, branch merging, multi-operator conflict resolution

## 1. Scope

This BSP specifies the **overlay graph**: the operator-side, git-style layer of structural and editorial changes that sits ABOVE the immutable agent turn DAG. KB-notebook-target.md gestures at "git-like" arrangement (KB-target §3, §5) and references "overlay commits" (KB-target §19, §22.1) without ever pinning the data model. This BSP closes that gap.

**In scope:**

- The `OverlayCommit` data model — schema, persistence, refs (§2)
- The enumerated set of overlay operations (§3)
- The primitives that move HEAD: `apply_commit`, `revert_to_commit`, `diff`, `branch` (§4)
- V1 vs V2 vs V3 scope (§5)
- Cell-level merge correctness rules pulled forward from KB-target §22.1 (§6)
- Failure modes K90-K95 (§7)
- Wire integration through BSP-003's intent envelope (§8)
- Test surface (§9), forward-compat shape (§10), implementation slice (§11)

**Out of scope:**

- The agent turn DAG itself (BSP-002 §2 — immutable; this BSP only acts ABOVE it)
- The within-turn overlay graph for annotations/replacements/redactions/tags (BSP-002 §12 — that is a *per-turn render-time* overlay; THIS BSP is the *notebook-structural* overlay that arranges cells and sections). The two layers compose; they do not conflict.
- Cell directive grammar (BSP-002 §3)
- Wire transport details (BSP-003 §3, RFC-006)
- ContextPacker (BSP-008)

**Naming.** Per KB-target §0.1, this BSP uses **Section** for what KB-target's body calls "Zone." The overlay graph operates over Sections and Cells.

## 2. The overlay-commit data model

The overlay graph is a chain of **commits**, each of which records an ordered list of **operations** that mutated the cell/section arrangement. Like git: commits are immutable; refs are mutable pointers; HEAD advances on each apply.

### 2.1 OverlayCommit

```jsonc
{
  "commit_id": "ovc_01HZX7K3...",        // ULID
  "parent_id": "ovc_01HZX7J9..." | null, // null only for the root commit
  "author": "operator",                   // V1: single-operator. V3+: multi-operator (user_id)
  "timestamp": "2026-04-28T14:00:00Z",
  "message": "split In[12] at t_381; checkpoint architecture section",
  "operations": [                         // ordered; applied in array order
    { "kind": "split_cell", "cell_id": "c_12", "at_turn_id": "t_381" },
    { "kind": "checkpoint_section", "section_id": "s_arch", "summary": "..." }
  ]
}
```

- `commit_id`: ULID, monotonic so chronological sort is meaningful.
- `parent_id`: the prior commit. The root commit has `null`. V2+ multi-parent for branch merges (see §10).
- `author`: V1 ships the literal string `"operator"` (single-operator). V3 expands to a user identifier; the field's *shape* doesn't change.
- `timestamp`: wall-clock of apply.
- `message`: human-readable summary (rendered in History mode per KB-target §18).
- `operations[]`: ordered, typed. Each entry has a `kind` (one of §3) plus kind-specific parameters. The whole commit applies atomically (§4).

### 2.2 Persistence

```jsonc
"metadata.rts.zone.overlay": {
  "commits": [                            // append-only; never edited or removed
    { /* OverlayCommit */ },
    ...
  ],
  "refs": {
    "HEAD": "ovc_01HZX7K3...",            // always the current materialized commit
    "v1-ship": "ovc_01HZX7J9..."          // operator-defined named refs (tags in V1)
  }
}
```

Persistence follows BSP-003's directory-mirroring rule (BSP-002 §8.1). Future directory layout: `overlay/commits/<commit_id>.json` and `overlay/refs.json`. Round-trip equivalence with the JSON form is required.

### 2.3 Refs

- `HEAD` always exists once the first commit lands; before that, the overlay is empty and the cell layout is the bare BSP-002 turn ordering.
- Named refs are operator-defined string keys (e.g., `"v1-ship"`, `"pre-refactor"`). In V1 they are **tags**: created at a commit_id, never moved. V2 promotes them to **branches** (mutable; see §5).
- Reserved ref names: `HEAD`. Refs starting with `_` are reserved for kernel use.

### 2.4 Materialization

The current cell/section arrangement is the result of folding `commits[]` from root to HEAD over the bare turn DAG. The Cell Manager (KB-target §2) is the resolver. Materialization is deterministic; equivalent commits in equivalent order produce the same arrangement.

## 3. Operations enumerated

The overlay supports the following operation kinds. Several already exist in BSP-003's intent registry (§5); their inclusion here connects them to the commit model. New kinds (split, merge, move, section ops, promote, checkpoint) are additive to BSP-003 — see §8 and the report's intent registry additions.

### 3.1 Cell-level (existing in BSP-003 §5; now wrapped in commits)

| `kind` | Parameters | Effect |
|---|---|---|
| `set_cell_metadata` | `cell_id`, `path`, `value` | Update `metadata.rts.cells[<id>].*` (BSP-002 §6 cell render-time cache, plus toggles) |
| `update_ordering` | `cell_id`, `new_index` | Re-position one cell within its section |
| `set_pin` | `cell_id`, `pinned: bool` | Toggle pin flag (KB-target §22.1 boundary) |
| `set_exclude` | `cell_id`, `excluded: bool` | Toggle exclude flag |
| `set_scratch` | `cell_id`, `scratch: bool` | Toggle scratch flag (KB-target §13.4) |
| `set_checkpoint` | `cell_id`, `checkpoint: bool` | Promote/demote to checkpoint cell (KB-target §22.1 boundary) |
| `add_overlay` | `target_turn_id`, `overlay_kind`, `content`, `context_modifying` | Within-turn overlay (BSP-002 §12). Listed here because the overlay-commit model envelops *all* operator structural+editorial changes; per-turn overlays compose under it. |
| `move_overlay_ref` | `target_turn_id`, `overlay_id` | Advance the per-turn overlay ref (BSP-002 §12.4) |

### 3.2 Cell-structural (new in this BSP)

| `kind` | Parameters | Effect |
|---|---|---|
| `split_cell` | `cell_id`, `at_turn_id` | Split the cell at the boundary before `at_turn_id`; returns `new_cell_id` (deterministic from commit_id + parent cell_id). Preconditions per §6.2. |
| `merge_cells` | `cell_a`, `cell_b` | Append cell_b's turns into cell_a as sub-turns (KB-target §0.2). cell_b is removed; cell_a survives. Preconditions per §6.1. |
| `move_cell` | `cell_id`, `target_section`, `position` | Relocate a cell into another section at the given index. Crossing a hard provenance boundary (pin/exclude/checkpoint) is allowed but the cell carries its boundary; merge across the boundary remains forbidden (§6). |

### 3.3 Section-level (new; per KB-target §0.1, KB-target §6)

| `kind` | Parameters | Effect |
|---|---|---|
| `create_section` | `section_id`, `title`, `parent_section_id` | Create a new Section. `parent_section_id` may be null (top-level). |
| `delete_section` | `section_id` | Remove a Section. The Section must be empty (no cells) or the operation must include explicit `move_cells_into_section` ops in the same commit moving all cells out first. |
| `rename_section` | `section_id`, `title` | Update the visible title. |
| `move_cells_into_section` | `cell_ids[]`, `target_section_id`, `position` | Bulk-move cells into a Section. Equivalent to a sequence of `move_cell` operations; included as a single op for atomicity in checkpointing/exporting workflows. |

### 3.4 Promote / checkpoint (new; per KB-target §5, §13)

| `kind` | Parameters | Effect |
|---|---|---|
| `promote_span` | `span_id`, `cell_kind`, `section_id` | Promote an artifact span (KB-target §16) into a new addressable cell. Returns `new_cell_id`. Cell starts empty of turns; carries the span as a binding. |
| `checkpoint_section` | `section_id`, `summary`, `range[]?` | Create a checkpoint cell summarizing a Section (or a sub-range of cells within it). Adds the checkpoint cell at the end of the range and marks the range `checkpointed` (KB-target §22.6). |

**Operation count:** 8 cell-level + 3 cell-structural + 4 section-level + 2 promote/checkpoint = 17 distinct kinds.

## 4. Operations primitives

The four operations on the overlay graph itself.

### 4.1 `apply_commit(operations[]) → new_commit_id`

Atomic. The writer:

1. Validates each operation in order against the current materialized state (`HEAD`-folded view).
2. If any operation's preconditions fail (§6, §7), the entire commit is rejected (K90/K93/K94). No partial application.
3. On success, mints `new_commit_id`, sets `parent_id = HEAD`, appends to `commits[]`, advances `HEAD` to the new commit.
4. Emits a single `intent_applied` event (BSP-003 §6) carrying the commit_id and the resulting `snapshot_version`.

A commit MAY contain a single operation (the common case) or many (e.g., bulk reorganize). The `operations[]` array is the unit of atomicity.

### 4.2 `revert_to_commit(commit_id) → null`

Rewinds HEAD without rewriting history.

1. Verify `commit_id` is reachable from the root (ancestor of current HEAD or any other ref). Otherwise K91.
2. Set `HEAD = commit_id`. Do **not** remove commits from `commits[]`.
3. Future commits build from the new HEAD; the previously-reachable-but-now-dangling commits remain in `commits[]` and are still inspectable in History mode (KB-target §18).

This is `git reset --hard` semantics on the ref, with `git reflog` semantics on the storage. V1 keeps the dangling commits indefinitely. V2 may add operator-driven garbage collection.

### 4.3 `diff(commit_a, commit_b) → operations[]`

Returns the ordered sequence of operations needed to transform the materialized state at `commit_a` into the state at `commit_b`. Both commit_ids must exist in `commits[]` (otherwise K91).

When `commit_b` is a descendant of `commit_a`, the diff is the concatenation of `operations[]` from each intervening commit. When the two are on divergent histories (only possible in V2+ with parallel branches; in V1 all commits are on one chain), the V1 implementation returns the operations to revert from `commit_a` to the common ancestor, then forward to `commit_b`.

`diff` powers History mode (KB-target §18): walking the timeline shows operator-readable operation summaries, not raw JSON. Audit trails consume the same output.

### 4.4 `branch(commit_id, name) → null`

Creates a named ref pointing at `commit_id`.

- V1: refs are **tags**. Once created, the ref is immutable. Re-using `name` raises K92.
- V2: refs become **branches**. The ref is mutable; the operator can switch HEAD between branches. Branch creation does not change HEAD. (See §5.)

`branch` is the only primitive that creates a non-HEAD ref. `apply_commit` advances HEAD; `revert_to_commit` moves HEAD; named refs are created once and (in V1) frozen.

## 5. V1 vs V2 vs V3 scope

| Capability | V1 | V2 | V3+ |
|---|---|---|---|
| Linear append-only history | yes | yes | yes |
| `apply_commit` / `revert_to_commit` | yes | yes | yes |
| Named refs as tags (immutable after creation) | yes | — | — |
| Named refs as branches (mutable; HEAD switchable) | no | yes | yes |
| Parallel overlay histories (multiple branch tips) | no | yes | yes |
| `cherry-pick` (apply a commit from one branch to another) | no | yes | yes |
| Merge of overlay branches (multi-history reconciliation) | no | no | yes |
| Multi-operator concurrent commits with conflict resolution | no | no | yes (CRDT/OT per BSP-003 §9) |

**Critical V1 distinction:** "merge" in this BSP refers to **cell merge** (`merge_cells`, §3.2), which is an operation INSIDE a single commit. **Overlay-branch merge** — reconciling two divergent overlay histories — is V3+ and explicitly NOT in this BSP. A V1 reader must keep these terms separate. The §6 rules govern cell merge only.

## 6. Merge correctness rules (cell merge)

These are the V1 invariants for the `merge_cells` operation (§3.2). They are pulled forward from KB-target §22.1; recorded here so the validator (§4.1 step 2) has a single, unambiguous reference.

### 6.1 Merge allowed when ALL hold

(Pulled from KB-target §22.1.)

- Same primary cell kind (KB-target §0.4: `agent_cell`, `markdown_cell`, `scratch_cell`, `checkpoint_cell` in V1; reserved kinds error)
- Same executor/provenance domain (if agent-owned, same `bound_agent_id` per BSP-002 §6)
- Same Section, or compatible parent Section (one is the immediate parent of the other; rare)
- No pin/exclude/checkpoint boundary between them in the current materialized order
- No executing or partial run in either cell (KB-target §22.7 — execution owns its output)
- Append preserves turn ordering: `cell_a`'s last turn must be the parent (BSP-002 §2.1 `parent_id`) of `cell_b`'s first turn, OR they share the same parent and merge declares `cell_b` as the chronologically later sibling
- Bindings remain unambiguous: no two turns in the merged cell may bind the same artifact span ambiguously

If any precondition fails → K93.

### 6.2 Split allowed when ALL hold

(Sibling rule for `split_cell`.)

- The split point (`at_turn_id`) is a turn boundary in `cell_id` (not mid-turn)
- Both resulting cells remain valid single-role cells (KB-target §13.1 — one cell, one system role)
- The split does not separate a turn from its required tool-call children (KB-target §0.3 — tool calls live in their parent turn)
- No executing or partial run in the cell (KB-target §22.7)

If any precondition fails → K94.

### 6.3 Forbidden across hard provenance boundaries

(KB-target §22.1.) Merge is rejected unconditionally when:

- agent cell + tool cell
- agent cell + native cell
- tool output + checkpoint cell
- cells owned by different executor sessions (BSP-002 §2.2 different `claude_session_id`) without explicit operator bridge
- cells separated by pin / exclude / checkpoint semantics
- cells from incompatible branches (different `parent_id` chains in the turn DAG with no common ancestor in scope)
- cells with committed decision/checkpoint boundaries between them
- currently executing cells
- partial/interrupted cells unless first normalized by the operator

These are all subsumed by §6.1 but enumerated explicitly because each is a distinct user-facing rejection reason that the validator surfaces verbatim in K93's `reason` field.

### 6.4 Sub-turn output

(KB-target §0.2.) A successful `merge_cells(cell_a, cell_b)` produces sub-turns: cell_a's existing turns become `cell_a.1 ... cell_a.N`; cell_b's turns are appended as `cell_a.(N+1) ... cell_a.(N+M)`. The sub-turn addressing (`cell:c_a.k`) is the V1 stable handle for any inbound reference (KB-target §14).

## 7. Failure modes (K-class — overlay-commit namespace, K90+)

K90+ is a fresh block. Existing reservations: K1-K12 RFC-008, K20-K27 BSP-002, K30-K32 BSP-002 §12 overlays, K40-K43 BSP-003, K50 BSP-004, K70-K74 FSP-003, K80-K84 RFC-009. K90+ is clear.

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K90 | Invalid commit (one or more operations failed validation; commit rejected wholesale) | `overlay_commit_invalid` with `failed_operation_index`, `reason` | Surface the per-operation reason; the commit was not applied |
| K91 | Revert / diff target unreachable (commit_id not in `commits[]`) | `overlay_commit_unreachable` with `commit_id` | The ID is wrong or refers to a different zone; check History mode |
| K92 | Named ref name conflict (V1 tag already exists at a different commit) | `overlay_ref_conflict` with `name`, `existing_commit_id` | Choose a new name; V1 tags are immutable |
| K93 | Merge precondition violated (kind mismatch, provenance boundary, etc. — §6.1, §6.3) | `overlay_merge_rejected` with `cell_a`, `cell_b`, `reason` | Resolve the boundary first (e.g., demote a checkpoint, stop a run) or split differently |
| K94 | Split precondition violated (mid-turn, would orphan tool calls, etc. — §6.2) | `overlay_split_rejected` with `cell_id`, `at_turn_id`, `reason` | Choose a turn boundary; separate tool calls from their parent turn first if needed |
| K95 | Operation on a commit older than current HEAD blocked because execution is in flight (KB-target §22.7) | `overlay_blocked_by_execution` with `cell_id`, `run_id` | Wait for the run to complete or stop it explicitly |

K90, K93, K94 reject the whole commit (no state change). K91, K92 reject the primitive call. K95 is a structural-edit guard analogous to BSP-003's CAS path but tied to runtime state, not snapshot version.

## 8. Wire integration

All overlay operations submit through BSP-003's `submit_intent` envelope. The new wrapper `intent_kind` is `apply_overlay_commit`:

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type": "zone_mutate",
    "intent_kind": "apply_overlay_commit",
    "parameters": {
      "message": "split In[12] at t_381",
      "operations": [
        { "kind": "split_cell", "cell_id": "c_12", "at_turn_id": "t_381" }
      ]
    },
    "intent_id": "01HZX7K3...",
    "expected_snapshot_version": 42
  }
}
```

`revert_to_commit` and `branch` (the named-ref creator) are also intent kinds (`revert_overlay_to_commit`, `create_overlay_ref`). `diff` is read-only and does not submit an intent.

The kernel's `MetadataWriter` applies the commit (per §4.1) and emits the new HEAD on its `notebook.metadata` snapshot (BSP-003 §6 step 9). The extension subscribes and re-renders. History mode (KB-target §18) walks `commits[]` directly from the snapshot.

The individual operation kinds in §3 do NOT submit independently. They are *parts* of `apply_overlay_commit`'s parameters. This preserves the atomicity contract of §4.1.

**BSP-003 amendment required.** The new intent kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`) must be added to BSP-003 §5's intent registry. The new operation kinds within `apply_overlay_commit.operations[]` (split_cell, merge_cells, move_cell, create_section, delete_section, rename_section, move_cells_into_section, promote_span, checkpoint_section) are sub-kinds dispatched by the overlay applier; they need a parallel registration but live under BSP-007's authority, not BSP-003's. See the report.

## 9. Test surface

Sketch of test cases (this is a spec, not implementation).

- `test_apply_commit_atomic` — submit a commit with two operations where the second fails preconditions; assert the first is rolled back and HEAD is unchanged.
- `test_apply_commit_advances_head_and_records` — single valid op; HEAD advances; `commits[]` length grows by 1; `intent_applied` event emitted.
- `test_revert_preserves_history` — apply 5 commits; revert to commit 2; assert `commits[]` still contains all 5; HEAD points at commit 2; commits 3-5 still inspectable.
- `test_revert_unreachable_commit_rejected` — call `revert_to_commit` with a random ULID; expect K91.
- `test_named_ref_immutable_after_creation_in_v1` — create tag `"v1-ship"` at commit 3; attempt to re-create at commit 4; expect K92.
- `test_diff_linear_history` — `diff(commit_2, commit_5)` returns concatenated operations from commits 3, 4, 5.
- `test_merge_rejects_kind_mismatch` — merge agent_cell + checkpoint_cell; expect K93 with `reason: "different_primary_kind"`.
- `test_merge_rejects_pin_boundary` — pin a cell between two otherwise-mergeable cells; expect K93 with `reason: "pin_boundary"`.
- `test_merge_produces_sub_turns` — merge two single-turn cells; assert resulting cell has sub-turn addressing per §6.4.
- `test_split_at_invalid_boundary_rejected` — split mid-turn; expect K94.
- `test_split_separates_tool_calls_from_parent_rejected` — split such that a tool call's parent turn would land in the other cell; expect K94.
- `test_overlay_blocked_during_execution` — start a run on cell c_5; submit `merge_cells(c_4, c_5)`; expect K95.
- `test_section_delete_requires_empty` — delete a non-empty section without bulk-move; expect K90 (the contained `delete_section` op fails validation).
- `test_promote_span_creates_new_cell` — promote an artifact span; assert new cell exists with the span as a binding and turn list is empty.
- `test_apply_overlay_commit_intent_envelope` — round-trip the BSP-003 envelope; assert the intent dispatches to the overlay applier, not to a per-op handler.

## 10. Forward-compat with V2/V3

The V1 shapes that don't reshape for V2/V3:

- **Refs are already strings.** Promoting tags to branches in V2 is a behavioral change (mutable vs immutable), not a schema change. The `refs` map stays.
- **Commits already have a `parent_id` field.** V2 multi-parent (branch merge) generalizes this to `parent_ids[]` — a backward-compatible addition: V1 readers see one parent; V2 commits with multiple parents serialize as an array. A schema migration converts V1 single `parent_id` to `parent_ids: [<id>]` losslessly.
- **Operations are typed.** V2's new operation kinds (cherry-pick result, branch reconciliation) are additive enum entries. V1 readers reject unknown kinds (K90); V2 readers handle them.
- **`author` field is already a string.** V3 multi-operator just expands the value space.
- **The intent envelope is already the seam.** Per BSP-003 §9, V3 wraps the V1 envelope in a coordination shell; the overlay-commit pattern fits without redesign.

What does NOT survive without reshaping:

- The "single linear history" assumption in §4.4 (V1 named refs are tags). V2 must explicitly migrate semantics; the data is fine.
- The V1 K91 message ("commit_id not in commits[]") works because in V1 all commits are reachable from HEAD or via a tag. V2 may have orphan commits after branch deletion; K91's marker stays the same but the operator action expands.

## 11. Implementation slice

Single ~3-day slice owned by **K-OVERLAY**. Not strictly blocking V1 ship of cell-side slices (BSP-005), but **required for KB-target §18 History mode in V1** and required for any V1 UX that lets the operator split / merge / checkpoint visibly.

Work breakdown:

1. **Schemas (~0.5 day).** `OverlayCommit` JSON schema + persistence layout under `metadata.rts.zone.overlay.*`. Round-trip tests vs the directory-mirror format.
2. **MetadataWriter dispatcher integration (~0.5 day).** New intent kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`) wired to the overlay applier. Validation hooks per §6.
3. **Cell-structural operations (~1 day).** `split_cell`, `merge_cells`, `move_cell`. The §6 validators. Sub-turn addressing materializer.
4. **Section-level + promote/checkpoint (~0.5 day).** `create_section`, `delete_section`, `rename_section`, `move_cells_into_section`, `promote_span`, `checkpoint_section`.
5. **Tests (~0.5 day).** The §9 surface, plus round-trip and dispatcher tests.

X-EXT downstream work (separate slice, sized by the extension team): a History-mode panel that walks `metadata.rts.zone.overlay.commits[]` and renders `diff(commit_a, commit_b)` operation summaries. Not blocking K-OVERLAY's slice; the kernel ships the data and the wire shape, the extension renders.

## Changelog

- **Issue 1, 2026-04-28**: initial draft. Closes the BSP-007 gap from KB-target §0.11. Pins the overlay-commit data model, the four primitives, the V1 vs V2 vs V3 scope split, the cell-merge correctness rules pulled forward from KB-target §22.1, K90-K95 failure modes, BSP-003 intent envelope integration, and the K-OVERLAY 3-day slice. Calls out the BSP-003 §5 intent registry amendments needed.
