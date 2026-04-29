# Discipline: immutability vs mutability — turn DAG immutable, overlay mutable

**Status**: discipline (V1 invariant; the central architectural split)
**Source specs**: [KB-notebook-target.md §3](../../notebook/KB-notebook-target.md#3-the-central-architectural-split) (the central architectural split), [BSP-002 §2](../../notebook/BSP-002-conversation-graph.md#2-data-modelgit-for-the-notebooks-turn-dag) (data model — git for the turn DAG), [BSP-002 §12](../../notebook/BSP-002-conversation-graph.md#12-overlays--operator-edits-as-a-second-git-style-graph) (overlays — second git-style graph), [BSP-007 §1](../../notebook/BSP-007-overlay-git-semantics.md#1-scope) (overlay above immutable DAG)
**Related atoms**: [turn](../concepts/turn.md), [overlay-commit](../concepts/overlay-commit.md), [run-frame](../concepts/run-frame.md), [discipline/save-is-git-style](save-is-git-style.md)

## The rule

**The turn DAG is immutable. The overlay graph is mutable.**

Two graphs, two responsibilities, one mechanism. The operator may rearrange freely; the agent's truth is preserved verbatim.

| Graph | Mutability | What it is | Who writes it |
|---|---|---|---|
| **Turn DAG** (BSP-002 §2) | **Immutable** | Append-only record of every operator + agent message ever contributed to the zone | Agents + operator inputs at execution time |
| **Overlay graph** (BSP-007) | **Mutable** | Git-style commit log of structural / editorial arrangement (split, merge, move, sections, flags, per-turn annotations) | Operator only |

> DAG = what happened. Overlay = what it now means to the operator. (KB-target §21.1)

## The architectural payoff

This separation solves the deepest problem chat has:

> Chat conflates **history** with **presentation**. (KB-target §3)

In chat, editing a message destroys the original. Branching means losing context. Reverting means deleting work. The notebook breaks the conflation:

- **History remains intact** — `metadata.rts.zone.agents.<id>.turns[]` is append-only. Every turn ever produced is still in the file.
- **Presentation can be repaired** — split / merge / move / pin / exclude / checkpoint via overlay commits. The materialized arrangement changes; the underlying record doesn't.

The operator can split, merge, collapse, summarize, checkpoint, reorder, label, pin, exclude, branch, and inspect — without corrupting the conversation trace.

## What's immutable, exactly

Immutable in V1 (per BSP-002 §2):

- `metadata.rts.zone.turns[]` entries — `id`, `parent_id`, `agent_id`, `provider`, `claude_session_id`, `role`, `body`, `spans[]`, `cell_id`, `created_at`. None of these change after the turn commits.
- [run-frame](../concepts/run-frame.md) records — historical execution snapshots. Decision **F1** specifically protects them: flag toggles do NOT affect existing RunFrames.
- The dangling commits in `overlay.commits[]` after a [revert-overlay-commit](../operations/revert-overlay-commit.md) — `commits[]` is append-only; revert moves the HEAD ref, never deletes.

## What's mutable, exactly

Mutable in V1:

- `agent.head_turn_id` — moves on every continue, branch, or [revert-agent](../operations/revert-agent.md). Like a git branch ref.
- `agent.runtime_status`, `agent.pid`, `agent.last_seen_turn_id` — process-state caches.
- `metadata.rts.zone.overlay.refs.HEAD` — moves on every [apply-overlay-commit](../operations/apply-overlay-commit.md) and [revert-overlay-commit](../operations/revert-overlay-commit.md).
- `metadata.rts.zone.sections[]` — sections are operator overlays; created, renamed, deleted.
- `metadata.rts.cells[<id>].kind / .pinned / .excluded / .scratch / .checkpoint / .section_id` — flag and arrangement metadata.

## What's mixed

Per-turn overlays (BSP-002 §12: annotation, replacement, redaction, tag) attach to immutable turns but are themselves operator-mutable. They compose at render time:

```
renderCell(turn_id):
  base = turn.body                    # immutable
  if overlay_refs[turn_id]:
    base = applyOverlay(base, overlay) # mutable
  return base
```

The operator can change what's rendered without touching what was emitted. `context_modifying: true` overlays are the operator's signed receipt that downstream agents should see the composed (overlaid) version (BSP-002 §12.5).

## Where the rule applies

- **[continue-turn](../operations/continue-turn.md) / [spawn-agent](../operations/spawn-agent.md)**: append to the immutable side.
- **[revert-agent](../operations/revert-agent.md)**: moves the agent ref; turns between the old head and the new head remain in the DAG (still reachable via `/branch`).
- **[apply-overlay-commit](../operations/apply-overlay-commit.md) / [revert-overlay-commit](../operations/revert-overlay-commit.md)**: mutate the overlay side; never touch turns.
- **[split-cell](../operations/split-cell.md) / [merge-cells](../operations/merge-cells.md) / [move-cell](../operations/move-cell.md)**: structural overlays; underlying turns stay put.
- **RunFrames** ([run-frame](../concepts/run-frame.md)): always immutable; decision **F1** is the explicit guard.

## V1 vs V2+

- **V1**: two graphs, single chain on each.
- **V2+**: branched overlay graph (multiple HEAD-able branches); branched conversation views (BSP-002 §11.2 DAG view with branch-switching). The two-graph rule still holds.
- **V3+**: multi-operator concurrent overlays (BSP-003 §9). Same rule; concurrency layer on top.

## Why

The immutable / mutable split is the design decision that makes everything else possible. Without it, "the operator can edit freely" and "the agent's emission is real" are contradictory goals. With it, both are simultaneously true: edits go to the overlay; the turn record is sacred.

This is the [Maya animation layers / Photoshop layers / Scratch source-vs-sprite](../../notebook/BSP-002-conversation-graph.md#128-why-this-is-the-right-shape-game-dev-rationale) game-dev rationale (BSP-002 §12.8): source pixels + edit layers, each with their own history, composed at render time.

## See also

- [turn](../concepts/turn.md) — the immutable atom.
- [overlay-commit](../concepts/overlay-commit.md) — the mutable atom.
- [run-frame](../concepts/run-frame.md) — historical record protected by decision F1.
- [discipline/save-is-git-style](save-is-git-style.md) — git is the mechanism that lets both halves coexist.
- [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md) — the resolver that composes the two graphs at render time.
