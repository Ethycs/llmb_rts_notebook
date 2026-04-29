# Discipline: save is git-style

**Status**: discipline (V1 invariant)
**Source specs**: [BSP-007 §1](../../notebook/BSP-007-overlay-git-semantics.md#1-scope) (overlay graph scope), [BSP-007 §2](../../notebook/BSP-007-overlay-git-semantics.md#2-the-overlay-commit-data-model) (commit data model), [BSP-007 §4](../../notebook/BSP-007-overlay-git-semantics.md#4-operations-primitives) (primitives), [KB-notebook-target.md §3](../../notebook/KB-notebook-target.md#3-the-central-architectural-split) (DAG vs overlay), [BSP-002 §1](../../notebook/BSP-002-conversation-graph.md#1-scope) ("the notebook is the score")
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [apply-overlay-commit](../operations/apply-overlay-commit.md), [revert-overlay-commit](../operations/revert-overlay-commit.md), [create-overlay-ref](../operations/create-overlay-ref.md), [discipline/immutability-vs-mutability](immutability-vs-mutability.md)

## The rule

**Save semantics are git semantics.** Every operator structural / editorial change is one [overlay commit](../concepts/overlay-commit.md): atomic, named, replayable, reversible. The notebook is the score; the [.llmnb](../../notebook/) file is the canonical record; the overlay history is its commit log.

> The cell overlay is **operator truth — mutable and git-like — how the human arranged, interpreted, compacted, labeled, and scoped the work.** (KB-target §3)

## What "git-style" means here

| Git concept | Notebook analog | V1 status |
|---|---|---|
| `git commit` | [apply-overlay-commit](../operations/apply-overlay-commit.md) — atomic mutation of cell/section arrangement | Shipped (BSP-007) |
| `git reset --hard <ref>` | [revert-overlay-commit](../operations/revert-overlay-commit.md) — moves HEAD without rewriting history | Shipped |
| `git tag` | [create-overlay-ref](../operations/create-overlay-ref.md) — pinned name at a commit (V1: immutable) | Shipped (V1 = tags only) |
| `git branch` | future mutable named ref; HEAD switching | V2+ |
| `git reflog` | append-only `commits[]` keeps dangling commits inspectable | Shipped (BSP-007 §2.2) |
| `git diff` | BSP-007 `diff(commit_a, commit_b)` returns ordered ops | Shipped (read-only primitive) |
| `git merge` | overlay-branch reconciliation across divergent histories | V3+ |

## What the discipline forbids

- **Silent mutation.** No "the kernel quietly tidied your notebook." Every change is a commit with a `message` field.
- **Partial application.** A commit with N operations either applies all N or rejects all N (BSP-007 §4.1). Catching K90 / K93 / K94 keeps the operator's mental model intact.
- **History rewrite.** `commits[]` is append-only forever (BSP-007 §2.2). Revert moves HEAD; it does NOT delete commits. Dangling commits remain in History mode (KB-target §18) for inspection and (V2+) cherry-pick.
- **Hidden refs.** Refs starting with `_` are kernel-reserved; everything else is operator-visible.

## What the discipline requires

- **The notebook is the score.** Per BSP-002 §1: "the agent is a runtime executor; the notebook is the score." All operator intent lives in the file. No out-of-band state.
- **Determinism.** Re-folding the same `commits[]` from root to HEAD over the same turn DAG produces the same materialized arrangement.
- **Inspectability.** History mode (KB-target §18) walks `commits[]` and renders the operator-readable timeline. The operator can answer "what did I change, when, why?" from the data alone.
- **Reversibility on every op.** Pin / exclude / scratch / checkpoint, split / merge / move, section ops, promote — all of them apply through [apply-overlay-commit](../operations/apply-overlay-commit.md) and reverse through [revert-overlay-commit](../operations/revert-overlay-commit.md). No special-case "this can't be undone" affordance.

## Where the rule applies

Every operator-side write to the notebook flows through this discipline:

- Structural ops: [split-cell](../operations/split-cell.md), [merge-cells](../operations/merge-cells.md), [move-cell](../operations/move-cell.md).
- Section ops: [create-section](../operations/create-section.md), [delete-section](../operations/delete-section.md), [rename-section](../operations/rename-section.md).
- Flag ops: [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md).
- Promote: [promote-span](../operations/promote-span.md).
- Per-turn overlays (annotation / replacement / redaction / tag — BSP-002 §12): same commit envelope.

The agent-graph operations ([spawn-agent](../operations/spawn-agent.md), [continue-turn](../operations/continue-turn.md), [revert-agent](../operations/revert-agent.md), [branch-agent](../operations/branch-agent.md), [stop-agent](../operations/stop-agent.md)) are **not** overlay commits — they're agent-DAG mutations on the immutable side. But they ARE git-style (`agent_ref_move` events per BSP-002 §8.5; refs analogous to git branches). The two graphs share the same design discipline.

## V1 vs V2+

- **V1**: linear history; tags only; single-operator.
- **V2+**: branchable overlay history; cherry-pick.
- **V3+**: multi-operator concurrent commits with conflict resolution (CRDT/OT — BSP-003 §9).

## Why

Save semantics in chat tools are usually invisible: messages just appear and never go away. That makes "the operator wants to repair structure" impossible without destroying history.

Save semantics in document editors are usually destructive: undo is a buffer; the file IS the buffer. That makes "the operator wants to branch and compare" impossible.

Git-style save gives both — non-destructive history AND structural editing — and the kernel implementation is straightforward (BSP-007 K-OVERLAY is a 3-day slice). The cost is one mental model the operator already knows.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the unit of save.
- [apply-overlay-commit](../operations/apply-overlay-commit.md) — how saves happen.
- [revert-overlay-commit](../operations/revert-overlay-commit.md) — non-destructive undo.
- [create-overlay-ref](../operations/create-overlay-ref.md) — named pins.
- [discipline/immutability-vs-mutability](immutability-vs-mutability.md) — why two graphs (immutable + mutable) instead of one.
- [discipline/zachtronics](zachtronics.md) — same source-layer ethos.
