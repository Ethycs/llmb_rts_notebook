# Plan: S5.0.5 — Cell-magic file encode/decode (`@@export` + multi-format `@@import`)

**Status**: queued — design locked, dispatch pending operator approval
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: close the encode-side gap in the cell-magic vocabulary so the operator can serialize the current notebook to disk (and import from non-`.llmnb` formats) without leaving the notebook surface. Today `@@import` reads `.llmnb` files into cells; the reverse direction lives only in the `llmnb convert` CLI. After this slice, four quadrants of the cell↔file matrix are reachable as operator-typed magic — and the **kernel speaks magic directly**, no envelope round-trip to a driver-side handler.
**Time budget**: ~0.4-0.6 dispatcher-day. Single-agent kernel slice; driver/extension touches are mechanical re-exports.

---

## §1. Why this work exists

After [PLAN-S5.0](PLAN-S5.0-cell-magic-vocabulary.md), [-S5.0.1](PLAN-S5.0.1-cell-magic-injection-defense.md), [-S5.0.2](PLAN-S5.0.2-magic-code-generators.md), and [-S5.0.3](PLAN-S5.0.3-driver-extraction-and-external-runnability.md), the operator can author, dispatch, and externally execute notebooks via cell-magic — but the **encode direction is missing from the magic vocabulary**. Three pressures push for the encode primitive:

1. **The cell↔file matrix is asymmetric.** Today:

   | Direction | In-notebook (magic) | External (`llmnb` CLI) |
   |---|---|---|
   | `.llmnb` → cells (decode, native) | `@@import <file>` (S5.0.2) | `llmnb convert` |
   | `.ipynb` / `.magic` → cells (decode, foreign) | — | `llmnb convert` |
   | cells → `.llmnb` (encode, native) | implicit on host save — not operator-triggerable | `llmnb convert` |
   | cells → `.ipynb` / `.magic` (encode, foreign) | — | `llmnb convert` |

   Three of four quadrants force the operator out to the shell. Even encoding to the native format isn't reachable as an explicit gesture; it only fires as a side effect of the VS Code save lifecycle.

2. **Non-extension drivers lose discoverability.** The Tier-2 `llmnb execute --connect` flag (commit `df95ad4`) is designed so non-VS-Code drivers (nvim plugin, headless CI, Rust orchestrator) can drive the kernel. Those drivers don't have a "save notebook" UI — the operator's only handle on serialization is shell-out to `llmnb convert`. A magic-driven encode keeps the operator in the notebook surface across all drivers uniformly.

3. **Kernel-speaks-magic collapses state.** The natural design impulse is to route `@@export` through an `operator.action` envelope to the driver (parallel to `@@spawn`); the driver writes the file. But that introduces a multi-step async dance — ship envelope out, wait for response, correlate by `request_id`, attribute outcome to originating cell — and every driver (extension, CLI, future nvim) needs its own duplicate handler. The kernel already has the cell text, the format converters, the path-validation primitives from `@@import`. Doing the I/O in-kernel collapses three state machines (kernel emit → driver receive → driver respond → kernel attribute) into one (kernel emit → kernel attribute), and there's exactly one implementation regardless of driver. Same architectural shape as `@@import` already has.

S5.0.4 lands `@@export` (encode), extends `@@import` to accept foreign formats, and promotes the format converters from `llm_client/notebook.py` into a public kernel module (`llm_kernel.notebook_format`) so kernel-side magic handlers and driver-side CLI both consume the canonical implementation.

### Dependencies

S5.0.4 dispatches **after** S5.0.2 (magic code generators) and S5.0.3 (driver extraction). Reasons:

- S5.0.2 establishes the `@@import` magic shape (positional path + named kwargs) and the magic-handler dispatch pattern this slice reuses.
- S5.0.3 already lands the format converters (`llmnb_to_magic`, `magic_to_llmnb`, `ipynb_to_llmnb`, `llmnb_to_ipynb`) in [`llm_client/notebook.py`](../../llm_client/notebook.py). This slice promotes them into the kernel; nothing new to write — just a move + a re-export shim.
- The Tier-2 `--connect` flag (post-S5.0.3) is what makes magic-driven encode useful for non-extension drivers.

