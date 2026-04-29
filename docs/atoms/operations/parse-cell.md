# Operation: parse-cell

**Status**: V1 shipped (`vendor/LLMKernel/llm_kernel/cell_text.py:parse_cell`, S5.0 commit `336a6c7` / submodule `e6620db`)
**Source specs**: [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3.2](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#32-per-cell-parser--same-module-60-loc), [PLAN-S5.0-cell-magic-vocabulary.md §3.9](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#39-legacy-compat--same-parser) (legacy alias rewrite)
**Related atoms**: [concepts/magic](../concepts/magic.md), [concepts/cell](../concepts/cell.md), [concepts/cell-kinds](../concepts/cell-kinds.md), [operations/split-at-breaks](split-at-breaks.md), [discipline/text-as-canonical](../discipline/text-as-canonical.md)

## Definition

`parse_cell(text: str) -> ParsedCell` walks one cell's canonical `text` top-down and produces a `ParsedCell` view: `kind` (from the `@@<magic>` declaration or `"agent"` default), `args` (per-cell-magic structured fields), `flags` (set-bit accumulation from `@pin` / `@exclude` / `@mark`), `line_magics` (parametric records like `("affinity", "primary,cheap")`), and `body` (the joined verbatim non-magic content). The function is pure — no I/O, no logging, no side effects — and the writer's `cell_view(cell_id)` accessor caches its result with text-hash invalidation per [discipline/text-as-canonical](../discipline/text-as-canonical.md).

## Operation signature

```python
from llm_kernel.cell_text import parse_cell, ParsedCell, CellParseError

view: ParsedCell = parse_cell(cell_text)
# view.kind, view.args, view.flags, view.line_magics, view.body,
# view.kind_was_default, view.legacy_alias_used
```

## Inputs

A single cell's text — typically one element of `split_at_breaks(notebook_text)`. The string may be empty (returns a default `ParsedCell` with `kind="agent"`, empty body). Trailing/leading blank lines are preserved in the joined body.

## Output: `ParsedCell`

```python
@dataclass
class ParsedCell:
    kind: str = "agent"                            # one of the registered kinds
    args: dict[str, Any] = field(default_factory=dict)
    flags: set[str] = field(default_factory=set)   # {"pinned", "excluded", ...}
    line_magics: list[tuple[str, str]] = []        # [(name, args_str), ...] non-flag
    body: str = ""                                 # joined body, verbatim
    kind_was_default: bool = True                  # no @@<kind> declared
    legacy_alias_used: bool = False                # /spawn or @<id>: rewritten
```

## Walking rule (per PLAN §3.2)

1. **Legacy rewrite first.** `cell_text.rewrite_legacy_directives(text)` transforms a leading `/spawn alpha task:"X"` to `@@spawn alpha task:"X"` and a leading `@alpha: hello\n…` to `@@agent alpha\nhello\n…`. The rewrite is first-non-blank-line-only; mid-cell occurrences stay verbatim. `legacy_alias_used` is set to `True` when a rewrite fired.
2. **Top-down line walk.** Each line classified by column-0 prefix:
    - `@@<known>` at the kind position (before any body line): the FIRST one calls `CELL_MAGICS[<name>].apply(cell, args_str)` and sets `kind_was_default=False`. A SECOND `@@<known>` raises **K30**. An `@@<unknown>` at the kind position raises **K31**. After a valid kind, a column-0 `@@<unknown>` is body verbatim (operator-escape for literal `@@` text).
    - `@<known>` at column 0: `LINE_MAGICS[<name>].apply(cell, args_str)` mutates `flags` (set-bit) or, for parametric magics, the parser appends to `line_magics`. A column-0 `@<unknown>` is body (preserves emails, at-mentions).
    - Anything else: appended to body.
    - `@@break` reaching the parser is defensively a no-op (the splitter is canonical; a `@@break` at this layer means a downstream caller passed unsanitized text).
3. **Body join.** All non-magic lines join with `\n`, preserving operator whitespace and blank lines.

## Invariants

- **Pure function.** No side effects, no I/O, no dispatcher calls. Same `text` → same `ParsedCell`.
- **Defaults are deterministic.** No `@@<magic>` line → `kind="agent"`, `kind_was_default=True`. No line magics → empty `flags` and `line_magics`.
- **Errors are structured.** `CellParseError` carries `code` (`K30` / `K31` / `K34`) and `reason`. The exception message starts with the code so log lines are immediately classifiable.
- **Body verbatim.** Whitespace and blank lines in body content round-trip byte-equal modulo Windows line-ending normalization at the splitter layer.
- **Caching is the writer's job.** `parse_cell` itself does not cache; `MetadataWriter.cell_view(cell_id)` keys by `(text_hash, parsed_view)` and re-parses on text-hash mismatch.

## K-class errors

| Code | Trigger |
|---|---|
| **K30** | `multiple_cell_kinds_per_cell` — a second `@@<known>` declaration at the kind position |
| **K31** | `unknown_cell_magic` — `@@<unknown>` at the kind position (before any body line / known kind) |
| **K34** | `incompatible_kind_change` — `@mark <new_kind>` whose target is not a registered cell-kind name (V1 validates name only; full body-compat check is at the `cell_manager` layer) |

K32 (reserved magic name as agent ID) is enforced at `AgentSupervisor.spawn`, not in `parse_cell`. K35 (plain magic in hash mode) is queued for [PLAN-S5.0.1](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md).

## Callers

- [contracts/metadata-writer](../contracts/metadata-writer.md) `cell_view(cell_id)` — primary caller; caches result.
- [contracts/cell-manager](../contracts/cell-manager.md) `view(cell_id)` — facade pass-through.
- Renderers, ContextPacker, and dispatch layers — all read parsed views, never the legacy fields.

## See also

- [concepts/magic](../concepts/magic.md) — the vocabulary `parse_cell` walks.
- [concepts/cell](../concepts/cell.md) — the carrier of `text`.
- [concepts/cell-kinds](../concepts/cell-kinds.md) — the registry that `apply()` mutates `kind` from.
- [operations/split-at-breaks](split-at-breaks.md) — produces the per-cell `text` strings this consumes.
- [discipline/text-as-canonical](../discipline/text-as-canonical.md) — why this is a pure parse-derive.
