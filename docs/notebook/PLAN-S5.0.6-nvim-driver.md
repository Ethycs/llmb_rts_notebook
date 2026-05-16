# Plan: S5.0.6 — Nvim driver (third-class operator UI)

**Status**: queued — design locked, dispatch pending operator approval
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: ship a working Neovim plugin that lets an operator drive `.magic` / `.llmnb` notebooks against a running `llmnb serve` kernel from inside Neovim — per-cell run, inline output rendering, kernel status surface. Concretely realizes the "headless `llmnb` CLI, future Rust/Go drivers, remote orchestrators" use case [PLAN-S5.0.3 §3](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) named by establishing the *first* non-extension, non-CLI operator UI on top of the kernel wire.
**Time budget**: ~1-1.5 dispatcher-days. Two file-disjoint sub-slices: Python sidecar (~250 LoC) and Lua plugin (~300 LoC). Tests + docs ~100 LoC.

---

## §1. Why this work exists

Three concrete pressures push for an Nvim driver:

1. **The kernel-side substrate is complete; only the UI is missing.** After S5.0.3 (driver extraction + `--connect`), S5.0.5 Phase 1 (multi-format `@@import`), and S5.0.5 Phase 2 (`@@export`), every notebook operation an operator could want is reachable via either:
   - a TCP envelope to a `llmnb serve` kernel ([transport-mode.md](../atoms/concepts/transport-mode.md)), or
   - in-kernel magic dispatch (`@@import` / `@@export` / generators).

   What's NOT available is an operator-facing surface that ISN'T the VS Code extension. The `llmnb execute --connect` CLI works for batch runs ([driver.md](../atoms/concepts/driver.md)) but has no per-cell semantics — every invocation re-runs the whole file. The nvim driver fills that gap.

2. **The lint boundary is already a public-API promise.** [`tests/test_lint_boundary.py`](../../tests/test_lint_boundary.py) enforces that `llm_client/**` consumes only `llm_kernel.wire` / `cell_text` / `notebook_format`. The same surface is what any future driver consumes. By shipping a second driver (nvim, distinct from the VS Code extension), the project validates that the lint contract is sufficient — if the nvim driver can drive the kernel using only the public surface, every future driver can too.

3. **The friend (the operator who started this arc) is on nvim.** Tier 1 of the original triage ([llmnb execute the file](.) from inside nvim) and Tier 2 (`--connect` to a shared kernel) are shipped. Tier 3 is the actual nvim plugin — per-cell run, inline output, kernel-status chip. Without it, the nvim user gets file-level semantics only; the per-cell affordance that makes notebooks notebooks is missing.

S5.0.6 lands a Python sidecar (~250 LoC) wrapping `llm_client.driver` + a Lua plugin (~300 LoC) consuming the sidecar via Neovim RPC. The sidecar is the canonical reference implementation that the planned Rust/Go drivers will mirror.

### Dependencies

S5.0.6 dispatches **after** S5.0.3 (driver extraction), S5.0.3.1 (executor live mode), S5.0.5 Phase 1 + 2 (file encode/decode). Reasons:

- S5.0.3 ships [`llm_client.driver.ship_envelope`](../../llm_client/driver.py) + [`llm_client.driver.collect_snapshots`](../../llm_client/driver.py) — the two primitives the sidecar uses for every cell run.
- S5.0.3.1 makes `_run_live_mode` functional against a real kernel — proves the envelope-shipping path end-to-end.
- S5.0.5 Phase 1 + 2 give the operator `@@import` / `@@export` for file gestures, so the nvim plugin doesn't need its own file-I/O surface (it just runs cells and the kernel handles the file work).
- `--connect tcp://…` ([commit `df95ad4`](.)) on `llmnb execute` is the precedent for how external clients attach. The sidecar reuses [`llm_client.boot.connect_to_kernel`](../../llm_client/boot.py).

---

## §2. Goals and non-goals

### Goals

