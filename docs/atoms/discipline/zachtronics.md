# Discipline: Zachtronics — tiles not assembly; visible order

**Status**: discipline (V1 invariant + design ethos)
**Source specs**: [KB-notebook-target.md §13](../../notebook/KB-notebook-target.md#13-cell-discipline-zachtronics-not-general-asm) (cell discipline), [KB-notebook-target.md §13.5](../../notebook/KB-notebook-target.md#135-no-super-complex-configuration-in-v1) (no super-complex config in V1), [KB-notebook-target.md §17](../../notebook/KB-notebook-target.md#17-source-layer-and-performing-layer) (source/performing layers), [PLAN-atom-refactor.md §1](../../notebook/PLAN-atom-refactor.md#1-why-this-work-exists) (project ethos)
**Related atoms**: [discipline/scratch-beats-config](scratch-beats-config.md), [discipline/one-cell-one-role](one-cell-one-role.md), [discipline/save-is-git-style](save-is-git-style.md), [cell-kinds](../concepts/cell-kinds.md)

## The rule

**Visible operator-arrangeable tiles, not invisible scripts.**

The notebook is best understood by analogy to Zachtronics-style instruction tiles: small, visible, constrained units that compose through **placement, order, and simple rules** — not through hidden scripts, nested configuration languages, or clever in-cell metaprogramming.

The operator should be able to read the notebook top-to-bottom and predict its behavior. When that prediction breaks, the cure is more visibility — not more configuration.

## What this rules out

A V1 implementation that violates this discipline tends to look like one of these:

| Anti-shape | What it does | Why it's wrong |
|---|---|---|
| Cell carries a deep `scope:` config block (recency_decay, semantic_weight, branch_visibility...) | Local programmable behavior | Scope should emerge from cell order + flags. See [scratch-beats-config](scratch-beats-config.md). |
| Hidden routing language ("if test_result.failed → cell:c_44") | Implicit flow | Flow should be visible cell-by-cell. KB-target §13.2: "no hidden routing language in V1." |
| Multi-role cells ("@alpha implement, @beta review, route to gamma, mutate context") | One cell does many things | Each cell has one role. See [one-cell-one-role](one-cell-one-role.md). |
| Native-cell-mixed-with-agent-call (`%native rebind c_8; @alpha continue`) | Bypasses the cell-kind boundary | Native cells stay isolated from agent calls (KB-target §13.3). |
| Operator hand-edits `metadata.rts.cells[<id>]` to fake a structural change | Writes around the Cell Manager | All structural mutations go through overlay commits. See [cell-manager-owns-structure](cell-manager-owns-structure.md). |

## What this rules in

The visible tiles the operator does work with:

- **cell order** (default execution + reading order)
- **cell kind** ([cell-kinds](../concepts/cell-kinds.md): agent / markdown / scratch / checkpoint in V1)
- **section membership** (one [section](../concepts/section.md), explicit position)
- **split / merge boundaries** (operator-decided semantic boundaries)
- **flag toggles** (pin / exclude / scratch / checkpoint — see [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md))
- **artifact lenses** (cells point at artifacts; lenses stream mass — KB-target §16)

These compose to produce global behavior: the kernel derives scope, context, and execution from the visible structure (KB-target §13.5: "operator reorganizes cells → overlay records simple structural facts → kernel derives scope/context/execution behavior").

## Where the rule applies

- **[Cell discipline](one-cell-one-role.md)** — one cell, one role; composition through neighboring cells, not in-cell expressiveness.
- **[Scope control](scratch-beats-config.md)** — scratch beats config; visible toggles beat policy languages.
- **[Save discipline](save-is-git-style.md)** — overlay commits are visible, named, and reversible; nothing is mutated under the operator's feet.
- **[Cell Manager owns structure](cell-manager-owns-structure.md)** — the operator never edits cell metadata directly to fake structural changes; everything visible flows through the Cell Manager.

## The source-layer / performing-layer connection

KB-target §17 splits the notebook into:

- **Source layer** — cell source, directives, prompt text, files, ranges, notebook metadata (the visible tiles).
- **Performing layer** — running agents, tool calls, streams, context packs, execution status (the runtime).

> No performance without source provenance. No source without performance observability. (KB-target §17)

Zachtronics discipline is the source-layer's contract: the source layer holds visible, arrangeable, finite tiles. The performing layer reads them; the operator never has to read the performing layer to predict the source layer's effect.

## Why

Notebooks that grow expressive in the cells (configurable scopes, routing DSLs, hidden flow graphs) become unreadable at scale. Notebooks that grow expressive in the **arrangement** (more cells, clearer sections, explicit pins/excludes) stay readable.

The Zachtronics game design teaches the same lesson: depth comes from the **interaction of simple pieces under simple rules**, not from any single piece being clever.

## See also

- [discipline/scratch-beats-config](scratch-beats-config.md) — the canonical concrete application.
- [discipline/one-cell-one-role](one-cell-one-role.md) — same rule for cell content.
- [discipline/save-is-git-style](save-is-git-style.md) — same rule for save semantics.
- [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md) — same rule for who edits what.
- [cell-kinds](../concepts/cell-kinds.md) — the V1 tile vocabulary.
