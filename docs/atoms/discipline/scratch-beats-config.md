# Discipline: scratch beats config

**Status**: discipline (V1 invariant)
**Source specs**: [KB-notebook-target.md §7](../../notebook/KB-notebook-target.md#7-scope-control) (scope control discipline), [KB-notebook-target.md §13.4](../../notebook/KB-notebook-target.md#134-scratch-is-notebook-level-not-hidden-configuration) (scratch is notebook-level), [KB-notebook-target.md §13.5](../../notebook/KB-notebook-target.md#135-no-super-complex-configuration-in-v1) (no super-complex config)
**Related atoms**: [cell-kinds](../concepts/cell-kinds.md), [discipline/zachtronics](zachtronics.md), [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md)

## The rule

**Prefer operator-flagged scratch cells over elaborate per-cell scope configuration.**

When the operator wants to keep a cell out of the agent's context, the V1 answer is `scratch_cell` (a visible flag), not a `scope:` config block declaring inclusion / exclusion / ranking policies.

> Prefer visible scratch space over invisible advanced configuration. (KB-target §13.4)

## Bad — the shape we forbid

```yaml
# Bad: cell carries a programmable scope policy
scope:
  include:
    ranking_policy:
      semantic_weight: 0.7
      recency_decay: 0.13
      checkpoint_trust: operator_approved_only
      branch_visibility: custom
  exclude:
    if: cell.kind == 'experimental' and cell.age > 14d
```

Why this is wrong:

1. The cell is no longer a visible tile; it's a tiny program. Predicting its effect requires running the policy evaluator.
2. Two cells with identical visible content can have completely different runtime behavior, hidden in the metadata.
3. The operator must context-switch from "writing notebook content" to "writing policy DSL" to make basic scope adjustments.
4. The kernel's job inflates: every commit, every render, every context pack must re-evaluate the policies.

## Better — the V1 shape

The visible cell flags from [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md):

```text
This cell is pinned.        # forced into context
This cell is excluded.      # barred from context
This cell is scratch.       # not part of default context; visually marked
This cell is checkpoint.    # summarizes a range; substitutes for raw turns
```

Plus the structural primitives:

- The notebook order says what comes before this.
- The [section](../concepts/section.md) says how cells group.
- [split-cell](../operations/split-cell.md) and [merge-cells](../operations/merge-cells.md) declare semantic boundaries.

The kernel's [ContextPacker (per KB-target §0.6)](../../notebook/KB-notebook-target.md#06-contextpacker--simple-v1-contract) walks this structure naively — pinned cells, then current-section prior cells, then current cell — with no ranking, no budget overflow strategy, no summary trust. **No policy evaluation.** The visible structure IS the policy.

## What "scratch" actually does

A scratch cell (`kind: scratch_cell`, set via [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md)'s `set_scratch(true)`):

- Is **excluded by default** from ContextPacker output (KB-target §0.6).
- Is **visually marked** in the notebook UI so the operator can see at a glance which cells are scratch.
- Is **promotable** to another kind via an overlay commit when an idea earns its keep ("this scratch worked; promote to markdown / agent / artifact").
- Carries `bound_agent_id: null` to prevent accidental inclusion in a continuation chain (BSP-002 §13.2.2).
- Survives notebook close → reopen as ordinary cell metadata.

## Where the rule applies

- **ContextPacker (V1)** — naive structural walker; no policy DSL.
- **Cell metadata** — V1 cells carry a small fixed flag set; no `scope:` block, no `policy:` block.
- **Scope control UX** — operator changes scope by `move`, `pin`, `exclude`, `scratch`, `checkpoint`, `split`, `merge` — never by editing a config language.
- **[promote-span](../operations/promote-span.md) target kinds** — scratch is one path the operator promotes a span out of; the inverse (promote-into-scratch) is also explicit, not implicit.

## V1 vs V2+

- **V1**: scratch flag + four other flags + structural ops. That's the entire scope vocabulary.
- **V2+**: ContextPacker gains ranking policies, recency decay, budget overflow handling, summary trust, manifest diffing (KB-target §22.2). When this lands, the policies live in the kernel as **defaults the operator can adjust globally**, not as per-cell config blocks. The Zachtronics rule still holds.

## Why

The cell is the unit of operator intentionality. If two cells with identical content differ only in their hidden config, the operator can't reason about the notebook by reading it. Scratch makes the intention visible at the surface where the operator already looks.

The Zachtronics framing (see [discipline/zachtronics](zachtronics.md)): **simple toggles beat policy languages.** Depth emerges from the interaction of many flagged tiles, not from any one tile's expressiveness.

## See also

- [discipline/zachtronics](zachtronics.md) — the parent design ethos.
- [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md) — the four flags this rule operates with.
- [cell-kinds](../concepts/cell-kinds.md) — `scratch` is one of the V1 kinds.
- [discipline/one-cell-one-role](one-cell-one-role.md) — sibling rule keeping cells single-role.
