# Plan: S5.0.2 — Magic code generators (V1 built-ins)

**Status**: V1 shipped — `vendor/LLMKernel/llm_kernel/magic_generators.py` (588 LoC) carries `_handle_template`, `_handle_expand`, `_handle_import` with a `GeneratorContext` TypedDict; submodule commit `33b5c50` (S5.0.2 magic_generators module + dispatch). `magic_registry.GENERATORS` lazy-builds the dict at line 369; `cell_manager.insert_cells_with_provenance` is in submodule `8581fab`; `metadata_writer` schema (`config.magic_code_generators`, `config.templates`, cell `generated_by`/`generated_at`) in submodule `10d9046`.
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship the three V1 built-in **magic code generators** (`@@template`, `@@expand`, `@@import`) — operator-designated cell-magics whose execution emits valid magic syntax that the parser dispatches as new cells. Generators are the legitimate exception to the S5.0.1 emission ban; they preserve the visible-tile discipline by placing generated cells in the notebook with `generated_by` provenance.
**Time budget**: ~0.7-1 dispatcher-day. Single cross-layer agent (kernel handlers + cell-manager provenance + extension provenance chip), or 2-agent split (kernel + extension) on file-disjoint slices.

---

## §1. Why this work exists

After S5.0 (cell-magic vocabulary) ships and S5.0.1 (injection defense) lands the emission ban + bidirectional hash strip, the operator has a coherent text-as-canonical authoring surface but no expressive primitive for **repetitive workflows**. Three concrete pressures push for a generator vocabulary:

1. **Operator workflows repeat.** "Spawn 5 agents from a list," "expand a setup template," "import cells from another notebook" all force the operator to either type each cell by hand or hand-edit `metadata.rts` (which breaks the visible-tile discipline). Without generators, the only escape hatch is silent kernel-side macros — exactly what the [discipline/zachtronics](../atoms/discipline/zachtronics.md) atom forbids.

2. **The emission ban is over-strict without a carve-out.** S5.0.1 §3.10–3.11 forbid agent or tool output from emitting valid `@@<HMAC>:<args>` syntax. Without generators, **no** mechanism produces dispatchable magic syntax through any output path — so even legitimate operator-designated automation is impossible. Generators are the third path: operator-typed → generator handler → emitted magic → dispatched as new cells.

3. **Provenance is missing.** When the operator writes `@@spawn agent_a`, the cell is operator-typed and obviously authoritative. When a generator emits five `@@spawn` cells, those cells need a back-pointer so the operator can trace any cell to its operator-typed root. The provenance schema (`generated_by` + `generated_at`) is invariant across `.llmnb` round-trip and surfaces as a UI chip.

S5.0.2 lands the three pure-templating built-ins and the provenance machinery. V2+ adds control-flow generators (`@@for_each`, `@@if`, `@@compose`) and operator-registered custom handlers — both deliberately deferred.

### Dependencies

S5.0.2 dispatches **after** S5.0.1 (injection defense) ships. Reasons:

- Generator handlers must compute valid HMACs when hash mode is on; the operator pin store + HMAC primitive land with S5.0.1.
- The K3H error (`agent_emitted_generator_magic_blocked`) is a layered extension of S5.0.1's contamination flag.
- The "generator runs in operator privilege" trust rule depends on the pin scope established in S5.0.1.

If S5.0.1 has not shipped, dispatch this slice without hash-mode logic and queue the HMAC-emission tests for an S5.0.2.1 follow-up.

---

## §2. Goals and non-goals

### Goals

- Three V1 built-in generators: `@@template`, `@@expand`, `@@import`. Pure templating — no loops, no conditionals, no operator-defined Python.
- Generator-handler API in `magic_registry`: handlers receive parsed args + writer context, return a list of magic-text fragments (one per emitted cell). The dispatcher inserts them through Cell Manager with provenance.
- Provenance schema: `metadata.rts.cells[<id>].generated_by` (cell_id of originating generator cell) and `generated_at` (ISO8601).
- `metadata.rts.config.magic_code_generators` enumerates which magic names dispatch to a generator handler. V1 hardcodes the three built-ins.
- `metadata.rts.config.templates` stores operator-defined templates that `@@template <name>` looks up.
- Three K-class errors: K3H (agent-emitted generator magic blocked), K3I (handler produced invalid HMAC), K3J (provenance missing).
- Extension provenance chip: each cell with non-null `generated_by` displays a small chip with a click-to-jump action.
- All generators write through Cell Manager (no `print()` of magic syntax to the output stream — that path is the emission ban).
- Round-trip: `.llmnb` → load → save preserves `generated_by` + `generated_at` byte-identically.