---

## §2. Goals and non-goals

### Goals

- New cell-magic `@@export path:"…" [format:"llmnb"|"magic"|"ipynb"] [overwrite:bool]` registered in [`magic_registry.CELL_MAGICS`](../../vendor/LLMKernel/llm_kernel/magic_registry.py).
- **Kernel-side handler writes the file directly.** No envelope round-trip. The handler is a synchronous function called from the existing magic-dispatch loop, parallel to how `@@import` reads files in-kernel today.
- Extension of `@@import` to accept `.ipynb` / `.magic` (currently `.llmnb`-only). Same kernel-side path; format dispatched by extension or explicit `format:` kwarg.
- Format converters promoted from `llm_client/notebook.py` to a new public kernel module `llm_kernel.notebook_format`. Driver-side keeps a backward-compat re-export shim. Lint boundary updated to allow `llm_kernel.notebook_format` (joins `wire`, `cell_text`).
- Path validation: target/source must resolve inside the workspace root, after `..` normalization and symlink resolution. Path-traversal attempts → K3M.
- Overwrite semantics: `@@export path:"x.llmnb"` with `x.llmnb` already present → K3N unless `overwrite:true` is set.
- Format inference: `format` is inferred from the file extension when omitted (`.llmnb` → llmnb, `.magic`/`.txt` → magic, `.ipynb` → ipynb). Explicit `format:` overrides.
- Cell outputs: success → single-line `"exported <N> cells to <path>"` (or `"imported <N> cells from <path>"`). Failure → K-class error envelope in the cell's output slot.
- Three new K-class errors: K3M (path outside workspace), K3N (overwrite refused), K3O (I/O / format / encoding failure).
- Round-trip invariant: a notebook serialized via `@@export path:"x.llmnb"` and re-imported via `@@import x.llmnb` produces byte-identical `cells[<id>].text` for every cell.

### Non-goals (V1 — explicit)

- **No envelope-based routing.** Operator-action envelopes are for cross-process effects the kernel can't fulfill alone (spawn an agent process, send approval response back to a queued tool call). File I/O is in-kernel work that should not require a driver round-trip.
- **No cell subsetting**: `@@export` writes the entire notebook. Per-cell or tag-scoped export (`cells:tag1,tag2`) is V2+.
- **No `@@export` to absolute paths outside the workspace** — security boundary. V2+ may add an explicit `--unsafe` flag.
- **No file watching** — `@@export` fires only when the cell is run, not on changes. No background sync.
- **No auto-rerun on `@@import` source change** — same reason.
- **No cross-notebook overlay merging** — `@@import` of an `.llmnb` whose cell ids collide with current notebook ids gets new ids (existing S5.0.2 behavior); merging semantics with conflict resolution is V2+.
- **No streaming export** — full-file write; in-memory serialization. Large notebooks (>10MB) are deferred until a benchmark shows pain.
- **No VFS-aware writes from the kernel.** If the operator's workspace is mounted over a VS Code virtual filesystem (SSH remote, dev container with non-local mount), kernel-side `pathlib` writes still land where the kernel's process sees them. This is the same constraint `@@import` operates under today. Document; V2+ may add a `vfs_passthrough` flag if a real pain case surfaces.
- **No `@@export` of just a cell's outputs** — outputs are dropped on `.magic` export (existing converter semantics); `.llmnb` and `.ipynb` preserve them. V1 documents this; no per-format flag.

---

## §3. Concrete work

### §3.1 Kernel-side (~200 LoC)