- **Per-cell run** — operator's cursor on a cell, hit `<leader>r` (configurable), the cell ships to the running kernel, output renders inline.
- **Persistent kernel** — sidecar attaches to a long-running `llmnb serve` (started in a separate terminal or via a launcher command). Kernel state (agents, turn history, metadata) persists across cell runs.
- **Inline output rendering** — agent text outputs rendered as Neovim virtual text below the cell boundary. K-class errors render as a one-line `❌ K3M: …` virtual-line.
- **`.magic` filetype recognition** — Neovim filetype plugin that:
  - Sets `filetype=magic` for `*.magic` files.
  - Provides syntax highlighting for `@@<kind>` and `@<flag>` lines.
  - Provides cell-boundary motion (`]c` / `[c` to jump between `@@break`-bounded cells).
- **Kernel status chip** — a statusline component showing `connected` / `disconnected` / `busy <cell_id>` based on snapshots.
- **Operator commands** —
  - `:LlmnbConnect [URL]` — attach (URL defaults to `tcp://127.0.0.1:7474`; token via `$LLMNB_AUTH_TOKEN`).
  - `:LlmnbDisconnect` — release the connection (kernel stays running).
  - `:LlmnbRunCell` — run the cell under the cursor.
  - `:LlmnbRunBuffer` — run every cell in the buffer (equivalent to `llmnb execute` but against the shared kernel).
  - `:LlmnbStatus` — print kernel session_id, wire version, connected cells, last error.
- **Reuses the kernel-side `@@import` / `@@export`** — no Neovim-side filesystem code. Operator types `@@export path:"out.ipynb"` in a cell and runs it; the kernel handles the file. Same for import.

### Non-goals (V1 — explicit)

- **No nvim-side cell structure mutation.** Adding / deleting / merging cells happens via the text buffer (operator edits `@@break` separators). The plugin observes the text; it doesn't structurally mutate.
- **No completion / LSP integration.** Cell text isn't language-aware in V1; no completion for `@@<magic>` names. V2+ may add an LSP server.
- **No agent process management UI.** Spawning / stopping agents happens via `@@spawn` / `@stop` cells, same as VS Code. The plugin doesn't expose a separate agent panel.
- **No multi-kernel orchestration.** One sidecar connects to one kernel. V2+ may add multi-attach.
- **No Windows-native Lua API peculiarities.** The plugin uses portable nvim APIs (`vim.api.nvim_buf_set_extmark`, `vim.fn.jobstart`, etc.). Cross-platform should work; testing primarily on Linux for the friend's case.
- **No streaming token rendering.** V1 waits for `run.complete` then renders. V2+ may stream Family A spans as they arrive.
- **No nvim-side `.llmnb` (JSON) editing** — operators work in `.magic` text. To touch a `.llmnb`, use the kernel: `:LlmnbRunCell` on `@@import file.llmnb` then `@@export path:"file.llmnb"` after edits.

---

## §3. Concrete work

### §3.1 Python sidecar (~250 LoC, single file)

| File | Edit nature |
|---|---|
| **NEW** `llm_client/nvim_sidecar.py` (~250 LoC) | Long-lived process. Speaks newline-delimited JSON over stdin/stdout (Neovim RPC convention via `jobstart`). Translates plugin requests into kernel envelopes via [`llm_client.driver.ship_envelope`](../../llm_client/driver.py) + [`llm_client.driver.collect_snapshots`](../../llm_client/driver.py). |
| **NEW** `llm_client/cli/nvim_sidecar.py` (~20 LoC) | `llmnb nvim-sidecar` subcommand. Thin wrapper that spawns the sidecar; argparse adds `--connect`, `--auth-token-env`. The plugin invokes `llmnb nvim-sidecar` rather than `python -m llm_client.nvim_sidecar` so the entry point is stable. |
| `llm_client/cli/__main__.py` | Register `nvim-sidecar` subcommand alongside `execute` / `convert` / `validate` / `smoke` / `auth` / `serve`. |