### Non-goals (V1 — explicit)

- **No control-flow generators** (`@@for_each`, `@@if`, `@@compose` are V2+).
- **No operator-registered custom generators** (registration intent + sandboxing are V2+).
- **No generator chaining UX** — chains work (a generator that emits `@@template` cells works because those cells dispatch on next run), but no special UI for "expand all chains in one shot."
- **No template parameterization beyond simple kwarg substitution** — `@@template setup model=opus_47` substitutes into a stored string. No conditional expansion. No nesting beyond a single layer.
- **No `@@import` from non-`.llmnb` formats** in V1. `.ipynb` import lives in S5.0.3 converters.
- **No template hot-reload** — operator edits `metadata.rts.config.templates`, then re-dispatches the generator cell. No file-watch.

---

## §3. Concrete work

### §3.1 Kernel-side (~400 LoC)

| File | Edit nature |
|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/magic_generators.py` (~250 LoC) | Generator dispatch: `dispatch_generator(cell_id, magic_name, args, body, writer, cell_manager) → list[str]`. Three handler functions: `_handle_template`, `_handle_expand`, `_handle_import`. Per-handler argument validation. Emission helper `_with_optional_hmac(line, pin, name)` that computes valid HMACs in hash mode. |
| `vendor/LLMKernel/llm_kernel/magic_registry.py` (modest) | Add `GENERATORS: dict[str, GeneratorHandler]` with `template`, `expand`, `import` keys. Add `is_generator(name) → bool`. Update `RESERVED_NAMES` to include the three. |
| `vendor/LLMKernel/llm_kernel/cell_manager.py` (modest, ~50 LoC) | New method `insert_cells_with_provenance(after_cell_id, magic_texts, generated_by, generated_at) → list[cell_id]`. Inserts each text as a new cell, sets the provenance fields, appends to `metadata.rts.layout` after the generator cell. |
| `vendor/LLMKernel/llm_kernel/metadata_writer.py` (modest, ~40 LoC) | Schema changes: `config.magic_code_generators: list[str]` (default `["template", "expand", "import"]`); `config.templates: dict[str, str]`; `cells[<id>].generated_by: str | null` (default null); `cells[<id>].generated_at: str | null` (default null). Validators reject `generated_by` referencing unknown cell ids. |
| `vendor/LLMKernel/llm_kernel/cell_text.py` or `magic_registry.py` (minor) | When `parse_cell` finds a `@@<name>` whose `name in GENERATORS`, mark `parsed.is_generator = True` so the dispatcher can route differently. |
| `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` (minor) | K-class additions: K3H, K3I, K3J. JSON-Schema entries for `generated_by` / `generated_at` per RFC-005. |

### §3.2 Extension-side (~80 LoC)

| File | Edit nature |
|---|---|
| **NEW** `extension/src/renderers/components/provenance-chip.ts` (~50 LoC) | React-free DOM component: small chip showing `from @@template <name> in c_<id>`, click → `vscode.commands.executeCommand('llmnb.revealCell', generated_by)`. Rendered in the cell-output slot above the regular run output. |
| `extension/src/renderers/run-renderer.ts` (minor) | Consult `cell.metadata.generated_by`; if non-null, inject provenance chip. |
| `extension/src/notebook/serializer.ts` (minor) | Round-trip preservation: `generated_by` / `generated_at` survive the parse/serialize cycle. |
| **NEW** `extension/src/notebook/commands/reveal-cell.ts` (~30 LoC) | `llmnb.revealCell` command — given a `cell_id`, scrolls to that cell + flashes a highlight. |

### §3.3 RFC + atom updates (NEW or amend)

| Path | Edit nature |
|---|---|
| **NEW** `docs/atoms/operations/dispatch-generator.md` | Operations atom — generator-handler invocation flow, provenance write. |
| `docs/atoms/concepts/magic-code-generator.md` | Status flip: V2+ reserved → V1 shipped (commit SHA when done). |
| **NEW** `docs/rfcs/RFC-009-magic-code-generators.md` (or amend RFC-001 / RFC-005) | Locks generator-handler interface, provenance schema, K-class semantics. (Could go inline in RFC-001 if it's small enough; or stand-alone if growth expected.) |

---

## §4. Generator-handler API (locked before dispatch)

### §4.1 Handler signature

```python
# llm_kernel/magic_generators.py
GeneratorContext = TypedDict('GeneratorContext', {
    'cell_id': str,                          # the generator cell's id
    'pin': str | None,                       # operator pin (set when hash mode on)
    'workspace_root': Path,                  # for @@import file resolution
    'config_templates': dict[str, str],      # metadata.rts.config.templates
    'now_iso': str,                          # ISO8601 timestamp for generated_at
})

