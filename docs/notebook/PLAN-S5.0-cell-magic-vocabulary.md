# Plan: S5.0 — Cell magic vocabulary (IPython-style `@`/`@@`)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: adopt the IPython magic model — `@line_magic` for one-line cell-flag mutations, `@@cell_magic` for cell-kind declarations — with `@@break` as the explicit cell separator. Cells and `@@<magic>` blocks are interchangeable: constructing a cell IS writing a `@@<kind>` block bounded by `@@break`s.
**Time budget**: ~2.85 days. Single cross-layer agent (kernel parser/registry + extension editor/serializer).

---

## §1. Why this work exists

The shipped V1 substrate (S1+S2+S3+S3.5+S9 + Round B kernel work) has two operator-facing directives: `/spawn <id> task:"…"` and `@<id>: <message>`. The `propose_edit` renderer + cell-toolbar interrupt round out the directive surface.

Two design pressures push toward a unified grammar:

1. **Operator vocabulary is fragmenting** — recent design discussions added `/handoff`, `/affinity`, `/endpoint`, `/branch`, `/revert`, `/stop`, plus per-cell flags `pin/exclude/scratch/checkpoint`. Each as its own ad-hoc directive form would balloon the parser surface and the operator's mental load.
2. **Cells need a typed, scriptable text representation** — the [discipline/zachtronics](../atoms/discipline/zachtronics.md) atom and [KB-notebook-target.md §13](KB-notebook-target.md#13-cell-discipline-zachtronics-not-general-asm) commit to "tiles, not assembly": every cell has a single visible role; reading the notebook top-to-bottom predicts behavior. Without a uniform tile-declaration syntax, the kind invariant from [concepts/cell-kinds](../atoms/concepts/cell-kinds.md) and the flag invariants from [pin-exclude-scratch-checkpoint](../atoms/operations/pin-exclude-scratch-checkpoint.md) live in cell metadata fields the operator can't see in the source.

S5.0 lands a single grammar that:
- Adopts IPython's `%`/`%%` mental model (familiar) with the sigil `@`/`@@` (one-keystroke ergonomic).
- Makes the cell's text the canonical source of truth: every operator-visible flag, kind, and binding lives in the text.
- Collapses the cell schema to `text + outputs + bound_agent_id` (other fields parse-derived).
- Unifies "cells" and "magic blocks" — the next `@@break` IS the next cell boundary; `@@<kind>` declares the type.

S5.0 is positioned BEFORE S5/S5.5/S6 because branch/revert/stop, sections, and cell-to-turn binding all benefit from speaking the magic vocabulary at landing time. Landing this first saves rework downstream.

---

## §2. Goals and non-goals

### Goals

- Two-tier grammar: `@magic` (line) and `@@magic` (cell), in the IPython tradition.
- `@@break` is the only cell separator. It resets cell-local config (line magics) but not notebook-level state (declared endpoints, runtime agent state).
- Each cell has at most one `@@<kind>` declaration. Multiple → K30 error.
- Cell schema collapses to `{ text, outputs, bound_agent_id }`. Kind, flags, args are parsed from `text` on access.
- Magics within a cell scope to that cell. Effects never escape via the body.
- Round-trip identity: storage = emission = parse byte-equal. No transformation.
- Legacy column-0 `/spawn` and `@<id>:` continue parsing as aliases for back-compat with shipped cells.

### Non-goals

- No partial-handoff strategies (drop-oldest, summarize) when missed-turn count exceeds budget. V2+ per [continue-turn](../atoms/operations/continue-turn.md) §"V1 vs V2+".
- No tab-based discrimination. Removed in favor of column-0 + registry-based recognition.
- No notebook-level `@@begin` / file-start markers. File start is an implicit `@@break`.
- No conditionals or control flow. Per [discipline/zachtronics](../atoms/discipline/zachtronics.md) — visible tile order is the flow.
- No multimodal magics (`@@image`, `@@pdf`, etc.). FSP-001 territory; V2+.

---

## §3. Concrete work

### §3.1 Splitter — `vendor/LLMKernel/llm_kernel/cell_text.py` (NEW, ~30 LoC)

```python
def split_at_breaks(text: str) -> list[str]:
    """Split notebook text at @@break lines. File start/end are implicit
    breaks. Empty cells (back-to-back @@break) are dropped."""
    cells, current = [], []
    for line in text.splitlines():
        if line.strip() == "@@break":
            if current: cells.append("\n".join(current))
            current = []
        else:
            current.append(line)
    if current: cells.append("\n".join(current))
    return [c for c in cells if c.strip()]
```

### §3.2 Per-cell parser — same module (~60 LoC)

```python
def parse_cell(text: str) -> ParsedCell:
    """Walk lines: first @@<kind> sets type; @<line_magic>s mutate flags;
    everything else is body. K30 on duplicate @@<kind>; K31 on unknown
    @@<name> at the kind position."""
```

Returns a `ParsedCell` dataclass:
```python
@dataclass
class ParsedCell:
    kind: str = "agent"             # "agent" | "spawn" | "markdown" | "scratch" | …
    args: dict[str, Any] = …        # parsed from the @@<kind> line's args
    flags: set[str] = …             # {"pinned", "excluded", …}
    line_magics: list[tuple] = …    # [(name, args), …] for non-flag line magics
    body: str = ""                  # joined body text, verbatim
```

### §3.3 CELL_MAGICS registry — `vendor/LLMKernel/llm_kernel/magic_registry.py` (NEW, ~150 LoC)

V1 cell-magic handlers:

| Magic | Handler effect |
|---|---|
| `@@break` | (handled by splitter, not parser) |
| `@@agent <id>` | binds cell to agent `<id>`; body is the message |
| `@@spawn <id> [endpoint:<name>] [task:"…"]` | spawns `<id>` at first run; body extends `task:` |
| `@@markdown` | markdown-kind cell; body is markdown source |
| `@@scratch` | scratch-kind cell; ContextPacker excludes |
| `@@checkpoint [covers:[…]]` | checkpoint-kind cell; body is summary text |
| `@@endpoint <name> provider:<p> model:<m> [api_key_env:<env>]` | declarative endpoint registration; writes to `metadata.rts.config.endpoints[<name>]`; body usually empty |
| `@@compare endpoints:<a>,<b>,…` | runs body across N endpoints; one output region per endpoint *(V1.5+ — register but stub)* |
| `@@section <name>` | section boundary (S5.5 work; register name only in S5.0) |
| `@@tool <name>` | V2+ reserved — round-trips, renders inert per [cell-kinds](../atoms/concepts/cell-kinds.md) |
| `@@artifact` | V2+ reserved |
| `@@native` | V2+ reserved |

Each handler signature: `def apply(cell: ParsedCell, args_str: str) -> None`. Handler mutates `cell.kind` and `cell.args`.

### §3.4 LINE_MAGICS registry — same module (~120 LoC)

V1 line-magic handlers (cell-flag mutations):

| Magic | Handler effect |
|---|---|
| `@pin` | adds `"pinned"` to `cell.flags` |
| `@unpin` | removes `"pinned"` |
| `@exclude` | adds `"excluded"` |
| `@include` | removes `"excluded"` |
| `@mark <kind>` | flips kind (only when content compatible — agent ↔ scratch, etc.); else K34 |
| `@affinity <stack>` | sets `cell.line_magics` entry; consumed by `send_user_turn` to pick endpoints |
| `@handoff <id>` | sets `cell.line_magics`; on cell run, edits NEXT cell's `bound_agent_id` + `inherit_context_from` per [decisions/v1-section-status-interruptibility](../atoms/decisions/v1-section-status-interruptibility.md) sibling design |
| `@revert <id> to <turn>` | rewinds agent's `head_turn_id`; no body needed (S5 work; register stub in S5.0) |
| `@stop <id>` | clean SIGTERM (S5 work; register stub in S5.0) |
| `@branch <src> at <turn> as <new>` | fork (S5 work; register stub in S5.0) |
| `@status` | inline kernel status (renderer chip) |

Each handler: `def apply(cell: ParsedCell, args_str: str) -> None` — same signature as cell magics.

S5/S5.5 stubs ensure the magic name is reserved (K32 if collision with agent_id) and round-trips, but actual implementation lands in those slices.

### §3.5 Schema simplification — `vendor/LLMKernel/llm_kernel/metadata_writer.py` (modest)

Per the cell-canonical-text design, `metadata.rts.cells[<id>]` collapses to:
```jsonc
{
  text: string,                  // canonical
  outputs: [...],                // runtime
  bound_agent_id: <id> | null    // runtime, derived from @@spawn
}
```

The previously-separate `kind`, `pinned`, `excluded`, `scratch`, `checkpoint` fields become **derived** (parsed from `text` on access). MetadataWriter exposes a `cell_view(cell_id) -> ParsedCell` accessor that calls `parse_cell(text)` and caches the result with text-hash invalidation.

Hydrate path: pre-S5.0 cells (with explicit `kind`, `pinned`, etc. fields and no magic in `text`) are migrated by re-emitting their text in canonical magic form (`@@<kind>` + `@<flag>`s + body). Migration runs once at first save after upgrade; flagged in marker file.

### §3.6 Extension cell-directive parser — `extension/src/notebook/cell-directive.ts` (modest)

Replace the current two-form parser (`/spawn` and `@<id>:`) with a magic dispatcher that recognizes:
- `@@<cell_magic>` at column 0 → ship `operator.action` envelope with appropriate `intent_kind`
- `@<line_magic>` at column 0 → ship `operator.action` envelope mutating cell metadata
- `@<id>:` (legacy) → ship as `agent_continue` (already shipped)
- `/spawn` (legacy) → ship as `agent_spawn` (already shipped)

Wire envelope shapes are unchanged — magics map to existing `intent_kind`s where they exist (e.g., `@@spawn` → `agent_spawn`), and to new ones for new magics (e.g., `@@endpoint` → `set_notebook_setting`).

### §3.7 Extension serializer — `extension/src/llmnb/serializer.ts` (minor)

`.llmnb` cell `source` field already stores the cell's text. With S5.0, that text contains the magic syntax. No format change to the file; just operator-typed text now uses magic forms.

### §3.8 Cell-Manager text operations — `vendor/LLMKernel/llm_kernel/cell_manager.py` (NEW, ~80 LoC)

The Cell Manager façade per [discipline/cell-manager-owns-structure](../atoms/discipline/cell-manager-owns-structure.md) gains text-mutation primitives:

- `split_at_break(cell_id, position)` — insert `@@break` at character position; produces two cells
- `merge_cells(a, b)` — concatenate `a.text + "\n" + b.text`; remove intervening `@@break` if present
- `insert_line_magic(cell_id, magic_name, args)` — prepend `@<magic> <args>` line to cell text
- `set_cell_kind(cell_id, kind, args)` — replace or insert `@@<kind>` line at top of cell text
- `remove_line_magic(cell_id, magic_name)` — remove matching `@<magic>` line(s)

All ops mutate `cells[<id>].text` and re-parse on next access. Atomic per BSP-007 overlay-commit semantics.

### §3.9 Legacy compat — same parser

Column-0 `/spawn alpha task:"X"` rewrites to `@@spawn alpha task:"X"` internally before dispatch. Column-0 `@alpha: hello` rewrites to `@@agent alpha\nhello`. Legacy forms are recognized indefinitely; new canonical is `@@<magic>`.

---

## §4. Interface contracts

### `vendor/LLMKernel/llm_kernel/cell_text.py`

```python
def split_at_breaks(text: str) -> list[str]: ...
def parse_cell(text: str) -> ParsedCell: ...
```

### `vendor/LLMKernel/llm_kernel/magic_registry.py`

```python
class CellMagicHandler:
    name: str
    def apply(self, cell: ParsedCell, args_str: str) -> None: ...

class LineMagicHandler:
    name: str
    def apply(self, cell: ParsedCell, args_str: str) -> None: ...

CELL_MAGICS: dict[str, CellMagicHandler]
LINE_MAGICS: dict[str, LineMagicHandler]
RESERVED_NAMES: frozenset[str]   # union of CELL_MAGICS keys + LINE_MAGICS keys
```

### Wire envelope (no change)

Magics dispatch through the existing `operator.action` envelope:
```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type": "agent_spawn" | "agent_continue" | "set_notebook_setting" | …,
    "intent_kind": "<spawn>" | "<send_user_turn>" | "<set_endpoint>" | …,
    "parameters": { … }
  }
}
```

### Schema delta

```jsonc
metadata.rts.cells[<id>] = {
  text: string,                  // NEW canonical
  outputs: [...],                // unchanged
  bound_agent_id: <id> | null    // unchanged
  // REMOVED: kind, pinned, excluded, scratch, checkpoint, affinity_stack
  //          (all derived from `text` via parse_cell)
}
```

### K-class additions

- **K30** `multiple_cell_kinds_per_cell` — two `@@<cell_magic>` declarations in the same cell
- **K31** `unknown_cell_magic` — `@@<unknown>` at the kind-declaration position
- **K32** `reserved_magic_name_as_agent_id` — operator tried to spawn an agent named `pin`/`agent`/etc.
- **K33** `unclosed_cell_at_file_end` — warning, not error; serializer auto-closes
- **K34** `incompatible_kind_change` — `@mark <new_kind>` on a cell whose body content is incompatible (e.g., marking a cell with agent-tool-call body as `markdown`)

---

## §5. Test surface

New test files in `vendor/LLMKernel/tests/`:

`test_cell_text_parser.py`:
1. `test_split_at_breaks_basic` — three `@@break`-separated cells round-trip
2. `test_split_at_breaks_implicit_file_start` — cell at file head with no leading `@@break`
3. `test_parse_cell_kind_declaration` — `@@agent alpha` sets `kind="agent"`, `args={"agent_id": "alpha"}`
4. `test_parse_cell_default_kind_when_no_magic` — cell starting with prose defaults to `kind="agent"`
5. `test_parse_cell_line_magics_mutate_flags` — `@pin`, `@exclude` accumulate into `flags`
6. `test_parse_cell_body_verbatim` — body content with `@something` (unknown magic) stays as body
7. `test_parse_cell_k30_on_duplicate_kinds` — two `@@<kind>` lines → K30
8. `test_parse_cell_k31_on_unknown_cell_magic` — `@@xyzzy` at top → K31
9. `test_legacy_slash_spawn_alias` — `/spawn alpha task:"X"` parses identically to `@@spawn alpha task:"X"`
10. `test_legacy_at_id_colon_alias` — `@alpha: hello` parses to agent_continue equivalent

`test_magic_registry.py`:
1. `test_cell_magics_registered` — all V1 cell magics present in `CELL_MAGICS` dict
2. `test_line_magics_registered` — same for `LINE_MAGICS`
3. `test_reserved_names_union` — `RESERVED_NAMES` is union of both registries
4. `test_k32_on_reserved_agent_id` — `@@spawn pin` rejects with K32

`test_cell_manager_text_ops.py`:
1. `test_split_at_break_inserts_marker` — `split_at_break(c_5, 42)` produces 2 cells with `@@break` between
2. `test_merge_cells_strips_intervening_break` — `merge_cells(c_1, c_2)` removes `@@break`
3. `test_insert_line_magic` — `insert_line_magic(c_3, "pin", "")` adds `@pin` at top
4. `test_set_cell_kind_replaces_existing` — `set_cell_kind(c_3, "markdown", "")` replaces existing `@@<kind>` line
5. `test_remove_line_magic_idempotent` — removing a non-existent magic is a no-op

Extension contract tests in `extension/test/contract/`:

`cell-magic-parser.test.ts`:
1. `test_at_at_spawn_ships_agent_spawn_envelope`
2. `test_at_at_agent_id_ships_agent_continue_envelope`
3. `test_at_pin_ships_set_cell_metadata_envelope_with_pinned_true`
4. `test_at_at_break_is_treated_as_separator_not_envelope`
5. `test_legacy_slash_spawn_still_works`

Targets: kernel **416 → ~436 passing** (+20). Extension contract **127 → ~132 passing + 1 pending** (+5).

---

## §6. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Schema migration breaks shipped cells | Medium | Pre-S5.0 cells with explicit metadata fields are auto-migrated to magic form on first save; marker file logs migration; operator can review diff |
| Operator confused by IPython sigil swap | Low | Documentation in atom layer; cell-editor tab-completion offers magic names; legacy `/spawn` and `@<id>:` keep working indefinitely |
| Body text containing `@@magic`-like syntax | Low | Edge case: column-0 `@@<known_magic>` IS dispatched. Operator wraps in markdown code fence, escapes with `\@@`, or indents the line by one space (column 1+ is body) |
| Two cell-magic declarations in one cell | Low | K30 hard error; lint surfaces in editor before save |
| Magic name registry growth conflicts | Low | `RESERVED_NAMES` validated at spawn time; reserved prefix `llmnb_*` for future kernel-only magics |
| `@@compare` is a stub in V1 | Low | Registered name only; handler returns "not yet implemented" K42; full handler in V1.5+ FSP |

---

## §7. Atoms touched + Atom Status fields needing update

**Created** (new atoms):
- `docs/atoms/concepts/magic.md` — the cell-text-canonical text model + `@`/`@@` two-tier grammar (NEW; this slice's primary atom)
- `docs/atoms/discipline/text-as-canonical.md` — the cell-text-is-source discipline (NEW)
- `docs/atoms/operations/parse-cell.md` — the parse-cell operation (NEW)
- `docs/atoms/operations/split-at-breaks.md` — the splitter operation (NEW)

**Updated** (Status flips):
- [concepts/cell](../atoms/concepts/cell.md) — schema collapses to `{ text, outputs, bound_agent_id }`; kind/flags become parse-derived
- [concepts/cell-kinds](../atoms/concepts/cell-kinds.md) — kind discriminator is `@@<magic>` line at top of cell
- [discipline/cell-manager-owns-structure](../atoms/discipline/cell-manager-owns-structure.md) — Cell Manager text-mutation primitives are now the structural API
- [operations/spawn-agent](../atoms/operations/spawn-agent.md) — canonical form is `@@spawn <id>`; `/spawn` is a column-0 alias
- [operations/continue-turn](../atoms/operations/continue-turn.md) — canonical form is `@@agent <id>`; `@<id>:` is a column-0 alias
- [operations/pin-exclude-scratch-checkpoint](../atoms/operations/pin-exclude-scratch-checkpoint.md) — flags toggled via `@<line_magic>` in cell text
- [protocols/operator-action](../atoms/protocols/operator-action.md) — `agent_spawn`, `agent_continue`, `set_cell_metadata` envelope shapes now sourced from magic-parser output

---

## §8. Cross-references

- [BSP-005 §S5](BSP-005-cell-roadmap.md) — branch/revert/stop become `@<line_magic>` forms after this slice
- [BSP-005 §S5.5](BSP-005-cell-roadmap.md) — sections become `@@section <name>` cell magic
- [BSP-005 §S6](BSP-005-cell-roadmap.md) — cell-to-turn binding writes to `cells[<id>].text` (canonical) instead of separate fields
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — depends on S5.0 magic-name reservation
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — depends on S5.0 cell-magic dispatcher
- [PLAN-atom-hygiene.md](PLAN-atom-hygiene.md) — Status updates for the atoms listed in §7 fold into the next hygiene pass
- [discipline/zachtronics](../atoms/discipline/zachtronics.md) — the visible-tile principle this slice operationalizes
- [KB-notebook-target.md §13](KB-notebook-target.md#13-cell-discipline-zachtronics-not-general-asm) — the design doctrine

---

## §9. Definition of done

1. `cell_text.py` ships with `split_at_breaks` and `parse_cell`; ~10 tests cover basic + edge cases.
2. `magic_registry.py` ships with both registries fully populated; reserved-names validator hooks into `AgentSupervisor.spawn` (K32).
3. `cell_manager.py` ships with text-mutation primitives; ~5 tests cover ops + idempotency.
4. `metadata_writer.py` exposes `cell_view(cell_id) -> ParsedCell` with text-hash caching.
5. Extension's `cell-directive.ts` dispatches `@@<magic>` and `@<line_magic>` envelopes; legacy `/spawn` and `@<id>:` paths preserved.
6. Schema migration runs once at first save after upgrade; marker file logs every cell migrated.
7. Kernel pytest **416 → ≥436 passing**; extension contract **127 → ≥132 + 1 pending**.
8. Drift detector clean (0 real drift; pedagogy entries unchanged or expanded).
9. All four new atom files have ≥3 outbound links; orphan check clean.
10. Status fields updated on the seven atoms listed in §7.

---

## Changelog

- **2026-04-29**: initial. Locks in the IPython-style two-tier `@`/`@@` grammar with `@@break` as cell separator. Cells and `@@<magic>` blocks are interchangeable. Cell schema collapses to `{ text, outputs, bound_agent_id }`. Legacy `/spawn` and `@<id>:` preserved. ~2.85d single-agent cross-layer slice.
