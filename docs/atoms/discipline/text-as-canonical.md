# Discipline: Text as canonical

**Status**: discipline (V1 invariant; landed S5.0 commit `336a6c7` / submodule `e6620db`)
**Source specs**: [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3.5](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#35-schema-simplification--vendorllmkernelllm_kernelmetadata_writerpy-modest), [KB-notebook-target.md §13](../../notebook/KB-notebook-target.md#13-cell-discipline-zachtronics-not-general-asm), [KB-notebook-target.md §17](../../notebook/KB-notebook-target.md#17-source-layer-and-performing-layer)
**Related atoms**: [discipline/zachtronics](zachtronics.md), [concepts/cell](../concepts/cell.md), [concepts/magic](../concepts/magic.md), [operations/parse-cell](../operations/parse-cell.md), [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md)

## The rule

**Cell `text` IS the source of truth.** Everything operator-visible — kind, flags, affinity stack, agent-binding intent — lives in the text as [magic](../concepts/magic.md) lines. Runtime fields (`outputs`, `bound_agent_id`) are derived from execution, not from operator typing. The cell record at `metadata.rts.cells[<id>]` collapses to `{ text, outputs, bound_agent_id }`; every other classical field (`kind`, `pinned`, `excluded`, `scratch`, `checkpoint`, `affinity_stack`, `inherit_context_from`) is *parse-derived* by [parse-cell](../operations/parse-cell.md).

## Round-trip identity

Storage = emission = parse byte-equal:

```
storage:    cells[c_5].text = "@@spawn alpha task:\"design schema\"\n@pin\n\nbody"
emission:   serializer writes the same string verbatim
parse:      parse_cell(text) → ParsedCell(kind="spawn", args={...}, flags={"pinned"}, body="body")
re-emit:    cell_manager primitives produce text that round-trips through parse_cell
            to an equivalent ParsedCell
```

The `MetadataWriter.cell_view(cell_id)` accessor caches the parse result with text-hash invalidation — same `text` → same `ParsedCell`, byte-stable. `ParsedCell.legacy_alias_used` records whether the operator typed a legacy `/spawn` or `@<id>:` form; round-trip emission preserves the original text.

## What this rules out

| Anti-shape | Why it's wrong |
|---|---|
| Extension code calls `MetadataWriter.set_field(cells[c_5].kind, "checkpoint")` to flip kind | Kind is parse-derived; the next `cell_view` would re-derive from `text` and overwrite. Use [`set_cell_kind`](cell-manager-owns-structure.md#structural-api-text-mutation-primitives-s50) which mutates `text`. |
| Kernel writes `cells[c_5].pinned = true` straight to the writer | Same reason. Use [`insert_line_magic`](cell-manager-owns-structure.md#structural-api-text-mutation-primitives-s50) with `name="pin"`. |
| Renderer reads `cells[c_5].kind` directly | `kind` is no longer a stored field. Read via `cell_view(cell_id).kind`. |
| Schema migrations that touch the legacy fields without rebuilding `text` | Migration is one-way: pre-S5.0 → canonical text. See "Migration from pre-S5.0 cells" below. |

## What this rules in

- **Single source of truth.** The operator reads `cells[<id>].text` (visible in any JSON inspection or git diff) and predicts the cell's behavior end-to-end.
- **Diff is meaningful.** A git diff of `cells[<id>].text` shows exactly what the operator changed — including kind flips, pin toggles, and binding edits. Pre-S5.0 schema scattered these across multiple field changes; post-S5.0 they show up as line additions/removals in one slot.
- **Round-trippability across editors.** The notebook serializer writes `text` verbatim; opening the file in a foreign editor (or hand-editing the JSON) preserves operator semantics as long as the magic vocabulary is respected.
- **Inspectability.** [Inspect mode](../../notebook/KB-notebook-target.md#18-progressive-disclosure-modes) renders `text` directly with magic syntax highlighting; the operator never has to cross-reference a separate `kind` field to know what kind a cell is.

## Migration from pre-S5.0 cells

Per `vendor/LLMKernel/llm_kernel/metadata_writer.py:migrate_cells_to_canonical_text` (a one-shot routine invoked at first save after upgrade):

1. **Trigger**: a cell record carrying explicit `kind` / `pinned` / `excluded` / `scratch` / `checkpoint` / `bound_agent_id` fields without a `text` field.
2. **Rebuild**: canonical text is assembled — `@@<kind> [<id>]` declaration (or omitted for `kind=agent` with no binding) + flag line magics (`@pin`, `@exclude`) + the cell's existing body source field.
3. **Idempotency**: a cell that already carries `text` is skipped. The pre-existing fields are NOT removed (back-compat: older readers may still want them); the writer's `cell_view` accessor henceforth derives them from `text`.
4. **Marker file**: when at least one cell migrates, the writer emits `<workspace_root>/.llmnb-s5-0-cell-text-migration.json` containing `{migration: "BSP-005-S5.0-cell-text-canonical", migrated_count, cells: [...]}`. The marker logs every cell migrated with its prior `kind` / pinned / excluded state so the operator can review the diff.
5. **No retraction path**: the migration is one-way. A future schema change would land via a NEW marker file, not by reverting this one.

## The source-layer connection

[KB-target §17](../../notebook/KB-notebook-target.md#17-source-layer-and-performing-layer) splits the notebook into a **source layer** (cell text, directives, prompt, files, ranges) and a **performing layer** (agents, streams, context packs). This discipline is the source-layer's contract: the visible tile *IS* the source. The performing layer reads the parsed view; operator typing is the only path that mutates kind / flags / args.

The pin in [PLAN-S5.0.1 cell-magic injection defense](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md) is the one acknowledged exception: the HMAC pin in optional hash mode is the only operator-visible artifact that lives outside `text` (in OS keychain), justified by the prompt-injection threat model. That slice is queued, not yet shipped.

## Authoring layer vs runtime layer

Text-as-canonical names the **authoring** layer's source of truth: at edit time, in storage, and in git diffs, cell text is what the operator reads and what the kernel re-parses. It is not, however, the runtime contract surface — at the wire layer, the [driver](../concepts/driver.md) translates parsed text into Family A/B/C/F/G envelopes per [discipline/wire-as-public-api](wire-as-public-api.md). The kernel speaks only wire; the operator speaks only text.

The two disciplines compose without tension. Operator authors in text → driver parses + ships envelopes → kernel applies → kernel emits Family F snapshot → driver writes back to text. Each layer has its own canonical form; the translation between layers is explicit, lossless within the round-trip vocabulary, and locked behind the [magic](../concepts/magic.md) parser. Drift between text and wire would mean a parser bug or a driver-internals shortcut; neither is allowed.

## See also

- [discipline/zachtronics](zachtronics.md) — visible-tile parent rule.
- [concepts/cell](../concepts/cell.md) — the schema this rule collapses.
- [concepts/magic](../concepts/magic.md) — the vocabulary inside `text`.
- [operations/parse-cell](../operations/parse-cell.md) — the derivation operation.
- [discipline/cell-manager-owns-structure](cell-manager-owns-structure.md) — text-mutation primitives are the structural API.
