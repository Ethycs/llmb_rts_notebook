# Operation: split-at-breaks

**Status**: V1 shipped (`vendor/LLMKernel/llm_kernel/cell_text.py:split_at_breaks`, S5.0 commit `336a6c7` / submodule `e6620db`)
**Source specs**: [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3.1](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#31-splitter--vendorllmkernelllm_kernelcell_textpy-new-30-loc), [PLAN-S5.0-cell-magic-vocabulary.md §3.8](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#38-cell-manager-text-operations--vendorllmkernelllm_kernelcell_managerpy-new-80-loc)
**Related atoms**: [operations/parse-cell](parse-cell.md), [concepts/magic](../concepts/magic.md), [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md), [discipline/text-as-canonical](../discipline/text-as-canonical.md)

## Definition

`split_at_breaks(text: str) -> list[str]` partitions a notebook's full source text into per-cell text blocks, splitting at every `@@break` line. The `@@break` markers themselves are *consumed* — they never appear in any returned cell. File start and file end are implicit boundaries. Empty cells (back-to-back `@@break`s, or whitespace-only segments) are dropped.

## Operation signature

```python
from llm_kernel.cell_text import split_at_breaks

cells: list[str] = split_at_breaks(notebook_full_text)
# Each element feeds into parse_cell() to produce one ParsedCell view.
```

## Inputs

The full notebook text — typically the concatenation of every cell's canonical `text` joined by `@@break\n` separators (the inverse of this operation). The string may be empty (returns `[]`).

## Output

A `list[str]` of per-cell text blocks. Each block:

- Starts at either file-start (implicit) or the line immediately after a `@@break`.
- Ends at either file-end (implicit) or the line immediately before the next `@@break`.
- Has had its `@@break` separators stripped — they never appear inside a returned cell.
- Has been dropped if its content is whitespace-only.

The returned strings preserve operator whitespace inside each cell verbatim (newlines, blank lines, indentation).

## Boundary rules

| Boundary | Treated as |
|---|---|
| File start | Implicit `@@break` (no leading marker required) |
| File end | Implicit `@@break` (no trailing marker required) |
| Line == `@@break` (after `.strip()`) at column 0 | Cell separator; consumed |
| Whitespace-only / empty segment between two `@@break`s | Dropped |
| `@@break` indented (column > 0) | Body content, NOT a separator |

The detection is `line.strip() == "@@break"` — surrounding whitespace on the marker line is tolerated, but a leading non-whitespace character (or any indentation per line[0]) means it is body.

## Invariants

- **`@@break` never reaches `parse_cell`.** The splitter consumes every separator line; downstream parsers never see them. `parse_cell` defensively no-ops on a stray `@@break` (in case a caller bypasses the splitter), but the canonical pipeline is `split_at_breaks` → `parse_cell` per cell.
- **Empty cells are dropped.** Two consecutive `@@break`s or a whitespace-only segment do not produce an entry. This means the count of returned cells is not necessarily the count of `@@break`s plus one.
- **Pure function.** No I/O, no logging, no side effects. Same `text` → same `list[str]`.
- **Round-trip with join.** The inverse — joining cells with `\n@@break\n` (and a trailing `\n`) — round-trips through `split_at_breaks` to the same list of non-empty cells. The operation is the *inverse* of an explicit join operation in serializer code; together they form the canonical text-format for full-notebook source.

## Round-trip with join

```python
# Forward: full text → cells
cells = split_at_breaks(full_text)

# Inverse: cells → full text (canonical)
full_text = "\n@@break\n".join(cells)

# Re-split is stable on non-empty cells:
assert split_at_breaks(full_text) == [c for c in cells if c.strip()]
```

The serializer is the canonical user of the inverse direction; cell-manager primitives like [`merge_cells`](../discipline/cell-manager-owns-structure.md#structural-api-text-mutation-primitives-s50) use the same join shape internally.

## Callers

- [contracts/cell-manager](../contracts/cell-manager.md) — when materializing a notebook's cell list from its raw text source.
- Extension serializer (`extension/src/llmnb/serializer.ts`) — implicit; `.llmnb` cell `source` already stores per-cell text, so the explicit splitter is invoked only when ingesting a single-text dump (e.g., paste-import).
- Tests — `vendor/LLMKernel/tests/test_cell_text_parser.py` exercises basic + implicit-file-start cases.

## See also

- [operations/parse-cell](parse-cell.md) — consumes each per-cell text from this operation.
- [concepts/magic](../concepts/magic.md) — `@@break` is a magic-vocabulary sigil; the splitter is its sole dispatcher.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — `merge_cells` / `split_at_break` text primitives use the same `@@break` boundary rule.
- [discipline/text-as-canonical](../discipline/text-as-canonical.md) — why the splitter / join inverse is the canonical full-notebook format.