The sidecar is essentially a thin RPC adapter. The "smart" work — envelope construction, format conversion, file I/O — is all in the kernel and the existing `llm_client.*` modules.

### §3.2 Neovim plugin (~300 LoC Lua + ~50 LoC Vimscript)

| File | Edit nature |
|---|---|
| **NEW** `nvim/llmnb.nvim/lua/llmnb/init.lua` (~80 LoC) | Plugin entry point. `setup({...})` accepts config (sidecar path, connect URL, keybindings); exposes the public commands. |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/sidecar.lua` (~100 LoC) | Sidecar lifecycle. `vim.fn.jobstart` to launch; stdin send / stdout receive via `chansend` / `on_stdout` callbacks; JSON encode / decode via `vim.json`. |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/cells.lua` (~80 LoC) | Cell-boundary parsing: walks the buffer for `@@break` lines, returns cell ranges. Cell-at-cursor lookup. Cell text extraction. |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/render.lua` (~60 LoC) | Output rendering via extmarks. Maps cell_id → extmark namespace; clears + replaces virtual text on each run. K-class error rendering. |
| **NEW** `nvim/llmnb.nvim/plugin/llmnb.lua` (~10 LoC) | Plugin file that ensures `setup()` ran with defaults if user hasn't called it explicitly. |
| **NEW** `nvim/llmnb.nvim/ftplugin/magic.vim` (~30 LoC) | `.magic` filetype. Syntax highlighting for `@@<word>` / `@<word>` / `@@break`. Cell-jump motions `]c` / `[c` mapping. |
| **NEW** `nvim/llmnb.nvim/ftdetect/magic.vim` (~5 LoC) | `BufRead,BufNewFile *.magic set filetype=magic`. |
| **NEW** `nvim/llmnb.nvim/README.md` (~80 LoC) | Install instructions (Lazy.nvim / Packer / vim-plug snippets), config schema, command reference, troubleshooting. |

### §3.3 Doc + atom updates

| Path | Edit nature |
|---|---|
| **NEW** `docs/atoms/concepts/nvim-driver.md` | Concept atom — nvim driver as a peer of the VS Code extension. References the lint-boundary contract this driver validates. |
| [`docs/atoms/concepts/driver.md`](../atoms/concepts/driver.md) | Update V1 driver inventory table — add "Nvim driver" row with status pin. |
| [`README.md`](../../README.md) | Add a "Drivers" section listing VS Code + nvim, with one-line setup for each. |
| **NEW** `docs/ops/validate-nvim-driver.md` | Operational guide — smoke-test recipe: start kernel, open `.magic` in nvim, run a cell, verify output appears. Mirrors [`docs/ops/validate-serve-mode.md`](../ops/validate-serve-mode.md). |

**No kernel-side changes.** No new envelope types. No K-class additions. The wire surface is the contract; the nvim driver consumes it as-is.

---

## §4. Sidecar protocol (locked)

The plugin ↔ sidecar protocol is newline-delimited JSON over stdin/stdout. Plugin sends requests; sidecar responds + optionally pushes events.

### §4.1 Request shapes (plugin → sidecar)

```jsonc
// Connect to a running `llmnb serve`. Token loaded from env var named
// by `auth_token_env` (default LLMNB_AUTH_TOKEN). Sidecar returns
// session_id + wire_version on success.
{ "op": "connect", "bind": "tcp://127.0.0.1:7474", "auth_token_env": "LLMNB_AUTH_TOKEN" }

// Disconnect; kernel stays running.
{ "op": "disconnect" }

// Run a single cell. cell_id is plugin-minted (stable per buffer position);
// the sidecar generates an envelope based on cell.kind detection.
{ "op": "run_cell", "cell_id": "buf123:c4", "text": "@@scratch\nbody\n" }

// Get current status.
{ "op": "status" }
```

### §4.2 Response shapes (sidecar → plugin)

```jsonc
// Synchronous response to a request, keyed by op + a sidecar-issued
// request_id the plugin tracks per call.
{ "type": "response", "request_id": 17, "ok": true, "session_id": "abc...", "wire_version": "1.x.y" }
{ "type": "response", "request_id": 18, "ok": false, "k_code": "K3M", "message": "..." }

// Asynchronous event pushed by the sidecar when a snapshot or
// run.complete arrives from the kernel. Plugin renders based on
// cell_id correlation.
{ "type": "event", "kind": "cell_outputs", "cell_id": "buf123:c4",
  "outputs": [{"type": "text", "text": "hello\n"}] }
{ "type": "event", "kind": "cell_error", "cell_id": "buf123:c4",
  "k_code": "K3M", "message": "...", "cause": "path_outside_workspace" }
{ "type": "event", "kind": "kernel_status", "status": "busy", "cell_id": "buf123:c4" }
{ "type": "event", "kind": "kernel_status", "status": "idle" }
```

### §4.3 Lifecycle

1. Plugin calls `:LlmnbConnect` → spawns `llmnb nvim-sidecar` via `jobstart` → plugin sends `{"op": "connect", ...}` → sidecar calls `boot.connect_to_kernel(...)` → responds with session_id.
2. Plugin calls `:LlmnbRunCell` → sends `{"op": "run_cell", ...}` → sidecar builds an operator-action envelope (kind from `parse_cell` analog; for V1 we accept the cell text verbatim and let the kernel parse) → ships via `ship_envelope` → collects snapshot → pushes `cell_outputs` / `cell_error` event to plugin.
3. Plugin closes (buffer close, nvim quit) → sends `{"op": "disconnect"}` → sidecar exits (kernel keeps running).

### §4.4 Error propagation

- Sidecar-side errors (no kernel, bad token, malformed request) surface as `{"type": "response", "ok": false, "k_code": null, "message": "..."}` with explanatory text.
- Kernel-side K-class errors surface as `{"type": "event", "kind": "cell_error", "k_code": "K3M", ...}` — the plugin renders the standard K-class card.
- Transport drops (kernel died, network failure) surface as `{"type": "event", "kind": "kernel_status", "status": "disconnected"}`; the plugin disables `:LlmnbRunCell` until reconnect.

---

## §5. Plugin behavior

### §5.1 Cell parsing

The plugin treats the buffer as a `.magic` text file. Cell boundaries are lines matching `^@@break\s*$` (case-sensitive, no leading whitespace). Cell text is the lines BETWEEN (or before the first / after the last) `@@break` lines. Empty / whitespace-only cells are skipped (mirrors `split_at_breaks`).

Cell ids are stable within a buffer session: `buf<bufnr>:c<index>` where `<index>` is the 0-based cell ordinal. When the operator edits and inserts a new `@@break`, ids shift; the plugin clears all extmarks on detected boundary change and re-keys.

### §5.2 Run flow

1. `<leader>r` → invoke `:LlmnbRunCell`.
2. Plugin determines cell-at-cursor via `cells.cell_at_line(lnum)`.
3. Plugin clears existing extmarks for `cell_id`.
4. Plugin sends `{"op": "run_cell", "cell_id": cell_id, "text": cell_text}` to sidecar.
5. Plugin sets a "running" virtual line below the cell (`⏳ running…`).
6. Sidecar ships envelope, collects snapshots, finds outputs / error keyed to `cell_id` (correlation via the envelope's `request_id`).
7. Plugin replaces the running indicator with rendered outputs or an error chip.

### §5.3 Render shapes

Outputs render as virtual lines below the cell's last text line:

```
@@scratch
hello
                                                  ⏵ hello
@@break
```

```
@@scratch
broken
                                                  ❌ K3O · parse_failed
                                                  notebook_io_failed: ...
@@break
```

Status renders in the statusline (configurable):

```
[llmnb] connected · idle
[llmnb] busy · c3
[llmnb] disconnected
```

### §5.4 Filetype + motions

`.magic` filetype gets:

- Syntax for `@@<word>` (heading-3 color), `@<word>` (heading-4), `@@break` (comment color + separator-line emphasis).
- `]c` jumps to next `@@break + 1`; `[c` jumps to previous. Both `<count>`-aware.
- `gx` on a path token inside `@@import path:"…"` or `@@export path:"…"` opens the file (or the result on import; for export it's a no-op).
- Folding by cell (each `@@break`-bounded region is a fold).

---

## §6. Schema notes

No `metadata.rts` schema changes. The plugin consumes the existing snapshot shape.

The sidecar maintains a small in-process map `{cell_id_from_plugin → request_id}` so it can correlate snapshots back to the originating plugin cell. This map is reset on each `connect`; transient state, not persisted.

---

## §7. K-class additions

None. The wire surface is fixed; the plugin / sidecar consume existing K-classes (K3M / K3N / K3O from S5.0.5, plus the full pre-existing set) without adding any.

The sidecar may emit a synthetic "sidecar-side" failure shape for transport errors (`{"ok": false, "message": "kernel unreachable"}`) but these are NOT K-classes — they're plugin-layer errors.

---

## §8. Test surface

### §8.1 Sidecar (`tests/`)

| Test file | Coverage |
|---|---|
| `test_nvim_sidecar_connect.py` | Connect to a stub kernel; verify response shape; bad token surfaces `ok: false`. |
| `test_nvim_sidecar_run_cell.py` | Run a cell; verify envelope shipped; mock kernel returns outputs; sidecar pushes `cell_outputs` event. |
| `test_nvim_sidecar_disconnect.py` | Disconnect closes the connection but kernel stays up; subsequent run-cell returns "not connected". |
| `test_nvim_sidecar_correlation.py` | Multiple concurrent `run_cell` requests correlate correctly to cells (interleaved request_ids). |
| `test_cli_nvim_sidecar.py` | `llmnb nvim-sidecar` CLI entry point launches the sidecar; --help text is correct. |

### §8.2 Lua plugin (`nvim/llmnb.nvim/tests/`)

Use [plenary.nvim](https://github.com/nvim-lua/plenary.nvim) for harness:

| Test file | Coverage |
|---|---|
| `cells_spec.lua` | `cells.cell_ranges(buf)` returns correct ranges; `cells.cell_at_line(lnum)` resolves correctly; edits invalidate cached ranges. |
| `render_spec.lua` | `render.set_outputs(cell_id, outputs)` creates extmarks; `render.clear(cell_id)` removes them; multiple cells don't collide. |
| `sidecar_spec.lua` | `jobstart` mock; verify protocol framing; reconnect logic. |

### §8.3 Integration

`docs/ops/validate-nvim-driver.md` describes the manual smoke:

1. `pixi run kernel serve` (or `python -m llm_kernel serve --transport tcp --bind 127.0.0.1:7474 --auth-token-env LLMNB_AUTH_TOKEN`).
2. In nvim: open `examples/spawn-and-notify.magic`, `:LlmnbConnect`, `:LlmnbRunCell` on each cell in order.
3. Verify each cell renders its expected output.
4. `:LlmnbRunCell` on an `@@export path:"out.llmnb"` cell → file appears.
5. `:LlmnbRunCell` on `@@import out.llmnb` in a new buffer → cells appear in the buffer.

This is operator-validated, not CI-automated, in V1.

---

## §9. Risks (may force erratum)

1. **`jobstart` portability.** Neovim's `vim.fn.jobstart` works on Linux/macOS reliably; Windows has historical quirks with cmd vs. powershell parent process. Mitigation: invoke `llmnb nvim-sidecar` (the entry-point binary) rather than `python -m ...` so the shell isn't involved. Cross-platform smoke target Linux first (the friend's case); Windows queued for V1.5.

2. **Output coalescing.** Multiple snapshots may arrive per cell run; rendering each one overwrites the prior. V1 renders the FINAL snapshot only (per the `until=` predicate matching `run.complete`). Streaming render is V2+.

3. **Cell-id stability.** When the operator inserts a `@@break` mid-buffer, all cells below it shift index. V1: clear all extmarks on detected `@@break` change, re-key on next run. Acceptable for V1; V2+ may add stable cell-id markers in the buffer (e.g., trailing comment `# id:c4`).

4. **Sidecar lifecycle.** If the sidecar crashes, the plugin must detect and surface. V1: `on_exit` handler in `jobstart` flips status to `disconnected` + clears extmarks. Operator runs `:LlmnbConnect` to recover.

5. **Token in environment.** The sidecar reads `$LLMNB_AUTH_TOKEN` (or operator's configured var). If the operator's shell doesn't export it before launching nvim, connect fails with a clear "token env var unset" message. Document in the plugin README.

6. **Cell text round-trip.** The plugin sends raw cell text to the sidecar; the sidecar relays to the kernel which parses. For cells containing magic operator-typed content, this works identically to how the VS Code extension's cell-directive ships envelopes. For cells the operator HASN'T finished editing (mid-typing), `:LlmnbRunCell` MAY ship partial text — V1 accepts this (operator's responsibility); V2+ may add a "is cell text dirty?" check.

7. **Extmark vertical placement.** Virtual lines below the cell's last line MAY interleave awkwardly with subsequent `@@break` rendering. Visual testing during dispatch may force a layout adjustment (e.g., outputs above the next `@@break` separator). Document in plugin README.

If any risk surfaces a spec ambiguity, the implementing agent flags it; operator ratifies an erratum before implementation continues.

---

## §10. Critical files

| Path | Edit nature | Sizing |
|---|---|---|
| **NEW** `llm_client/nvim_sidecar.py` | Sidecar process: stdin/stdout JSON protocol, kernel connection lifecycle, envelope shipping | ~250 LoC |
| **NEW** `llm_client/cli/nvim_sidecar.py` | `llmnb nvim-sidecar` CLI subcommand wrapper | ~20 LoC |
| `llm_client/cli/__main__.py` | Register `nvim-sidecar` subcommand | ~3 LoC |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/init.lua` | Plugin entry + setup + commands | ~80 LoC |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/sidecar.lua` | Job lifecycle + JSON RPC framing | ~100 LoC |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/cells.lua` | Cell parsing + cursor lookup | ~80 LoC |
| **NEW** `nvim/llmnb.nvim/lua/llmnb/render.lua` | Extmark output rendering | ~60 LoC |
| **NEW** `nvim/llmnb.nvim/plugin/llmnb.lua` | Auto-run setup with defaults | ~10 LoC |
| **NEW** `nvim/llmnb.nvim/ftplugin/magic.vim` | Syntax + motions | ~30 LoC |
| **NEW** `nvim/llmnb.nvim/ftdetect/magic.vim` | Filetype detection | ~5 LoC |
| **NEW** `nvim/llmnb.nvim/README.md` | Install + usage + troubleshooting | ~80 LoC |
| `tests/test_nvim_sidecar_*.py` (5 files) | Sidecar unit + integration tests | ~150 LoC total |
| **NEW** `docs/atoms/concepts/nvim-driver.md` | Concept atom | ~80 LoC |
| [`docs/atoms/concepts/driver.md`](../atoms/concepts/driver.md) | V1 driver inventory: add Nvim row | ~5 LoC |
| [`README.md`](../../README.md) | "Drivers" section | ~20 LoC |
| **NEW** `docs/ops/validate-nvim-driver.md` | Smoke-test recipe | ~80 LoC |

**File-disjoint dispatch (2 parallel agents):**
- **Sidecar agent**: owns `llm_client/nvim_sidecar.py`, `llm_client/cli/nvim_sidecar.py`, `tests/test_nvim_sidecar_*`. Tests-driven; no nvim required.
- **Plugin agent**: owns everything under `nvim/llmnb.nvim/`, plus `docs/atoms/concepts/nvim-driver.md` and `docs/ops/validate-nvim-driver.md`. Manual nvim smoke at the end.

Shared interface: the sidecar protocol in §4 — locked here so both agents code against it.

---

## §11. Acceptance (whole slice, gate at end)

1. **Driver pytest** (`pixi run driver-test`) — existing 109 + new sidecar tests, all green.
2. **Lint boundary** — sidecar imports only `llm_client.*` + stdlib; no `llm_kernel.*` direct imports except via the documented allow-list. [`tests/test_lint_boundary.py`](../../tests/test_lint_boundary.py) green.
3. **Plugin tests** — `cd nvim/llmnb.nvim && nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/"` returns 0.
4. **Operator smoke** — the procedure in [`docs/ops/validate-nvim-driver.md`](../ops/validate-nvim-driver.md) (or equivalent) succeeds end-to-end on Linux. Run cell → output renders; run `@@export` cell → file lands; run `@@import` in another buffer → cells appear.
5. **CLI parity** — `llmnb nvim-sidecar --help` shows the subcommand; `llmnb nvim-sidecar` (no args) launches the sidecar in REPL mode (for manual protocol testing).
6. **Status surface** — `:LlmnbStatus` after a connect shows session_id, wire_version, last error (if any).
7. **Atom layer** — `concepts/nvim-driver.md` lands; `concepts/driver.md` V1 inventory updated; `ops/validate-nvim-driver.md` lands.
8. **README** — "Drivers" section added; both VS Code and nvim setup snippets present.
9. **No kernel changes** — verify [`vendor/LLMKernel/`](../../vendor/LLMKernel/) submodule pointer is unchanged from the parent commit's baseline. (Negative acceptance criterion — confirms the wire surface was sufficient.)
10. **Operator approves** — commit-message marker `feat(s5): nvim driver V1 (PLAN-S5.0.6)`.

---

## §12. After this slice

S5.0.6 unlocks:

- **Two operator surfaces** — VS Code extension and Neovim plugin, both consuming the same wire. The lint boundary is now validated by a second consumer.
- **Friend on nvim works** — the throughline of this session arc closes. Per-cell run, inline output, kernel-status chip — the actual notebook UX, just in Neovim.
- **Rust / Go orchestrators get a template** — the sidecar protocol in §4 is small (~6 message types) and the Python implementation is ~250 LoC; a Rust port is straightforward and would consume the same kernel without changes.
- **V2+ scope** that this enables: streaming token rendering, completion for `@@<magic>` names via an LSP, multi-attach (one nvim driving multiple kernels), terminal-mode TUI (curses-style separate front-end consuming the sidecar).

---

## §13. See also

- [PLAN-S5.0.3-driver-extraction-and-external-runnability.md](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — the slice that established the wire-as-public-API contract this driver consumes
- [PLAN-S5.0.5-magic-file-encode-decode.md](PLAN-S5.0.5-magic-file-encode-decode.md) — the encode/decode primitive that lets the operator drive file I/O from inside nvim via magic
- [docs/atoms/concepts/driver.md](../atoms/concepts/driver.md) — driver concept atom; V1 inventory gains Nvim
- [docs/atoms/concepts/transport-mode.md](../atoms/concepts/transport-mode.md) — TCP transport the sidecar uses
- [docs/atoms/discipline/wire-as-public-api.md](../atoms/discipline/wire-as-public-api.md) — the contract a second driver validates
- [docs/atoms/protocols/wire-handshake.md](../atoms/protocols/wire-handshake.md) — first envelope the sidecar exchanges
- [llm_client/driver.py](../../llm_client/driver.py) — `ship_envelope` + `collect_snapshots` primitives the sidecar wraps
- [llm_client/boot.py](../../llm_client/boot.py) — `connect_to_kernel` the sidecar uses at startup
- [docs/ops/validate-serve-mode.md](../ops/validate-serve-mode.md) — operational guide whose pattern `validate-nvim-driver.md` mirrors