GeneratorHandler = Callable[[str, dict, str, GeneratorContext], list[str]]
#                            ^^^   ^^^^  ^^^  ^^^^^^^^^^^^^^^^   ^^^^^^^^^
#                            name  args  body context            output (one magic-text fragment per cell to insert)
```

Returned strings are full magic-text fragments — what would have been typed in the cell editor. The dispatcher passes them through `cell_manager.insert_cells_with_provenance(...)` which parses and inserts each as a new cell.

### §4.2 Dispatch flow (locked)

```python
def dispatch_generator(
    cell_id: str,
    magic_name: str,
    args: dict,
    body: str,
    writer: MetadataWriter,
    cell_manager: CellManager,
) -> list[str]:
    """Routes a parsed @@<generator> cell to its handler.
    Returns the list of new cell_ids inserted."""

    handler = magic_registry.GENERATORS.get(magic_name)
    if handler is None:
        raise UnknownGeneratorError(magic_name)

    ctx: GeneratorContext = {
        'cell_id': cell_id,
        'pin': writer.get_operator_pin() if writer.hash_mode_on() else None,
        'workspace_root': writer.workspace_root,
        'config_templates': writer.read_config_templates(),
        'now_iso': datetime.utcnow().isoformat() + 'Z',
    }
    fragments = handler(magic_name, args, body, ctx)

    # Validate every emitted hashed-magic line against the pin (K3I)
    if ctx['pin'] is not None:
        for fragment in fragments:
            _validate_hmacs(fragment, ctx['pin'])

    # Provenance enforcement — Cell Manager rejects insertion without it (K3J)
    return cell_manager.insert_cells_with_provenance(
        after_cell_id=cell_id,
        magic_texts=fragments,
        generated_by=cell_id,
        generated_at=ctx['now_iso'],
    )