| File | Edit nature |
|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/notebook_format.py` (~250 LoC, mostly moved) | The format converters, **promoted from `llm_client/notebook.py`**. `detect_format`, `llmnb_to_magic`, `magic_to_llmnb`, `llmnb_to_ipynb`, `ipynb_to_llmnb`, `_layout_walk_ids`. Public API; documented in module docstring. |
| **NEW** `vendor/LLMKernel/llm_kernel/file_actions.py` (~120 LoC) | Two handlers: `apply_export(cell_id, path, format, overwrite, notebook_state, workspace_root) → ExportOutcome` and `apply_import(cell_id, path, format, workspace_root) → ImportOutcome | error`. Path validation (K3M), overwrite check (K3N), atomic write via `<path>.tmp + os.replace`, format dispatch through `notebook_format.py`. On import success, returns the parsed cell list which the dispatcher hands to `cell_manager.insert_cells_with_provenance`. |
| `vendor/LLMKernel/llm_kernel/magic_registry.py` (modest, ~40 LoC) | Add `"export"` handler entry to `CELL_MAGICS`. Update `_handle_import` (currently in `magic_generators.py`) to dispatch through `file_actions.apply_import` for foreign formats; the native `.llmnb` path still resolves through the existing generator code (zero regression risk). Update `RESERVED_NAMES`. |
| `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` (minor, ~20 LoC) | K-class additions: K3M (`export_target_outside_workspace`), K3N (`export_target_exists_no_overwrite`), K3O (`notebook_io_failed`). K3O carries a `cause` sub-code (`permission_denied`, `disk_full`, `unsupported_format`, `parse_failed`, `encoding_error`). |

### §3.2 Driver-side (~30 LoC; mostly subtraction)

| File | Edit nature |
|---|---|
| `llm_client/notebook.py` (rewrite as shim, ~20 LoC) | Becomes a thin re-export of `llm_kernel.notebook_format`. Every function gets `from llm_kernel.notebook_format import <name> as <name>`. Module docstring notes the move; consumers ([`llm_client/cli/convert.py`](../../llm_client/cli/convert.py), [`llm_client/executor.py`](../../llm_client/executor.py)) keep their imports working unchanged. Deletion of the shim is V2+ once internal callers are migrated. |
| `tests/test_lint_boundary.py` (minor, ~3 LoC) | Add `notebook_format` to `_ALLOWED_KERNEL_PUBLIC` (alongside `wire`, `cell_text`). The shim path keeps existing callers happy; the new allow-list entry covers callers who choose to skip the shim. |

No `llm_client/handlers/notebook_io.py`. No `llm_client/driver.py` envelope dispatch additions. No extension-side handler. The driver does nothing special for `@@export` / extended `@@import` — they fire kernel-side and the cell's output slot picks up the result the same way it picks up the result of any other magic dispatch.

### §3.3 Extension-side (~10 LoC; cosmetic only)

| File | Edit nature |
|---|---|
| `extension/src/notebook/cell-directive.ts` (minor, ~10 LoC) | Recognize `@@export` and (extended) `@@import` so the cell-decoration badge shows "exports to <path>" / "imports from <path>". Pure UI affordance; no envelope routing changes — these magics are parsed in-kernel and the cell decoration is just a hint from the operator-typed text. |

No new commands, no new renderers — K-class error cards already render generically.

### §3.4 Doc + atom updates

| Path | Edit nature |
|---|---|
| [`docs/atoms/concepts/magic.md`](../atoms/concepts/magic.md) — registry table | Add `export` row (active) + note `import` extended to multi-format. |
| **NEW** `docs/atoms/operations/export-notebook.md` | Operations atom — kernel-side flow, path validation, K3M/N/O, lossy-format warning. |
| **NEW** `docs/atoms/operations/import-foreign-format.md` (or extend `dispatch-generator.md`) | Operations atom — multi-format import dispatch. |
| [`docs/atoms/concepts/magic-code-generator.md`](../atoms/concepts/magic-code-generator.md) | Note: `@@export` is NOT a generator (does not emit cells); it is a side-effect emitter handled directly in-kernel. Cross-link. Note: foreign-format `@@import` is still a generator (emits cells via Cell Manager). |
| [`docs/atoms/discipline/wire-as-public-api.md`](../atoms/discipline/wire-as-public-api.md) | Note the kernel's public surface expanded from `wire` + `cell_text` to also include `notebook_format`. |

**No `docs/atoms/protocols/operator-action.md` changes.** No new `action_type` values. No RFC-006 minor bump. The envelope catalogue is untouched. This is the single biggest payoff of doing it kernel-side.

---

## §4. Cell-magic handler shapes (locked)

### §4.1 `apply_export` signature

```python
# llm_kernel/file_actions.py
@dataclass
class ExportOutcome:
    status: Literal["ok", "error"]
    path: Optional[Path]                  # resolved absolute path on success
    format: Optional[str]
    cells_written: int = 0
    warnings: list[str] = field(default_factory=list)
    k_code: Optional[str] = None
    message: Optional[str] = None
    cause: Optional[str] = None           # K3O sub-code

