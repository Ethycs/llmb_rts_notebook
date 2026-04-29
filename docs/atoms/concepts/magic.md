# Magic

**Status**: V1 shipped (cell-magic vocabulary, S5.0 commit `336a6c7` / submodule `e6620db`)
**Source specs**: [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#3-concrete-work), [PLAN-S5.0-cell-magic-vocabulary.md §4](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#4-interface-contracts), [KB-notebook-target.md §13](../../notebook/KB-notebook-target.md#13-cell-discipline-zachtronics-not-general-asm) (the design doctrine this operationalizes)
**Related atoms**: [cell](cell.md), [cell-kinds](cell-kinds.md), [operations/parse-cell](../operations/parse-cell.md), [operations/split-at-breaks](../operations/split-at-breaks.md), [protocols/operator-action](../protocols/operator-action.md), [discipline/text-as-canonical](../discipline/text-as-canonical.md), [discipline/zachtronics](../discipline/zachtronics.md)

## Definition

A **magic** is a column-0 sigil-prefixed line in cell `text` that the parser dispatches to a registered handler. The vocabulary is two-tier — adopted from IPython's `%`/`%%` model with the sigil swapped to `@`/`@@` for one-keystroke ergonomics. Cell magic (`@@<name>`) declares the cell's *kind* and consumes the body; line magic (`@<name>`) mutates per-cell flags or records a parametric effect. `@@break` is the only cell separator. Magics scope to the cell they appear in; effects never escape via the body.

## Two-tier grammar

| Tier | Sigil | Position | Multiplicity | Example |
|---|---|---|---|---|
| **Cell magic** | `@@<name>` | First non-blank line at column 0 | At most one per cell | `@@spawn alpha task:"design schema"` |
| **Line magic** | `@<name>` | Any column-0 line above the body | Multiple allowed | `@pin`, `@affinity primary,cheap` |
| **Cell separator** | `@@break` | Column 0, any cell | — (consumed by [split-at-breaks](../operations/split-at-breaks.md)) | `@@break` |

A column-0 `@<name>` mid-cell (after a body line) is **body**, not a magic — the parser walks top-down and stops promoting line magics once it has emitted body content. A space-indented `@<name>` is also body. This preserves email addresses and `@user` mentions in operator prose.

## Cell-magic registry (V1)

Per `vendor/LLMKernel/llm_kernel/magic_registry.py` `CELL_MAGICS`:

| Name | Status | Effect |
|---|---|---|
| `agent` | active | Binds cell to agent `<id>`; body is the message |
| `spawn` | active | Spawns `<id>` at first run; `task:"…"` extends body |
| `markdown` | active | Markdown-kind cell; body is markdown source |
| `scratch` | active | Scratch-kind cell; ContextPacker excludes |
| `checkpoint` | active | Checkpoint-kind cell; body is summary text; `covers:[…]` |
| `endpoint` | active | Declarative endpoint registration; writes `metadata.rts.config.endpoints[<name>]` |
| `compare` | stub (V1.5+) | Runs body across N endpoints; one output region per endpoint |
| `section` | stub (S5.5) | Section boundary |
| `tool` / `artifact` / `native` | stub (V2+) | Reserved kinds; round-trip identically; renderer falls through |
| `break` | (separator) | Owned by [split-at-breaks](../operations/split-at-breaks.md); never reaches the parser as a kind |

## Line-magic registry (V1)

Per `LINE_MAGICS`:

| Name | Status | Effect |
|---|---|---|
| `pin` / `unpin` | active | Adds / removes `"pinned"` in `cell.flags` |
| `exclude` / `include` | active | Adds / removes `"excluded"` in `cell.flags` |
| `mark <kind>` | active | Flips `cell.kind` to `<kind>`; K34 if target unknown |
| `affinity <stack>` | active | Records to `cell.line_magics`; consumed by `send_user_turn` to pick endpoints |
| `handoff <id>` | active | Records to `cell.line_magics`; on cell run, edits NEXT cell's `bound_agent_id` |
| `status` | active | Inline kernel-status renderer chip |
| `revert` / `stop` / `branch` | stub (S5) | Name reserved; runtime effect deferred |

## Argument grammar

Per `magic_registry.parse_kv_args`, the arg-string after a magic name is parsed in two passes:

1. **Tokenization** — `shlex.split(args_str, posix=True)` so `task:"design recipe schema"` survives as one token. On a quoting error (unmatched quote) the parser falls back to `args_str.split()` rather than raising — handlers validate downstream.
2. **Discrimination** — each token is matched against `^[A-Za-z_]\w*:` (an identifier followed by colon). Match → `key:value` named arg; otherwise → positional in order.

Result: `(positional: tuple[str, ...], named: dict[str, str])`. Handlers decide for themselves which positional slots they expect.

Value forms in named args:

- bare token: `provider:claude-code`
- quoted string: `task:"design recipe schema"`
- comma-separated list: `endpoints:fast,slow,strict` or `covers:[c_3,c_4]` (handlers strip `[`/`]`)

## Reservation

`magic_registry.RESERVED_NAMES` is the union of `CELL_MAGICS.keys()` and `LINE_MAGICS.keys()`. `magic_registry.is_reserved_name(name)` additionally reserves the prefix `llmnb_*` for future kernel-only magics. Operator-supplied agent IDs are checked against this set by [AgentSupervisor.spawn](../contracts/agent-supervisor.md) — collision raises K32 (`reserved_magic_name_as_agent_id`).

## K-class errors

| Code | Trigger |
|---|---|
| K30 | `multiple_cell_kinds_per_cell` — two `@@<known>` declarations in one cell |
| K31 | `unknown_cell_magic` — `@@<unknown>` at the kind position |
| K32 | `reserved_magic_name_as_agent_id` — `agent_id` collides with a magic name |
| K33 | `unclosed_cell_at_file_end` — warning; serializer auto-closes |
| K34 | `incompatible_kind_change` — `@mark <new_kind>` whose target is unknown / body-incompatible |

K35 (plain magic in hash mode) is queued for [PLAN-S5.0.1](../../notebook/PLAN-S5.0.1-cell-magic-injection-defense.md); not yet shipped.

## Invariants

- **Each cell has at most one `@@<kind>`.** Two declarations → K30. The first wins for `cell.kind`; the parser raises before mutating further state.
- **Magics scope to their cell.** The `@@break` consumed by the splitter resets cell-local config; notebook-level state (declared endpoints, runtime agent state) persists.
- **Round-trip identity.** `cells[<id>].text` is the canonical source; `parse_cell` is byte-stable on the body, and `cell_manager` primitives produce text that re-parses to the same `ParsedCell`. See [discipline/text-as-canonical](../discipline/text-as-canonical.md).
- **Body verbatim.** Anything not classified as a column-0 cell magic / line magic / `@@break` is body and joins with `\n` preserving operator whitespace. A space-indented `@<name>` IS body — operators escape by indenting one space.

## See also

- [cell](cell.md) — the carrier of `text`.
- [cell-kinds](cell-kinds.md) — the typed enum the cell-magic registry produces.
- [operations/parse-cell](../operations/parse-cell.md) — the operation that walks `text` into a `ParsedCell`.
- [operations/split-at-breaks](../operations/split-at-breaks.md) — the splitter that consumes `@@break`.
- [protocols/operator-action](../protocols/operator-action.md) — wire envelopes the parser produces.
- [discipline/text-as-canonical](../discipline/text-as-canonical.md) — why `text` is the source of truth.
- [discipline/zachtronics](../discipline/zachtronics.md) — visible-tile principle this vocabulary operationalizes.