```

### §4.3 Lint check (slice landing)

A unit test (`tests/test_generator_emission_path.py`) walks `magic_generators.py` and asserts:
- No handler calls `print(...)` with text containing `@@`.
- No handler returns from anywhere except its single `return` statement (catches accidental yields-via-stdout).
- All three handlers route their fragments through `cell_manager.insert_cells_with_provenance` (asserted by the dispatcher signature).

This formalizes the "generators write structurally, never via output stream" rule from `discipline/cell-manager-owns-structure`.

---

## §5. V1 built-in generator semantics

### §5.1 `@@template <name> [k=v ...]`

- Body: optional kwarg overrides on a single line (`model=opus_47 zone=research`).
- Effect: looks up `config.templates[<name>]`; substitutes `${k}` placeholders with the kwargs (Python `string.Template`); splits the result on `@@break`; emits each fragment as a new cell.
- Errors:
  - `name` not in `config.templates` → K30 (unknown name).
  - Placeholder unresolved → K30 with field path.
  - Resulting fragment fails `parse_cell` → K30 propagated.

### §5.2 `@@expand`

- Body: a notebook fragment (multi-line text containing `@@<kind>` cells separated by `@@break`).
- Effect: passes the body verbatim through `cell_text.split_at_breaks`; emits each fragment as a new cell.
- Errors:
  - Body is empty → K30 (`@@expand requires a non-empty body`).
  - Any fragment fails `parse_cell` → K30 with offset.

### §5.3 `@@import <file>`

- Body: none (single-line magic).
- Effect: resolves `<file>` against `workspace_root` (no escapes outside the workspace — K3K candidate, deferred to V1.5); reads as `.llmnb`; for each cell in `metadata.rts.layout`, emits its `text` as a fragment.
- Errors:
  - File missing or unreadable → K30 with the path.
  - File not a `.llmnb` (no `metadata.rts`) → K30.
  - Cycle detection: if the imported file imports the current file, K30 with the chain. (Tracked in `GeneratorContext.import_chain` if the slice grows it; otherwise V1 simply doesn't recurse into nested `@@import` cells.)

### §5.4 Hash-mode emission rule

When `pin is not None` (hash mode active), every emitted fragment that contains a magic call MUST include a valid `@@<HMAC>:<name>` prefix. Handler helper `_with_optional_hmac(line, pin, name)` computes the HMAC. The dispatcher's `_validate_hmacs` step is a safety net — a handler bug emitting an invalid hash trips K3I and the entire generator invocation is rejected (no cells inserted).

---

## §6. Provenance schema

```jsonc
metadata.rts.cells[<id>] = {
  text: <string>,
  outputs: [...],
  bound_agent_id: <string | null>,
  contaminated: <bool>,                       // from S5.0.1
  contamination_log: [...],                   // from S5.0.1
  generated_by: <cell_id> | null,             // NEW — operator-typed cell traced as the originating root
  generated_at: <ISO8601> | null              // NEW
}
```

**Provenance chain semantics** (V1):

- A directly operator-typed cell has `generated_by: null`.
- A cell emitted by a generator carries `generated_by: <generator_cell_id>`.
- If the generator cell was itself generated by another generator, the chain in V1 stores the **immediate** parent (one level). Operator can walk by repeatedly inspecting the parent.
- V1.5 may store a flat root pointer `originating_root` if walks become common. V1 keeps the schema minimal.

**Round-trip**: `magic_to_llmnb` and `llmnb_to_magic` (in S5.0.3 converters) must preserve `generated_by` / `generated_at` exactly. The magic-text representation is operator-only and does NOT include provenance — the operator never types `generated_by:`. Provenance is a kernel-applied property persisted in `metadata.rts.cells[<id>]` only.

---

## §7. K-class additions

| Code | Name | When fired | Recovery |
|---|---|---|---|
| **K3H** | `agent_emitted_generator_magic_blocked` | Agent's contaminated stdout contained a `@@template`/`@@expand`/`@@import` call (or hashed equivalent) | Layer 1 contamination flag set; Layer 2 (hash mode) escapes the leading `@`; cell flagged. No generator dispatch. |
| **K3I** | `generator_handler_produced_invalid_hash` | Generator handler returned a fragment whose `@@<HMAC>` doesn't match `HMAC(pin, name)` | Reject all fragments from this invocation (atomic). No cells inserted. Log handler bug. Returns error to operator. |
| **K3J** | `generator_provenance_missing` | Cell Manager called with `generated_by=None` from the generator dispatch path | Rejected by Cell Manager. Slice-side bug; never operator-visible in the happy path. |

---

## §8. Test surface

### §8.1 Kernel-side (`vendor/LLMKernel/tests/`)

| Test file | Coverage |
|---|---|
| `test_generator_template.py` | Happy path with kwarg substitution; missing template → K30; placeholder unresolved → K30; produced fragment with parse error → K30 |
| `test_generator_expand.py` | Happy path; empty body → K30; bad fragment → K30 |
| `test_generator_import.py` | Happy path with a fixture `.llmnb`; missing file → K30; non-`.llmnb` file → K30; cycle detection (V1: stop after one recursion level) |
| `test_generator_provenance.py` | Generated cells carry `generated_by` + `generated_at`; round-trip through `metadata_writer.serialize` preserves them; chain depth-2 (generator emits a generator cell that emits cells) preserves the immediate-parent pointer |
| `test_generator_hashmode.py` | When pin is set, emitted fragments include valid HMACs; handler returning invalid HMAC → K3I; emission ban does NOT trip on generator output (because generators write through Cell Manager, not stdout) |
| `test_generator_emission_path.py` | Lint check: no `print()` of `@@` text, all fragments routed through Cell Manager (per §4.3) |
| `test_generator_agent_emitted_blocked.py` | Agent stdout contains `@@template foo` → K3H; cell flagged contaminated; no dispatch happens |

### §8.2 Extension-side (`extension/src/__tests__/`)

| Test file | Coverage |
|---|---|
| `provenance-chip.test.ts` | Chip renders for non-null `generated_by`; click invokes `llmnb.revealCell` with the right cell id |
| `serializer-provenance.test.ts` | `generated_by` / `generated_at` round-trip through `.llmnb` serializer |
| `reveal-cell.test.ts` | Command resolves cell id → notebook position; flash highlight applied |

### §8.3 Integration

- `tests/integration/test_generator_round_trip.py` (kernel + cell_manager + metadata_writer): operator-typed `@@template setup_pipeline` cell → 3 cells inserted with provenance → `.llmnb` saved → reload → 3 cells reappear with same provenance + generator cell + correct ordering in `layout`.

### §8.4 After S5.0.3

When S5.0.3 lands, add a fixture-based integration test:
- `tests/fixtures/template-spawn.magic` — a `.magic` file using `@@template`. Run `llmnb execute --mode stub`. Verify expanded cells produce correct outputs.

---

## §9. Risks (may force RFC erratum)

1. **`config.templates` schema is operator-defined** but where does it live in the V1 substrate? Three options: (a) inline in `metadata.rts.config.templates`, (b) separate `~/.llmnb/templates/` directory, (c) per-notebook + global merge. V1 picks (a) for visible-tile compliance. Risk: large templates inflate `metadata.rts`. Mitigation: document a soft size limit (e.g., 8KB per template); larger uses `@@import` of a templates-only `.llmnb`.

2. **`@@import` cycle detection** is "stop after one level" in V1. If two `.llmnb` files import each other, V1 silently does the right thing (no infinite recursion) but doesn't error. V1.5 should track an `import_chain` in `GeneratorContext` and emit K30 with the chain on cycle.

3. **Generator emission interleaves with run state.** If the operator dispatches a generator cell while another cell is running, where do the new cells land? V1 inserts them after the generator cell regardless of run state (Cell Manager's `insert_cells_with_provenance` is structural, not run-aware). Documented as expected behavior. V2+ can add a "wait for current run" option.

4. **Provenance chip layout in extension** competes with run output for vertical space. Mitigation: render as a single-line collapsible bar above outputs; absent when `generated_by: null`. Verified against existing renderers via the test suite.

5. **HMAC validation timing** — the dispatcher validates HMACs after the handler returns but before insertion. If the handler emits 100 fragments and the 99th has a bad hash, all 100 are rejected (atomic). This is the right behavior (no half-applied generation) but slices through retry expectations. Document explicitly.

6. **Lint check coverage** (§4.3) is brittle to handler refactors. Mitigation: keep handlers in one file (`magic_generators.py`); the lint walker scopes to that file by import path. New generators added in V2+ pass through the same file.

7. **K3J should be unreachable** in the happy path (Cell Manager refuses missing provenance). It exists as a defense-in-depth assertion. Keep the test that exercises it via direct API call.

If any risk surfaces a spec ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §10. Critical files

| Path | Edit nature | Sizing |
|---|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/magic_generators.py` | Three handlers + dispatch + HMAC helper | ~250 LoC |
| `vendor/LLMKernel/llm_kernel/magic_registry.py` | `GENERATORS` dict, `is_generator()`, reserved-names update | ~40 LoC change |
| `vendor/LLMKernel/llm_kernel/cell_manager.py` | `insert_cells_with_provenance` method | ~50 LoC |
| `vendor/LLMKernel/llm_kernel/metadata_writer.py` | `config.magic_code_generators`, `config.templates`, cell `generated_by`/`generated_at` schema | ~40 LoC |
| `vendor/LLMKernel/llm_kernel/cell_text.py` | Mark `parsed.is_generator = True` for generator names | ~10 LoC |
| `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` | K3H/K3I/K3J + provenance schema | ~30 LoC |
| **NEW** `extension/src/renderers/components/provenance-chip.ts` | DOM chip component | ~50 LoC |
| `extension/src/renderers/run-renderer.ts` | Inject chip when `generated_by != null` | ~10 LoC |
| `extension/src/notebook/serializer.ts` | Round-trip preserve provenance fields | ~10 LoC |
| **NEW** `extension/src/notebook/commands/reveal-cell.ts` | `llmnb.revealCell` command | ~30 LoC |
| **NEW** `docs/atoms/operations/dispatch-generator.md` | Operations atom | ~80 LoC |
| `docs/atoms/concepts/magic-code-generator.md` | Status flip + commit pin | ~5 LoC |
| **NEW or amend** `docs/rfcs/RFC-009-magic-code-generators.md` | Or extend RFC-001 + RFC-005 | ~150 LoC |