def apply_export(
    cell_id: str,
    path: str,                            # operator-typed, relative
    format: Optional[str],                # explicit or None (infer from extension)
    overwrite: bool,
    notebook_state: dict,                 # metadata.rts snapshot at run time
    workspace_root: Path,
) -> ExportOutcome:
    """Validate + atomic write. Pure-ish: filesystem + workspace_root only."""
```

### §4.2 `apply_import` signature

```python
@dataclass
class ImportOutcome:
    status: Literal["ok", "error"]
    cell_texts: list[str] = field(default_factory=list)   # one per imported cell
    cells_read: int = 0
    warnings: list[str] = field(default_factory=list)
    k_code: Optional[str] = None
    message: Optional[str] = None
    cause: Optional[str] = None

def apply_import(
    cell_id: str,
    path: str,
    format: Optional[str],
    workspace_root: Path,
) -> ImportOutcome:
    """Read + parse. Returns cell_texts that the dispatcher hands to
    cell_manager.insert_cells_with_provenance(generated_by=cell_id)."""
```

### §4.3 Dispatch wiring

In `magic_registry.py`, the `@@export` and (foreign-format branch of) `@@import` handlers are called from the existing magic-dispatch loop with the parsed `(args, body, cell_id)` triple — exactly the same shape as today's `_handle_template` / `_handle_expand` / `_handle_import`. The dispatcher converts the `Outcome` into a `run.complete` envelope it already produces for any cell run. No new wire shapes; no new event types.

---

## §5. Cell-magic semantics

### §5.1 `@@export <args>`

- **Parsed args**: positional ignored; named args `path:"…"` (required), `format:"…"` (optional; defaults from extension), `overwrite:true|false` (optional; default false).
- **Body**: ignored. Operator may type notes; not part of the dispatched call.
- **Effect**: kernel-side `apply_export` runs synchronously. On success, the cell's `run.complete` carries `outputs: [{type: "text", text: "exported <N> cells to <relative-path>"}]` plus any format-specific warnings (e.g. "outputs dropped (magic format)"). On failure, `status: "error"` + `k_code` + `message` + `cause`.
- **Errors**:
  - `path:` missing → K30 at parse time.
  - `path:` escapes workspace (post-resolve) → K3M.
  - `path` exists + `overwrite:false` → K3N.
  - Unsupported `format:` → K30 at parse time.
  - Write failure → K3O with `cause`.

### §5.2 `@@import <file> [format:"…"]`

- **Parsed args**: positional `<file>` (required), named `format:"…"` (optional; inferred from extension).
- **Body**: ignored.
- **Effect**:
  - If detected format is `llmnb` → existing generator path (no change from S5.0.2).
  - Otherwise (`magic`, `ipynb`) → `apply_import` runs synchronously, returns the cell-text list, dispatcher inserts via `cell_manager.insert_cells_with_provenance(after_cell_id=cell_id, magic_texts=..., generated_by=cell_id, generated_at=now)`. Same provenance contract as native `@@import`.
- **Errors**:
  - File missing → K30 (parity with S5.0.2 native path).
  - Unsupported `format:` → K30 at parse time.
  - Parse failure → K3O with `cause: "parse_failed"` and an offset.
  - Cell-id collisions are not possible — `insert_cells_with_provenance` mints fresh ids.

### §5.3 Magic-emitter classification

Per [`docs/atoms/discipline/certified-magic-emitter.md`](../atoms/discipline/certified-magic-emitter.md):

- `@@export` is NOT a certified magic emitter (it does not write `cells[<id>].text`; it writes a file on disk). The five-clause certification doesn't apply.
- Foreign-format `@@import` IS a certified magic emitter — it reads a file, parses to magic-text fragments, inserts via Cell Manager (clause 2), with provenance (clause 4). Same contract as native `@@import` / `@@template` / `@@expand`.

No update needed to the emission-ban discipline. Existing five clauses cover the import path; the export path is exempt.

---

## §6. Schema additions

No changes to `metadata.rts`. Both magics are stateless from the notebook's perspective:

- `@@export` produces no `metadata.rts` changes (the file on disk is the artifact).
- `@@import` produces new cells through the existing `insert_cells_with_provenance` path which already carries `generated_by` / `generated_at`.

The `metadata.rts.config.magic_code_generators` list is updated:

- `export` is NOT added (it's not a generator).
- `import` already there — no schema change.

Cosmetic: the new `notebook_format` module is added to `llm_kernel.__all__` if such a re-export exists; otherwise consumers import directly from `llm_kernel.notebook_format`.

---

## §7. K-class additions

| Code | Name | When fired | Recovery |
|---|---|---|---|
| **K3M** | `export_target_outside_workspace` | `path:"…"` resolves outside `workspace_root` (after `..` normalization + `path.resolve()`, including absolute paths and symlink escapes) | Cell fails fast with operator-visible error. No file written. |
| **K3N** | `export_target_exists_no_overwrite` | `path` resolves to an existing file and `overwrite:false` (default) | Error envelope; no file modified. Operator re-runs cell with `overwrite:true` or a different path. |
| **K3O** | `notebook_io_failed` | I/O or format error: `permission_denied`, `disk_full`, `unsupported_format`, `parse_failed`, `encoding_error`. The `cause` sub-code disambiguates. | Operator-visible error envelope with `cause`. No partial files (atomic via `<path>.tmp + os.replace`). |

All three are kernel-side. All three surface through the existing `run.complete` envelope — no new wire shapes. The cell's output slot renders them as standard K-class error cards via the existing renderer.

---

## §8. Test surface

### §8.1 Kernel-side (`vendor/LLMKernel/tests/`)

| Test file | Coverage |
|---|---|
| `test_apply_export_happy.py` | Each format: write to a tmp path, assert file exists with expected content (byte-identical round-trip for `.llmnb`; structural match for `.magic` / `.ipynb`). Format inference from extension. Explicit `format:` override. |
| `test_apply_export_path_validation.py` | K3M cases: `path:"../escape.llmnb"`, absolute paths outside workspace, symlink escape (via fixture). Each fails before write, no file produced outside workspace. |
| `test_apply_export_overwrite.py` | K3N when target exists + `overwrite:false`; success when `overwrite:true`; atomic write (interrupt before rename → no destination file modified). |
| `test_apply_export_lossy_warning.py` | `.magic` export warns about dropped outputs; `.ipynb` export warns about dropped provenance. Warnings land in `outcome.warnings` and are rendered in cell output. |
| `test_apply_import_foreign.py` | `.ipynb` import: cells parse, text fields match fixture. `.magic` import: cells split at `@@break`, text fields match. Malformed fixture → K3O with offset. |
| `test_import_dispatch_routing.py` | Native `.llmnb` routes to existing generator path (no `apply_import` call). `.ipynb` / `.magic` routes to `apply_import`. Verify no regression on S5.0.2 acceptance suite. |
| `test_export_round_trip.py` | Integration: a notebook with N cells → `@@export path:"x.llmnb"` → `@@import x.llmnb` in same kernel → resulting cells' text equals original byte-for-byte. |
| `test_notebook_format_module.py` | The promoted module (`llm_kernel.notebook_format`) exposes the same API as the original `llm_client/notebook.py` (every public name still callable, same signatures). Smoke check for the move. |

### §8.2 Driver-side (`tests/`)

| Test file | Coverage |
|---|---|
| `test_notebook_shim_compat.py` | `from llm_client.notebook import detect_format, llmnb_to_magic, …` still works (re-export shim intact). All consumer callsites ([`cli/convert.py`](../../llm_client/cli/convert.py), [`executor.py`](../../llm_client/executor.py)) still pass their existing tests. |
| `test_cli_execute_export.py` | `llmnb execute fixture-with-export.magic --mode live` runs the kernel-side export; file lands in tmp dir; CLI exit code 0. Mirrors existing pattern; passes both with and without `--connect`. |
| `tests/test_lint_boundary.py` (existing) | Verifies `notebook_format` is in the allow-list; `llm_client/` files that import it pass the lint check. |

### §8.3 Extension-side (`extension/src/__tests__/`)

| Test file | Coverage |
|---|---|
| `export-cell-decoration.test.ts` | Cell badge renders "exports to <path>" when text starts with `@@export path:"…"`; updates on path change. |

### §8.4 Acceptance fixture (S5.0.3-style)

`tests/fixtures/export-and-reimport.magic`:

```
@@scratch
say hello
@@break
@@export path:"tmp/round-trip.llmnb"
@@break
@@import tmp/round-trip.llmnb
```

Run via `llmnb execute fixture.magic --mode live` (or against a `--connect`-attached kernel). Assert: 3 cells executed; file written; third cell's import produces a new cell whose text equals the first cell's text byte-for-byte.

---

## §9. Risks (may force RFC erratum)

1. **Symlink escape in K3M** — `Path.resolve()` follows symlinks; a workspace containing a symlink to `/etc/passwd` would let an operator typing `@@export path:"my-symlink"` write outside the workspace. Mitigation: resolve target, then assert `is_relative_to(workspace_root)`. Regression test with a fixture symlink. Document explicitly. Same hazard for read side already exists in `@@import` and gets the same treatment.

2. **Atomic write semantics** — partial writes on crash leave half-written files. Mitigation: write to `<path>.tmp` then `os.replace` to final name. The existing `MetadataWriter.save` uses this pattern; reuse the helper directly.

3. **VFS workspaces** — VS Code workspaces mounted over a virtual filesystem (SSH remote, dev containers, GitHub Codespaces virtual workspace) may not present the same filesystem view to the kernel process as to the extension UI. Kernel-side `pathlib` writes go where the kernel sees, not where the operator sees. The S5.0.2 `@@import` already has this constraint and operators have lived with it. Document in `operations/export-notebook.md` and in the magic registry comment. V2+ may add a VFS-passthrough flag if operators report concrete pain.

4. **Outputs lost on `.magic` export** — operator confusion when they `@@export path:"x.magic"` then `@@import x.magic` and find their outputs gone. Mitigation: the warning in the export cell's output is the documentation. V2+ may add `outputs:"keep"` flag for `.llmnb` only.

5. **`@@import` cell-id collision** with foreign formats — `.ipynb` and `.magic` don't carry cell ids; `insert_cells_with_provenance` mints fresh ones. Already-solved. Document in the operations atom so operators understand chain.

6. **Module-move blast radius** — promoting `notebook_format` from driver to kernel touches every consumer ([`cli/convert.py`](../../llm_client/cli/convert.py), [`executor.py`](../../llm_client/executor.py), and tests). Mitigation: the shim in `llm_client/notebook.py` keeps the old import path working, so the slice ships in one commit without a multi-step deprecation. Deletion of the shim is V2+.

7. **K3O bundles too many failure modes** — disk full, permission denied, unsupported format, malformed input, encoding error. The `cause` sub-code disambiguates without inflating the K-class registry. If operators commonly want per-cause recoveries, V1.5 can split K3O into K3O/K3P/K3Q/K3R.

8. **Provenance after foreign-format import** — every cell imported via `@@import x.ipynb` carries `generated_by: <import_cell_id>` (existing S5.0.2 behavior). Operator can trace back to the import cell. Document in `operations/import-foreign-format.md`.

If any risk surfaces a spec ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §10. Critical files

| Path | Edit nature | Sizing |
|---|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/notebook_format.py` | Promoted from `llm_client/notebook.py` — `detect_format`, `llmnb_to_magic`, `magic_to_llmnb`, `llmnb_to_ipynb`, `ipynb_to_llmnb`, `_layout_walk_ids` | ~250 LoC (mostly moved) |
| **NEW** `vendor/LLMKernel/llm_kernel/file_actions.py` | `apply_export`, `apply_import`; path validation; atomic write; format dispatch | ~120 LoC |
| `vendor/LLMKernel/llm_kernel/magic_registry.py` | `CELL_MAGICS` entry for `export`; dispatch wiring to `file_actions` for foreign-format import | ~40 LoC |
| `vendor/LLMKernel/llm_kernel/_rfc_schemas.py` | K3M/K3N/K3O additions | ~20 LoC |
| `llm_client/notebook.py` | Rewrite as thin re-export shim | ~20 LoC (mostly deletion) |
| `tests/test_lint_boundary.py` | Add `notebook_format` to `_ALLOWED_KERNEL_PUBLIC` | ~3 LoC |
| `extension/src/notebook/cell-directive.ts` | Cosmetic: recognize `@@export` for cell-decoration badge | ~10 LoC |
| **NEW** `docs/atoms/operations/export-notebook.md` | Operations atom | ~80 LoC |
| **NEW** `docs/atoms/operations/import-foreign-format.md` | Operations atom | ~50 LoC |
| `docs/atoms/concepts/magic.md` | Registry table addition for `export`; note about multi-format import | ~10 LoC |
| `docs/atoms/concepts/magic-code-generator.md` | Cross-reference note distinguishing `@@export` (side-effect) from generators (cell-emitting) | ~5 LoC |
| `docs/atoms/discipline/wire-as-public-api.md` | Note `notebook_format` joins `wire` and `cell_text` as public kernel surface | ~5 LoC |

