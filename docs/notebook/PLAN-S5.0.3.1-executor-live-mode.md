# Plan: S5.0.3.1 — Executor live-mode completion (async recv loop + per-cell semantics)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: complete `llm_client.executor.run_notebook(mode="live")` so it ships per-cell operator-action envelopes, drains kernel responses asynchronously, and persists the resulting Family F snapshot back to the notebook — replacing the current `NotImplementedError` raised after the hydrate envelope ships.
**Time budget**: ~0.4 dispatcher-day (single agent). Re-derived from reading the existing driver code; the `KernelConnection.recv` path already exists for TCP (`llm_client/transport/tcp.py:137`), the in-process path returns `{}` synchronously (`llm_client/boot.py:97`), and `llm_client.driver.ship_envelope` already implements the correlation-id wait loop. The remaining work is a thin `_run_live_mode` body and one integration test.

---

## §1. Why this work exists

PLAN-S5.0.3c shipped the executor structure (`run_notebook`, stub mode, replay mode, escalate guard) and S5.0.3d shipped the TCP transport + handshake. Live-mode is the last gap: today, `_run_live_mode` (`llm_client/executor.py:343-382`) boots the kernel, ships one Family F `mode: "hydrate"` envelope, then raises `NotImplementedError` citing S5.0.3d. S5.0.3d landed, but the executor was never re-pointed at the new transport surface — there is no plan describing how the live-mode loop should walk cells, ship Family A operator-actions, drain kernel envelopes, and decide when execution is "complete".

This is also the first concrete consumer of the async `KernelConnection.recv` path beyond the handshake itself. Locking the loop shape now keeps the surface small; deferring it bleeds into the multi-client / streaming-output work that is V2+.

---

## §2. Goals and non-goals

### Goals