**File-disjoint-by-design**: kernel and extension can fan out as 2 parallel agents. Kernel agent owns `magic_generators.py`, `magic_registry.py`, `cell_manager.py`, `metadata_writer.py`, kernel tests; extension agent owns provenance chip, reveal command, serializer round-trip, extension tests. The shared interface is the schema (`metadata.rts.cells[<id>].generated_by`/`generated_at`) — locked in §6 of this plan; both agents code against it.

---

## §11. Acceptance (whole slice, gate at end)

1. **Kernel pytest** under `pytest -n auto --dist=loadfile --timeout=60` — all green; new tests run in <30s.
2. **Extension `npm run test:contract`** — all green.
3. **Round-trip smoke**:
   - Create a notebook with `metadata.rts.config.templates['greet'] = "@@scratch hello\n@@break\n@@scratch world"`.
   - Operator-types `@@template greet` cell.
   - Dispatch → 2 cells inserted with `generated_by: <generator_cell_id>`.
   - Save to `.llmnb`, reload, inspect: 2 cells preserve `generated_by` + `generated_at`.
4. **Hash-mode interaction** (after S5.0.1 ships): set pin; `@@template greet` emits 2 cells with valid `@@<HMAC>:scratch` prefixes; corrupting one HMAC → K3I, no cells inserted.
5. **Agent-emitted block** (after S5.0.1 ships): agent stdout contains `@@template greet`; cell flagged contaminated; K3H fired; no generator dispatch.
6. **Provenance chip** renders for generated cells; click jumps to generator cell.
7. **Atom layer** — `concepts/magic-code-generator.md` Status flips to `V1 shipped`, with commit SHA pinned. New `operations/dispatch-generator.md` lands.
8. **Engineering Guide refinement** — any new architectural learning surfaced (e.g., a non-obvious failure mode in `insert_cells_with_provenance` ordering) lands as a guide amendment.
9. **Operator approves** — typically as a tag (`v1.5-magic-generators-shipped`) or commit message marker.