**No RFC-006 changes.** No operator-action atom update. No driver-side handler. No new envelope shapes. The slice is structurally a kernel extension plus a module promotion; the driver and extension barely move.

**Single-agent dispatch.** Kernel and tiny driver/extension touches fit comfortably in one dispatcher with no fan-out coordination needed.

---

## §11. Acceptance (whole slice, gate at end)

1. **Kernel pytest** under `pytest -n auto --dist=loadfile --timeout=60` — all green; new tests run in <10s.
2. **Driver pytest** (`pixi run driver-test`) — 109 baseline + new tests, all green. Shim compat test passes.
3. **Extension `npm run test:contract`** — all green. Cosmetic cell-decoration test passes.
4. **Round-trip smoke (the acceptance fixture from §8.4)** — `@@export` followed by `@@import` reproduces cell text byte-for-byte.
5. **Path-validation smoke** — `@@export path:"../escape.llmnb"` fails with K3M, no file written outside workspace. Symlink-escape regression covered.
6. **Lossy-format warning** — `@@export path:"x.magic"` cell output contains the "outputs dropped" warning.
7. **Multi-format import** — `@@import sample.ipynb` succeeds; cell text comes from the ipynb source. `@@import sample.magic` succeeds; cell text round-trips.
8. **CLI parity** — `llmnb execute fixture.magic --mode live` containing `@@export` writes the file. Same fixture with `--connect tcp://…` against a `llmnb serve` kernel also passes — proves the kernel-side path works regardless of driver.
9. **Lint boundary** — `notebook_format` in `_ALLOWED_KERNEL_PUBLIC`; existing consumer imports unchanged via shim. [`tests/test_lint_boundary.py`](../../tests/test_lint_boundary.py) green.
10. **Atom layer** — [`magic.md`](../atoms/concepts/magic.md) registry table updated; new `operations/export-notebook.md` + `operations/import-foreign-format.md` land. [`wire-as-public-api.md`](../atoms/discipline/wire-as-public-api.md) reflects the expanded public surface.
11. **No operator-action / RFC-006 churn** — verify the atom + RFC remain byte-identical. (Negative acceptance criterion — confirms the design held.)
12. **Operator approves** — commit-message marker `feat(s5): magic-driven file encode/decode (PLAN-S5.0.5)`.

