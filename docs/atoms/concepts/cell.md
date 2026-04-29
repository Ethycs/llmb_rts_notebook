# Cell

**Status**: V1 shipped (schema collapsed; canonical text via @/@@ magic vocabulary, S5.0 commit `336a6c7` / submodule `e6620db`; cell-as-agent-identity invariant rendered on the X-EXT side, S1 / commit `26ac581`)
**Source specs**: [BSP-002 §2.1](../../notebook/BSP-002-conversation-graph.md#21-turn) (turn schema), [BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) (binding rule), [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md) (cell-magic vocabulary), [PLAN-S5.0-cell-magic-vocabulary.md §3.5](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#35-schema-simplification--vendorllmkernelllm_kernelmetadata_writerpy-modest) (schema collapse), [KB-notebook-target.md §4](../../notebook/KB-notebook-target.md#4-what-a-cell-is) (philosophical frame), [KB-notebook-target.md §0.4](../../notebook/KB-notebook-target.md#04-cell-kinds-typed-in-v1) (typed kind)
**Related atoms**: [cell-kinds](cell-kinds.md), [magic](magic.md), [turn](turn.md), [section](section.md), [sub-turn](sub-turn.md), [discipline/text-as-canonical](../discipline/text-as-canonical.md)

## Definition

A **cell** is an operator-scoped issuance unit in the notebook overlay. It is the unit of human intentionality — a single semantic dispatch (one operator turn → optional agent response) bound to a single cell kind, optionally to a single agent, and addressable as a stable handle. The cell IS the turn-issuance site; everything else (turns, spans, tool calls, context) is reachable from it.

A cell is **not** a chat message, **not** equal to one execution event, and **not** allowed to mix system roles within itself.

## Schema

Post-S5.0, the cell record at `metadata.rts.cells[<cell_id>]` collapses to three slots; everything else is *parse-derived* from `text` via [parse-cell](../operations/parse-cell.md):

```jsonc
{
  text: string,                     // CANONICAL — operator's source; carries
                                    //   @@<kind> declaration, @<flag> line magics,
                                    //   and the body verbatim (PLAN-S5.0 §3.5)
  outputs: [...],                   // runtime — agent stream / tool result spans
  bound_agent_id: string | null     // runtime — derived from @@spawn / @@agent
}
```

**Parse-derived fields** (computed by `MetadataWriter.cell_view(cell_id)` with text-hash invalidation):

- `kind` — from the `@@<magic>` line at top of `text`; defaults to `"agent"` when absent.
- `pinned` / `excluded` / `scratch` / `checkpoint` — accumulated from `@pin` / `@exclude` / `@mark scratch` / `@mark checkpoint` line magics.
- `args` (per-cell-magic structured fields, e.g. `agent_id`, `task`) — parsed from the `@@<kind>` line's argument string.
- `affinity_stack`, `inherit_context_from` — recorded as parametric line magics in `cell.line_magics`.

The `cell_id` is still VS Code's notebook-cell URI; per-cell turn-bindings live under `metadata.rts.zone.agents.<id>.turns[]`; the cell's `cell_id` appears as a back-reference on each turn (`turn.cell_id`).

Pre-S5.0 records that carried explicit `kind` / `pinned` / `excluded` / `scratch` / `checkpoint` / `bound_agent_id` fields without a `text` slot are migrated by `metadata_writer.migrate_cells_to_canonical_text` on first save after upgrade — the canonical text is rebuilt from those fields and stored in the new `text` slot. See [discipline/text-as-canonical](../discipline/text-as-canonical.md) §"Migration from pre-S5.0 cells."

## Invariants

- **One cell, one kind.** Declared by at most one `@@<cell_magic>` line at the top of `text`; a second `@@<known>` declaration raises K30. The kind is enforced at parse time so [merge invariants](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (`same primary cell kind`) work from V1.
- **One cell, one role.** Cells do not mix agent reasoning and human prose; mixing requires split. See [discipline/one-cell-one-role](../discipline/one-cell-one-role.md).
- **One cell, one bound agent (when `kind=agent`).** Multi-agent transcripts require multiple cells. Cell-as-agent-identity ([BSP-002 §6](../../notebook/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity)) renders the badge so the operator never has to read the directive to know who ran here.
- **Cell metadata is operator state; turn records are agent state.** Editing a cell's flags, kind, or section is an [overlay commit](overlay-commit.md). Turns themselves are [immutable](turn.md).
- **A cell with no merges has no sub-turn structure.** [Sub-turns](sub-turn.md) emerge only from merge commits; addressing `cell:c_5.1` is invalid until at least one merge has happened.
- **Re-running a cell creates a NEW turn.** The cell's previous turn stays in the DAG; `cells[<id>].metadata` may rebind to the new turn but the old `cell_id → turn_id` history is recoverable from the [run-frame](run-frame.md) records.

## V1 vs V2+

- **V1**: `kind` ∈ {`agent`, `markdown`, `scratch`, `checkpoint`}. `capabilities[]` reserved as empty. Sections are flat (no `parent_section_id`; see [decisions/v1-flat-sections](../decisions/v1-flat-sections.md)).
- **V2+**: kinds `tool`, `artifact`, `control`, `native` activate. `capabilities[]` populated with permission tokens per [KB-notebook-target.md §20](../../notebook/KB-notebook-target.md#20-security-and-capabilities). Section nesting unlocks.

## See also

- [cell-kinds](cell-kinds.md) — the typed enum and per-kind constraints.
- [magic](magic.md) — the `@`/`@@` two-tier grammar that lives in `text`.
- [section](section.md) — the operator-narrative range a cell may belong to.
- [turn](turn.md) — what the cell binds to in the immutable substrate.
- [operations/parse-cell](../operations/parse-cell.md) — derives kind / flags / args from `text`.
- [operations/split-cell](../operations/split-cell.md) — how cells divide.
- [operations/merge-cells](../operations/merge-cells.md) — how cells combine.
- [discipline/text-as-canonical](../discipline/text-as-canonical.md) — `text` is the source of truth.
- [discipline/one-cell-one-role](../discipline/one-cell-one-role.md) — the rule against mixing roles.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — split/merge always go through Cell Manager.
