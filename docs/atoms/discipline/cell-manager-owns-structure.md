# Discipline: Cell Manager owns structure

**Status**: discipline (V1 invariant; structural API is now the text-mutation primitives in `cell_manager.py`, S5.0 commit `336a6c7` / submodule `e6620db`)
**Source specs**: [KB-notebook-target.md §2](../../notebook/KB-notebook-target.md#2-what-we-already-have) (Cell Manager named), [KB-notebook-target.md §17](../../notebook/KB-notebook-target.md#17-source-layer-and-performing-layer) (source/performing split), [BSP-002 §13.2.3](../../notebook/BSP-002-conversation-graph.md#1323-cell-kind-merge-invariants-kb-target-221-forward-reference) (merge invariants), [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3.8](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#38-cell-manager-text-operations--vendorllmkernelllm_kernelcell_managerpy-new-80-loc), [BSP-007 §2.4](../../notebook/BSP-007-overlay-git-semantics.md#24-materialization) (Cell Manager as resolver)
**Related atoms**: [overlay-commit](../concepts/overlay-commit.md), [apply-overlay-commit](../operations/apply-overlay-commit.md), [magic](../concepts/magic.md), [text-as-canonical](text-as-canonical.md), [discipline/save-is-git-style](save-is-git-style.md), [discipline/zachtronics](zachtronics.md)

## The rule

**Every structural mutation flows through the Cell Manager.** Split, merge, move, section ops, promote, and flag toggles are recorded as [overlay commits](../concepts/overlay-commit.md) per BSP-007. The operator never edits `metadata.rts.cells[<id>]` directly to fake a structural change.

The Cell Manager is the resolver between two truths:

- The immutable turn DAG (agent truth, BSP-002 §2)
- The mutable overlay graph (operator truth, BSP-007)

It materializes the visible cell arrangement by folding `commits[]` from the overlay root to HEAD over the bare turn DAG (BSP-007 §2.4). All operator structural intent must enter at the right end of the funnel — the overlay applier — not by direct metadata writes.

## Structural API (text-mutation primitives, S5.0)

Per [PLAN-S5.0-cell-magic-vocabulary.md §3.8](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#38-cell-manager-text-operations--vendorllmkernelllm_kernelcell_managerpy-new-80-loc), the Cell Manager's structural API is now five text-mutation primitives in `vendor/LLMKernel/llm_kernel/cell_manager.py`. Each operates on `cells[<id>].text` (the canonical source per [text-as-canonical](text-as-canonical.md)) and returns the mutated text; the writer is the only sink that persists it.

| Primitive | Effect on `cells[<id>].text` |
|---|---|
| `split_at_break(cell_id, position)` | Slice the text at `position`; the left half stays in `cell_id`, the right half becomes a new cell. The `@@break` marker itself is the on-disk separator that the splitter consumes. |
| `merge_cells(a, b)` | Concatenate `a.text + "\n" + b.text`; any intervening `@@break` is dropped at the join. `b` is deleted from the cells map. |
| `insert_line_magic(cell_id, name, args)` | Prepend `@<name> [<args>]` below the leading `@@<kind>` declaration (or at the top if absent). Idempotent: a no-op if the same magic already appears. |
| `remove_line_magic(cell_id, name)` | Strip column-0 `@<name>` lines from the text. Idempotent. |
| `set_cell_kind(cell_id, kind, args)` | Replace or insert the leading `@@<kind>` declaration. Line magics that lived above body content keep their position. |

Atomicity per BSP-007: each primitive returns a complete new text string; the caller commits via the writer's single-mutation lock so concurrent edits don't tear. The flag toggles in [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md) are now thin wrappers over `insert_line_magic` / `remove_line_magic`.

## What this rules out

| Anti-pattern | Why it's wrong |
|---|---|
| Operator opens the `.llmnb` file in a text editor and edits `metadata.rts.cells[c_5].section_id = "sec_runtime"` to "move" a cell | Bypasses the dual-representation invariant (decision **D8**); `sections[<id>].cell_range[]` is now stale. The Cell Manager wouldn't render this consistently. |
| Extension code calls `MetadataWriter.set_field(cells[c_5].kind, "checkpoint")` directly | Bypasses BSP-007 §6's merge-correctness validators; produces a checkpoint cell with `bound_agent_id` still pointing at an agent. Use [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md). |
| A "tidy" routine that silently merges adjacent same-kind same-agent cells | No commit `message`; not in History mode; not reversible by [revert-overlay-commit](../operations/revert-overlay-commit.md). Use explicit [merge-cells](../operations/merge-cells.md). |
| The kernel auto-creates a section when ContextPacker exceeds budget | Sections are operator state, not derived state. Use [create-section](../operations/create-section.md). |
| A cell directive parser splits a cell behind the scenes when it sees a long `@alpha:` body | Splits are operator decisions; emit a hint, don't act. Use [split-cell](../operations/split-cell.md). |

## What this rules in

Every structural mutation MUST:

1. Be expressed as one of the typed operation kinds in BSP-007 §3 (the 17 kinds — split, merge, move, section ops, flag toggles, promote, etc.).
2. Submit through [apply-overlay-commit](../operations/apply-overlay-commit.md) inside an `apply_overlay_commit` envelope per BSP-007 §8.
3. Pass the BSP-007 §6 validators (merge correctness, split correctness, boundary rules).
4. Receive a commit_id; appear in History mode (KB-target §18); be reversible by [revert-overlay-commit](../operations/revert-overlay-commit.md).

## Why the Cell Manager exists

The Cell Manager is the **only** code path that reads BOTH the turn DAG AND the overlay graph. Without it:

- Renderers would re-implement materialization and drift apart.
- Validators would re-implement BSP-007 §6 and drift apart.
- The dual-representation invariant (`cells[].section_id` ↔ `sections[].cell_range[]`, decision **D8**) would have to be enforced everywhere instead of one place.
- Inspect mode and DAG mode (KB-target §18) wouldn't have a single materialized truth to render.

By funneling all reads through the Cell Manager and all writes through the overlay applier, the system has exactly one materializer and exactly one validator. The operator never sees inconsistent state because there's no path that produces it.

## Where the rule applies

- **[merge-cells](../operations/merge-cells.md) / [split-cell](../operations/split-cell.md)** — structural ops; explicit invariants per BSP-002 §13.2.3 + BSP-007 §6.
- **[move-cell](../operations/move-cell.md)** — section_id changes ONLY through this op; never via direct metadata write.
- **[create-section](../operations/create-section.md) / [delete-section](../operations/delete-section.md) / [rename-section](../operations/rename-section.md)** — section state is operator state through the same funnel.
- **[pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md)** — flag toggles are overlay commits; the four flags are NOT directly settable on the cell record.
- **[promote-span](../operations/promote-span.md)** — creates a new cell; only through the funnel.
- **Renderers** — read the materialized view from the Cell Manager; never go straight to `metadata.rts.cells[]`.

## V1 vs V2+

- **V1**: one Cell Manager per kernel; serial commit application; CAS via `expected_snapshot_version`.
- **V2+**: optimistic concurrent commits; Cell Manager arbitrates conflicts (BSP-003 §9 V3+ — CRDT/OT seam).

## Why

This rule is what makes [discipline/save-is-git-style](save-is-git-style.md) actually work. Git's discipline depends on **only** committing through `git commit` — if files are mutated outside git, the index lies. Same here: if cell metadata is mutated outside the Cell Manager, history mode lies, validators lie, and the operator loses the ability to reason about the notebook from the data alone.

The Cell Manager is the moat that protects the operator's mental model.

## See also

- [overlay-commit](../concepts/overlay-commit.md) — the unit the Cell Manager processes.
- [apply-overlay-commit](../operations/apply-overlay-commit.md) — the funnel.
- [discipline/save-is-git-style](save-is-git-style.md) — the design discipline this enforces.
- [discipline/zachtronics](zachtronics.md) — same source-layer ethos at the macro scale.
- [discipline/immutability-vs-mutability](immutability-vs-mutability.md) — the two truths the Cell Manager resolves.