- `run_notebook(path, mode="live")` boots a real kernel (in-process via `boot_minimal_kernel` for V1; out-of-process via `connect_to_kernel` later — see §6 risk #2), ships hydrate, then walks the layout in document order, shipping a Family A `operator.action` envelope per cell and collecting kernel-emitted Family F snapshots until execution is "complete" (criterion locked in §3.A).
- The final notebook on disk has `metadata.rts` populated from the latest Family F snapshot and per-cell `outputs[]` populated from agent responses observed during the run.
- `record_to=<path>` writes a `.replay.jsonl` of `{sent, received}` pairs equivalent to stub mode's recording — feeds replay-mode regression fixtures captured from a one-off live run.
- An integration test (`test_executor_live_mode.py`) gated on `ANTHROPIC_API_KEY` runs a 2-cell fixture (`@@spawn` then `@@agent`) and asserts: execution completes within the timeout, all cells get non-empty outputs, the result `final_state.cells.<id>.outputs` matches the structure that stub mode produces.

### Non-goals (V1 — explicit)

- **Out-of-process kernel for live mode.** V1 reuses `boot_minimal_kernel` (in-process). Out-of-process is an additive flag (`--connect tcp://…`) deferred to §6 risk #2; the loop shape is identical but the connection construction differs.
- **Streaming cell output.** Outputs land on the notebook only when the run completes (or the per-cell budget exhausts). Live cell-by-cell display is the extension's job, not the headless executor's.
- **`@@native` cells.** Out-of-scope per PLAN-S5.0; if encountered, the loop emits a `cell_kind="native"` no-op and continues. (Same shape as stub mode's degrade-to-noop.)
- **Interactive escalates.** `unattended=False` with an escalate cell already raises before booting (`llm_client/executor.py:444`). V1 live-mode preserves that gate; V2+ may add an attached-operator path.
- **Multi-agent fanout / parallel cell execution.** Cells are processed strictly in `_layout_walk_ids` order, one at a time. Concurrency is V2+ and would force a different completion criterion.

---

## §3. Concrete work

### §3.A Async recv loop shape (LOCKED)

**Per-cell ship-then-drain with quiescence.** For each cell in `_layout_walk_ids` order:

1. Derive an `operator.action` envelope from the cell record (mapping in §3.B).
2. Stamp `request_id = <session_id>:<ordinal>`; ship via `conn.send(envelope)`.
3. Drain `conn.recv(timeout=poll_interval)` in a loop, classifying each envelope:
   - `notebook.metadata` (Family F) → append to `snapshots[]`; update working state.
   - `operator.action` ack-shaped (Family A run.complete with matching `request_id`) → record success.
   - Any K-class error envelope (`payload.k_code`) → record failure for this cell.
   - Empty `{}` from `conn.recv` → quiescence tick.
4. Cell completes when any of:
   - A run.complete with the matching `request_id` arrives (clean per-cell completion), OR
   - `quiescence_window` (default 2.0s) of empty `recv` ticks, AND the working state's most recent agent for this cell is `runtime_status: idle`, OR
   - `cell_timeout` (default 60.0s) elapses → record K-class failure, continue to next cell.

After the last cell, drain one final time for `quiescence_window` to capture any trailing Family F snapshot (the kernel emits `trigger: "end_of_run"` after the closed run lands per `protocols/family-f-notebook-metadata.md` §"Cadence").

**Why not "send-all-then-await":** kernel-side dispatch is sequential per session; per-cell await keeps the failure model 1:1 with cells (one failure does not poison the rest of the run) and reuses `ship_envelope`'s correlation-id machinery.

**Why not "kernel emits an explicit `kernel.execute_complete`":** no such envelope exists in `wire/families.py`; introducing it would force an RFC-006 minor bump for one consumer.

### §3.B Per-cell envelope mapping (LOCKED)

Cells are read from `metadata.rts.cells.<id>` and processed in `_layout_walk_ids` order (already implemented at `llm_client/notebook.py:114`). Per-cell envelope:

| `cells.<id>.kind` | Wire envelope | Notes |
|---|---|---|
| `agent` (binding present) | `operator.action` `action_type: "agent_continue"`, `parameters: {agent_id, text, cell_id}`, `intent_kind: "send_user_turn"` | Matches `protocols/operator-action.md` row "agent_continue". `text` is the cell's stripped body. |
| `spawn` | `operator.action` `action_type: "agent_spawn"`, `parameters: {agent_id, task, cell_id, provider?, model?}` | `agent_id`/`task` parsed from the cell record's `bound_agent_id` + body. |
| `markdown` | (no envelope) | Skipped, counted as "executed=true, succeeded=true" with empty outputs. |
| `scratch` | (no envelope) | Same as `markdown`. |
| `native` | (no envelope) | Out of scope V1 per §2. |
| any other | (no envelope) | W4 "unknown action_type" defensive — logged, counted as succeeded with empty outputs. |

`originating_cell_id` is set to the cell id; `request_id` is `<session_id>:<ordinal>` (deterministic enough for the per-cell await; not globally unique because session_id is unique already).

### §3.C Output collection (LOCKED)

**Apply each Family F snapshot as the new working state, not as a patch.** Patch mode is V1.5+ per `protocols/family-f-notebook-metadata.md`. The executor:

1. Maintains `working_rts = notebook["metadata"]["rts"]` (initial value from the loaded notebook).
2. On each Family F `mode: "snapshot"` envelope, replaces `working_rts = envelope["payload"]["snapshot"]`.
3. On run completion, walks `working_rts.cells.<id>.outputs[]` and writes each list back into the loaded notebook's per-cell record (mirroring stub mode's behavior at `llm_client/executor.py:249-251`).
4. Returns `final_state=working_rts` in the `ExecutionResult`.

The kernel's `MetadataWriter` is the single logical writer of `metadata.rts`; the executor only mirrors it back to disk. (Driver discipline per `concepts/driver.md`.)

### §3.D Error / timeout / interrupt handling (LOCKED)

| Event | Behavior |
|---|---|
| `cell_timeout` (default 60s) elapses on a cell | Cell counted as failed with synthetic `k_code: "K_CELL_TIMEOUT"`; loop continues to next cell. |
| Kernel emits a K-class envelope correlated to the cell | Cell counted as failed with the kernel's `k_code` + `message`; loop continues. |
| `KeyboardInterrupt` (SIGINT) | `conn.close()` then re-raise. The executor does NOT swallow it — the calling CLI surfaces a clean exit code. |
| `connection_reset` mid-run (TCP only) | Synthetic `K_TRANSPORT_LOST`; remaining cells fail-fast with the same code. |

The executor exposes `--cell-timeout`, `--quiescence-window`, and `--total-timeout` flags through the CLI (`llm_client/cli/execute.py`); defaults match the constants above.

### §3.E Stub-mode parity (LOCKED)

The integration test asserts structural equivalence between stub and live runs of the same fixture:

- Same `len(cells_executed)`, `len(succeeded)`, `len(failed)`.
- Same set of cell ids in `final_state.cells`.
- Each cell's `outputs[]` is non-empty in live (real model produced text); structure (list of dicts with `output_type`/`text` keys) matches stub's canned shape.

Byte-identity is NOT asserted — live responses are real model output. The point is that downstream consumers (CI replay capture, future post-processors) cannot tell stub and live runs apart by shape alone.

---

## §4. Interface contracts (locked before dispatch)

No new public symbols. The body of `_run_live_mode` (`llm_client/executor.py:343-382`) is rewritten; signature stays:

```python
def _run_live_mode(
    notebook: dict,
    path: Path,
    *,
    record_to: Optional[Path],
    unattended: bool,
    cell_timeout: float = 60.0,
    quiescence_window: float = 2.0,
    total_timeout: float = 600.0,
) -> tuple[dict, list[dict], list[dict]]:
    ...
```

`run_notebook` grows three optional kwargs (defaulting to the constants above) so CLI flags surface at the public layer; existing callers are unaffected.

The recv loop reuses the already-shipped:

- `KernelConnection.send` / `KernelConnection.recv` (`llm_client/boot.py:74-98`; in-process branch returns `{}` immediately, TCP branch reads newline-delimited frames at `llm_client/transport/tcp.py:137-160`).
- `ship_envelope` for handshake-shaped per-cell await (`llm_client/driver.py:20-78`).
- `collect_snapshots` for the trailing drain (`llm_client/driver.py:81-124`).

---

## §5. Test surface

| Test | Scope |
|---|---|
| `test_executor_live_mode_completes.py` (NEW) | Gated on `ANTHROPIC_API_KEY`; runs `tests/fixtures/spawn-and-greet.magic` (2 cells: `@@spawn alpha`, `@@agent alpha hello`); asserts execution completes within total_timeout, both cells succeed, alpha's response cell has non-empty outputs. |
| `test_executor_live_quiescence.py` (NEW; in-process w/ stubbed proxy) | Constructs a `KernelConnection` whose `recv` returns scripted snapshots then `{}` for `quiescence_window`; asserts `_run_live_mode` returns after the window without hanging. |
| `test_executor_live_cell_timeout.py` (NEW; in-process) | Stubs `recv` to return `{}` indefinitely; asserts each cell records `K_CELL_TIMEOUT` and the loop completes within `total_timeout`. |
| `test_executor_live_record_to.py` (NEW; in-process w/ stubbed responses) | Asserts `record_to` writes a `.replay.jsonl` whose entries are `{sent, received}` pairs and whose count matches the number of envelope-emitting cells. |
| `test_executor_live_stub_parity.py` (NEW; integration; gated) | Runs the same fixture in stub and live; diffs the shape of `final_state.cells.<id>.outputs[]` (keys present, types) — must match. |

`test_executor_live_mode.py` placeholder shipped in S5.0.3c is replaced by these five files.

---

## §6. Risks (may force RFC erratum or scope adjustment)

1. **No `runtime_status: idle` field on agent yet.** The §3.A criterion references `working_state.agents.<id>.runtime_status`. If the kernel does not currently emit this in Family F snapshots, the quiescence-only fallback applies (no idle gate). Verify against `metadata_writer.py` before implementation; if missing, file an RFC-005 erratum or relax §3.A to "quiescence_window of empty recv".

2. **In-process `KernelConnection.recv` returns `{}` synchronously** (`llm_client/boot.py:97`). The in-process branch has no async event queue — so V1 live-mode is **TCP-only in practice**. Mitigation options:
   - **(a)** Add a CLI flag `--connect tcp://…` and require live-mode to use it (start kernel via `llmnb serve` first).
   - **(b)** Wire an in-process recv queue in `boot.py` that reads from the dispatcher's outbound side.
   This plan picks (a) — minimal scope, mirrors the §2 non-goal. The integration test starts a kernel subprocess (`llmnb serve --bind 127.0.0.1:0`) and connects via TCP, exactly like `tests/test_tcp_transport.py` already does.

3. **Quiescence-window heuristic may misfire on slow models.** A model that takes 3s between tool calls could trip the 2s window. Mitigation: `--quiescence-window 5` flag exposed; default tuned conservatively. The cell_timeout floor (60s) catches the worst case.

4. **`request_id` collisions across reconnects.** `<session_id>:<ordinal>` is unique within a session; if a flaky transport reconnects mid-run V1 fails fast (§3.D K_TRANSPORT_LOST). V2+ retry-with-backoff is out of scope.

5. **Stub-parity assertion is structural, not semantic.** A live response that shapes its outputs differently from the stub registry's canned shape (e.g., adds a `metadata` key the stubs don't carry) would fail the parity test. Mitigation: parity test asserts a key-subset, not key-equality. Document this in the test docstring.