---

## §12. After this slice

S5.0.4 unlocks:

- **Operate entirely from inside the notebook** — encode/decode no longer require leaving for the shell. Nvim / Rust / browser drivers all gain the gesture uniformly via the kernel, not via per-driver handlers.
- **Reproducible test fixtures** — `@@export` of a known-good state can be checked into the repo; `@@import` reconstitutes. Tests-as-notebooks discipline ([PLAN-S5.0.3 §6.2](PLAN-S5.0.3-driver-extraction-and-external-runnability.md)) gets a primitive for "snapshot now."
- **Foreign-format pipelines** — `.ipynb` import lets `llmnb` consume Jupyter notebooks directly; `.ipynb` export lets it produce them. The kernel becomes a notebook-format translator.
- **`notebook_format` as kernel-public** — joins `wire` and `cell_text` on the public surface. Any future driver (Rust orchestrator, Go CI tool) can consume the format converters from the kernel package directly, no re-implementation.
- **V2+ scope** that this primitive enables: per-cell `@@export cells:c_3-c_5`, `@@diff target:"<file>"` (compute and render a diff against a saved version), `@@watch path:"<file>"` (auto-reimport on change), `@@export --staged` (notebook git workflows), VFS-aware writes for remote workspaces.

---

## §13. See also

- [PLAN-S5.0-cell-magic-vocabulary.md](PLAN-S5.0-cell-magic-vocabulary.md) — the cell-magic substrate this builds on
- [PLAN-S5.0.2-magic-code-generators.md](PLAN-S5.0.2-magic-code-generators.md) — the prior magic-emitter slice; `@@export` is the side-effect-emitter complement and `@@import` foreign-format extends its dispatch
- [PLAN-S5.0.3-driver-extraction-and-external-runnability.md](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — where the format converters lived before promotion; the `llm_client/notebook.py` shim preserves that path
- [PLAN-S5.0.4-privileged-magic-emission.md](PLAN-S5.0.4-privileged-magic-emission.md) — independent slice on the same magic-emission discipline axis; defines `emit_magic_cell` MCP tool + privilege grants. Different mechanism (agent-invoked, MCP-routed) from this slice's operator-typed file I/O — no dependency, but worth reading together for the full emission-discipline picture
- [docs/atoms/concepts/magic.md](../atoms/concepts/magic.md) — cell-magic registry the new entries land in
- [docs/atoms/concepts/magic-code-generator.md](../atoms/concepts/magic-code-generator.md) — the discipline that classifies `@@export` as a non-generator side-effect emitter
- [docs/atoms/discipline/certified-magic-emitter.md](../atoms/discipline/certified-magic-emitter.md) — the foreign-format `@@import` path remains a certified emitter; `@@export` is exempt
- [docs/atoms/discipline/wire-as-public-api.md](../atoms/discipline/wire-as-public-api.md) — public kernel surface this slice extends
- [llm_client/notebook.py](../../llm_client/notebook.py) — current home of the format converters (promoted to `llm_kernel.notebook_format`; this file becomes a shim)
