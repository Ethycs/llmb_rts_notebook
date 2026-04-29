# Operation: create-overlay-ref

**Status**: V1 spec'd (BSP-007 K-OVERLAY slice)
**Source specs**: [BSP-007 §4.4](../../notebook/BSP-007-overlay-git-semantics.md#44-branchcommit_id-name--null) (primitive — V1 tag semantics), [BSP-007 §2.3](../../notebook/BSP-007-overlay-git-semantics.md#23-refs) (refs schema), [BSP-007 §5](../../notebook/BSP-007-overlay-git-semantics.md#5-v1-vs-v2-vs-v3-scope) (V1 vs V2 scope)
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [apply-overlay-commit](apply-overlay-commit.md), [revert-overlay-commit](revert-overlay-commit.md), [discipline/save-is-git-style](../discipline/save-is-git-style.md)

## Definition

`branch(commit_id, name) → null` creates a named ref pointing at an existing [overlay commit](../concepts/overlay-commit.md). In V1 the named ref is a **tag** (immutable after creation); in V2 the same primitive promotes refs to **branches** (mutable, HEAD-switchable). The primitive is the only one besides `apply_commit` that creates a non-HEAD ref.

> The atom is named `create-overlay-ref` to reflect its V1 reality (tag creation) and to avoid conflating it with [branch-agent](branch-agent.md), which is the unrelated agent-graph operation.

## Operation signature

Wire envelope (per BSP-007 §8):

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "zone_mutate",
    intent_kind: "create_overlay_ref",
    parameters: {
      commit_id: "ovc_01HZX7J9...",
      name: "v1-ship"
    }
  }
}
```

After success, `metadata.rts.zone.overlay.refs[<name>] = commit_id`.

## Invariants / Preconditions

- `commit_id` MUST exist in `metadata.rts.zone.overlay.commits[]`; else **K91** (`overlay_commit_unreachable`).
- `name` MUST NOT already exist in `refs`. V1 tags are **immutable**: re-using `name` raises **K92** (`overlay_ref_conflict` with `name`, `existing_commit_id`).
- Reserved ref names: `HEAD` (always exists once the first commit lands; managed automatically by [apply-overlay-commit](apply-overlay-commit.md) and [revert-overlay-commit](revert-overlay-commit.md)). Refs starting with `_` are reserved for kernel use and rejected by this primitive.
- `name` MUST be a non-empty string. Operator-defined keys are case-sensitive; conventional examples: `"v1-ship"`, `"pre-refactor"`, `"checkpoint-2026-04-28"`.
- This primitive does NOT change HEAD. To create-and-switch, the operator follows up with [revert-overlay-commit](revert-overlay-commit.md).

## What it produces

- One new entry in `metadata.rts.zone.overlay.refs`. No new commit. No HEAD movement.
- The named ref keeps the targeted commit reachable indefinitely. This is what protects "dangling" post-revert commits (per [revert-overlay-commit](revert-overlay-commit.md)) from being garbage-collected — even if the V1 GC is "never collect," V2's GC will respect named refs as roots.

## V1 vs V2+

- **V1**: refs are **tags**. Once created, immutable. No re-creation under the same name (K92). No HEAD switching between refs (V1 is single-history).
- **V2+**: refs become **branches** — mutable; the operator can switch HEAD between branches (`switch_overlay_ref(name)`). Branch creation does not change HEAD; an operator op does that.
- **V3+**: branches participate in merge / cherry-pick reconciliation; multi-operator concurrency.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — what refs point at.
- [apply-overlay-commit](apply-overlay-commit.md) — advances HEAD; complements ref creation.
- [revert-overlay-commit](revert-overlay-commit.md) — moves HEAD; named refs let you return.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — the git-style discipline this primitive serves.
- [branch-agent](branch-agent.md) — distinct operation on the agent graph; do not confuse.