If any risk surfaces an RFC ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §7. Atoms touched

None modified by this slice. Atoms read for context:

- `docs/atoms/concepts/driver.md` — V1.5 shipped; this slice is the first executor-side consumer of the driver/wire surface beyond the handshake.
- `docs/atoms/protocols/operator-action.md` — V1; per-cell envelope mapping (§3.B) cites the action-type catalogue.
- `docs/atoms/protocols/family-f-notebook-metadata.md` — V1; output collection (§3.C) honors `mode: "snapshot"` over patch.
- `docs/atoms/protocols/wire-handshake.md` — V1.5 shipped; live-mode preserves the "handshake first, then family frames" invariant.
- `docs/atoms/discipline/wire-as-public-api.md` — V1.5; lint boundary stays intact (no new non-wire imports under `llm_client/`).

A possible downstream atom flip: once this slice ships, `concepts/driver.md`'s "V2+ candidates" Rust-orchestrator entry has its first reference implementation in Python — no status flip required, but the atom's V1 inventory grows.

---

## §8. Cross-references

- [PLAN-S5.0.3 §6.2](PLAN-S5.0.3-driver-extraction-and-external-runnability.md#62-execute-modes) — the "execute modes" table whose `live` row this slice fills.
- [PLAN-S5.0.3 §9](PLAN-S5.0.3-driver-extraction-and-external-runnability.md#9-interface-contracts-locked-before-dispatch) — the `run_notebook` interface this slice keeps additive.
- [PLAN-S5.0.3 §10 risk #7](PLAN-S5.0.3-driver-extraction-and-external-runnability.md#10-risks-may-force-rfc-erratum-or-scope-adjustment) — escalate guard preserved at the live-mode entry.
- [PLAN-S4 §10](PLAN-S4-cross-agent-handoff.md) — V1 vs V1.5 callout style this plan mirrors.
- `llm_client/executor.py:343-382` — the `NotImplementedError` site this slice rewrites.
- `llm_client/transport/tcp.py:137-160` — the recv path live-mode consumes.
- `llm_client/driver.py:20-124` — `ship_envelope` + `collect_snapshots` reused by the loop.

---

## §9. Definition of done

1. `_run_live_mode` no longer raises `NotImplementedError`; it returns the same `(notebook, succeeded, failed)` tuple that stub and replay modes return.
2. Five new tests in §5 pass under `pixi run pytest -n auto --dist=loadfile --timeout=120`; integration tests gated on `ANTHROPIC_API_KEY` are marked `@pytest.mark.integration` and run separately in CI.
3. `llmnb execute tests/fixtures/spawn-and-greet.magic --mode live --connect tcp://127.0.0.1:<port> --token-env LLMNB_AUTH_TOKEN` runs end-to-end and writes outputs back to the notebook in <30s.
4. Stub-parity test demonstrates that `final_state.cells.<id>.outputs[]` from a live run is shape-compatible with stub mode (key-subset assertion).
5. CLI `--cell-timeout`, `--quiescence-window`, `--total-timeout` flags exposed in `llm_client/cli/execute.py` and visible in `llmnb execute --help`.
6. Lint boundary holds (`tests/test_lint_boundary.py` green) — no new non-wire imports under `llm_client/`.
7. PLAN-S5.0.3 §6.2 "execute modes" table updated post-ship: the `live` row's "Behavior" cell loses the deferral footnote.
8. Atom flips: none required by this slice. (Driver atom remains V1.5; the slice is purely an executor body fill-in.)

---

## §10. After this slice

S5.0.3.1 unlocks:

- **Tests-as-notebooks against real models.** CI smokes that today only run in stub mode can opt into a live-mode tier (gated on `ANTHROPIC_API_KEY`) for end-to-end regression coverage.
- **Replay capture from live runs.** `llmnb execute … --mode live --record-to fixture.replay.jsonl` produces a deterministic regression fixture captured from a single real run.
- **In-process live-mode (V1.5).** Risk #2 alternative (b) — wiring an in-process recv queue — becomes a follow-up slice if the TCP-only constraint proves friction for tests.
- **Multi-agent fanout (V2+).** The per-cell strict-sequential loop is the simplest scaffold; concurrent multi-cell execution requires a different completion criterion and is out of scope.