---

## §12. After this slice

S5.0.2 unlocks:

- **Operator workflows compress** — "spawn 5 agents on the same prompt with different models" goes from 5 hand-typed cells to one `@@template` invocation.
- **Cross-notebook reuse** — `@@import` a setup notebook makes shared scaffolding tractable.
- **Test fixtures expand** — S5.0.3 stub-mode notebook fixtures can use `@@template` to keep fixtures DRY.
- **V2+ control-flow** (`@@for_each`, `@@if`, `@@compose`) builds on the same handler API. Operator-registered custom generators land as a separate slice with sandboxing.
- **V3+ cross-notebook generator pipelines** — generators that produce generator cells whose output is fed to another notebook. Out of scope here.

---

## §13. See also

- [PLAN-S5.0-cell-magic-vocabulary.md](PLAN-S5.0-cell-magic-vocabulary.md) — the cell-magic substrate this builds on
- [PLAN-S5.0.1-cell-magic-injection-defense.md](PLAN-S5.0.1-cell-magic-injection-defense.md) — the emission ban this slice legitimately bypasses
- [PLAN-S5.0.3-driver-extraction-and-external-runnability.md](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — when this slice's fixtures become usable in `llmnb execute`
- [docs/atoms/concepts/magic-code-generator.md](../atoms/concepts/magic-code-generator.md) — the concept atom (Status flips to shipped on slice landing)
- [docs/atoms/discipline/cell-manager-owns-structure.md](../atoms/discipline/cell-manager-owns-structure.md) — why generators write through Cell Manager, not output stream
- [docs/atoms/discipline/zachtronics.md](../atoms/discipline/zachtronics.md) — visible-tile principle generators preserve
- [docs/atoms/discipline/sub-agent-dispatch.md](../atoms/discipline/sub-agent-dispatch.md) — dispatch methodology (kernel + extension as file-disjoint pair)
