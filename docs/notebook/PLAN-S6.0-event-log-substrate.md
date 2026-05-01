# Plan: S6.0 — Event-log substrate (in-tree, L2 architecture)

**Status**: ready (revised 2026-04-30 to in-tree event log; sidecar JSONL deferred to V2+)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: make `metadata.rts.event_log[]` the canonical persisted event log inside `.llmnb`. Every wire envelope worth persisting (Family A operator.action + Family D events + Family F snapshot checkpoints + Family G handshake/lifecycle) is appended to the in-tree array. The rest of `metadata.rts.*` becomes a derived snapshot/cache. Unlock undo/redo, time-travel, branch-as-replay, and tests-as-event-traces — without introducing a sidecar file format.
**Time budget**: ~0.6–0.9 dispatcher-day, single agent. Re-derived after the in-tree simplification: no sidecar file, no two-source merge logic, no compaction-to-separate-file. The work reduces to: extend the dispatcher's emit path to append to `metadata.rts.event_log[]`, build a replayer that consumes the in-tree array, gate `AgentSupervisor` instantiation behind a `read_only` flag for replay sandboxing, write three test files.

---

## §1. Why this work exists

The campaign reached V1.5 substrate complete (`docs/atoms/discipline/wire-as-public-api.md` Status flipped 2026-04-29). The wire envelope stream is now the kernel's only public surface. An architectural design conversation surfaced a coherent next-phase observation: **the wire envelope stream is already an event log; persisting it inside the `.llmnb` JSON tree is mostly a tee, not a redesign.**

Three pressures motivate L2 now:

1. **State-mutation features without history are ad-hoc bolts.** Undo/redo, time-travel, branch-as-replay, and tests-as-event-traces all want the same thing: a deterministic record of every operator-typed action and every state checkpoint. Building each on its own fork of the metadata-writer is N redundant log structures. Building one event log is N-into-1.
2. **The current `.replay.jsonl` is per-cell {sent,received} pairs (`executor.py:202-259`), not envelopes.** It records executor-side I/O, not the kernel's truth. Replaying it can reconstruct an `ExecutionResult` but cannot rebuild `metadata.rts`. A real event log persists the kernel's emitted stream so any consumer (driver, UI, test, time-travel debugger) can replay deterministically.
3. **The `metadata.rts.event_log[]` in-tree array (`metadata_writer.py:1686`) already collects `agent_ref_move` events.** The shape is right; the surface is too narrow. This slice extends `event_log[]` to carry the full envelope stream and makes it the canonical replay source. No sidecar file is introduced — `.llmnb` remains the single file format VS Code reads/writes.

L2 is the slice level: persist + replay, in-tree. L3 (full event-sourcing where the rest of `metadata.rts.*` is *only* derived) is V3 territory and out of scope here. A sidecar JSONL with streaming external consumers is V2+ (see §10).

---

## §2. Goals and non-goals

### Goals

- One new module `vendor/LLMKernel/llm_kernel/event_log.py` (~120 LoC, smaller than the sidecar version) exposing `EventLogReplayer` — consumes `metadata.rts.event_log[]`, projects state, no file I/O.
- `MetadataWriter._build_envelope` → `dispatcher.emit` path (`metadata_writer.py:3499-3503`) gains a tee-call that appends the envelope to `metadata.rts.event_log[]` (extending the existing array's purpose from `agent_ref_move`-only to full envelope stream).
- On notebook open, the driver loads `metadata.rts` from `.llmnb` as today; the replayer (when explicitly invoked) projects state from `metadata.rts.event_log[]` as a deterministic re-derivation.
- Replay is deterministic: same `event_log[]` prefix → same in-memory state, every time. No agent processes spawn during replay.
- Operator-driven compaction: a `@checkpoint` line-magic forces a Family F `mode: "snapshot"` envelope to be appended to `event_log[]` and marks it as the active checkpoint; auto on save / shutdown.
- Schema-version reads: each envelope's `rfc_version` field (already present per `run_envelope.py:53`) is the version branch point. Major mismatch on load → reject; minor mismatch → warn + proceed.

### Non-goals (V1 — explicit)

- **Sidecar `.jsonl` file.** Events live inside `.llmnb` as `metadata.rts.event_log[]`. A sidecar file format with `tail -f` streaming for external observers is V2+ when external consumers actually need it (see §10).
- **L3 full event-sourcing.** The rest of `metadata.rts.*` (zone, cells, config) remains a primary persisted form. The event log is the canonical record; the snapshot is a fast-load cache. V3+ may demote the snapshot to "purely derived."
- **Magic-as-sole-IR.** Routing every UI affordance (move cell, delete cell, click run) through a magic representation is a V2+ tightening. See §10.
- **Multi-driver-write coordination.** The kernel is the single logical writer of envelopes (already true today; see §4). Multi-writer-with-CRDT is V2+.
- **In-flight snapshot patches as separate persisted events.** V1.5+ Family F `mode: "patch"` envelopes (per `wire/families.py:85`) are transient deltas on the wire. The persisted log carries only `mode: "snapshot"` checkpoint envelopes; patches are a wire-side optimization and replay reconstructs from snapshots + Family A/D events between them.
- **OTLP spans persisted to the event log.** Family A `run.start | run.event | run.complete` (the OTLP run lifecycle per `families.py:31`) goes through a different observability sink already; persisting it twice is out of scope. (The closed span lands in `metadata.rts.event_log.runs[]` via `_build_event_log` at `metadata_writer.py:3632`; replay reconstructs it from the snapshot envelope.)
- **History truncation as automatic policy.** Truncating prior `event_log[]` entries is operator-initiated only — history is valuable; only the operator decides when to discard.

---

## §3. Concrete work

### §3.A Storage location

- Events live in `metadata.rts.event_log[]` inside the existing `.llmnb` JSON tree. No sidecar file.
- The array is append-only during a session. Each entry is one envelope (the **internal v1 envelope** per `run_envelope.py:88` `make_envelope` shape, preserving `rfc_version` for replay branching — see §3.G).
- The existing `.llmnb` save path (extension `vscode.NotebookEdit` or kernel-side `MetadataWriter.snapshot()`) persists `event_log[]` along with the rest of `metadata.rts`. No new I/O code.
- Operator-overridable cap: `metadata.rts.config.event_log_max_entries` (default `None` = unbounded; setting an integer auto-archives older entries on save).
- Setting `metadata.rts.config.event_log_enabled = false` disables the tee for that notebook (events still flow on the wire; they just aren't recorded).

### §3.B What goes in the log

Verified against the wire today:

| Family | Wire shape | Persist? | Verified at |
|---|---|---|---|
| **Family A: `operator.action`** (Family D outer per [protocols/family-d-event-log](../atoms/protocols/family-d-event-log.md)) | inbound; every operator-typed event | yes | `wire/families.py:31`, `run_envelope.py:42` |
| **Family A: `run.start | run.event | run.complete`** (OTLP lifecycle) | outbound spans | NO — separate observability sink (non-goal §2) | `run_envelope.py:131` |
| **Family B: `layout.edit | layout.update`** | inbound + outbound | yes | `wire/families.py:46`, `run_envelope.py:40` |
| **Family C: `agent_graph.query | agent_graph.response`** | bidirectional w/ correlation_id | yes | `wire/families.py:61`, `run_envelope.py:41` |
| **Family F: `notebook.metadata` mode=snapshot** | kernel → driver, full state | yes (the load-checkpoint) | `metadata_writer.py:3697` |
| **Family F: `notebook.metadata` mode=hydrate** | driver → kernel, file-open | yes (informational; kernel processes ≤1) | `wire/families.py:78` |
| **Family F: `notebook.metadata` mode=patch** | V1.5+, transient delta | NO — non-goal §2 | `wire/families.py:85` |
| **Family G: `kernel.handshake`** | first envelope | yes (one per session) | `serve_mode.py:192`, `wire/families.py:104` |
| **Family G: `heartbeat.kernel | kernel.shutdown_request`** | lifecycle | yes | `run_envelope.py:43-48` |

Stub/inactive families (Family B/C are wired in `run_envelope.py:40-41` but the dispatcher emits them only on the few code paths that currently populate them) ride the same persistence path; when active, no plan-amendment is needed.

### §3.C Load / replay engine

Two distinct paths:

**Normal load (today's behavior, unchanged)**: read `metadata.rts` from the `.llmnb` JSON tree (`executor.py:461`). The snapshot is canonical for fast load. `metadata.rts.event_log[]` rides along but isn't replayed.

**Replay invocation (new, explicit)**: the replayer projects state from `metadata.rts.event_log[]` for undo, time-travel, branch-as-replay, and tests. Algorithm:

1. Iterate `metadata.rts.event_log[]` in order.
2. Find the most-recent entry with `kind == "notebook.metadata"` and `payload.mode == "snapshot"` (the checkpoint envelope).
3. Set `working_rts := snapshot.payload.snapshot` (matches today's apply path at `executor.py:584` and `executor.py:691`).
4. Re-apply each subsequent entry through the same dispatcher routing the live path uses, but in **read-only mode** (see §3.D).
5. Return `working_rts` as the projected state.

Determinism contract: same `event_log[]` prefix → byte-identical `working_rts`, every time. Tests assert this (§5).

**Why two paths**: the snapshot is a fast-load cache; the event log is the canonical record. Most notebook opens use the fast path. Replay is invoked when an operation requires it (undo, time-travel, test). V3+ may collapse to one path (event log only) when the snapshot becomes purely derived.

### §3.D Replay sandbox

Replay must work without spawning agents (UI undo, time-travel, regression tests):

- The replayer instantiates the kernel-side dispatcher in **read-only mode**: a flag on `boot_minimal_kernel(...)` (`llm_client/boot.py:1`) that wires `MetadataWriter` but does NOT instantiate `AgentSupervisor`. The supervisor is the only kernel component that spawns agent processes; gating it is sufficient.
- `MetadataWriter` consumes intent envelopes the same way it does live (`metadata_writer.py:1649` `_handle_record_event` and siblings); state mutations are deterministic.
- Operator-typed re-execution is the only path that re-spawns agents — that's a *new* envelope appended to the log, not a replayed one. Replay never reaches that branch.

### §3.E Persistence path: in-memory tee, persisted with the rest of `metadata.rts`

Concrete decision: **kernel-side, in-memory append**. The kernel already has the writer that emits envelopes (`CustomMessageDispatcher.emit` at `custom_messages.py:346`); it just tees the same emission stream to `metadata.rts.event_log[]` in-memory.

- The dispatcher's `emit(...)` call is teed: after the internal envelope is constructed (pre-`_to_thin_v2`), it's also `metadata.rts.event_log.append(envelope)`-ed.
- For inbound traffic the kernel sees on `register_handler` (`custom_messages.py:386`), the handler-entry path also tees the inbound envelope so the log captures both directions.
- No file I/O during run — `event_log[]` is a Python list in `metadata.rts`. It persists when the rest of `metadata.rts` persists (extension `vscode.NotebookEdit` save, kernel-side `MetadataWriter.snapshot()`).
- Crash-during-run loses any in-flight events between snapshots — same property as today, no regression.

Drivers see the same wire stream they always did — the tee is invisible to them.

### §3.F Compaction

Policy:

- On save (operator triggers `mode: "snapshot"` `trigger: "save"` per RFC-005 §"Snapshot triggers"; today emitted by `MetadataWriter.snapshot()` at `metadata_writer.py:3490`), the snapshot envelope is appended to `event_log[]` as the most-recent checkpoint. Subsequent replays find it via the §3.C scan.
- On clean shutdown (`MetadataWriter.stop(emit_final=True)` at `metadata_writer.py:3529`) the same path runs.
- Operator-driven explicit checkpoint: a `@checkpoint` line-magic forces an out-of-cycle snapshot envelope appended to `event_log[]`. (Magic-vocabulary precedent: PLAN-S5.0 §3.6 already routes line-magics through `cell_edit` → kernel; `@checkpoint` lands as an `operator.action` whose handler calls `MetadataWriter.snapshot(trigger="explicit")`.)
- Truncate-prefix is operator-initiated: a `@truncate` line-magic OR a CLI flag (`llmnb event-log truncate <notebook>`). Reason: history is valuable; only the operator discards. Truncation rewrites `event_log[]` to start at the most-recent snapshot, archiving the prior prefix to `metadata.rts.event_log_archive[]` (or to `<notebook>.llmnb.archive-<timestamp>.json` on confirmation prompt).

### §3.G Schema versioning

- Every envelope already carries `rfc_version` (`run_envelope.py:53`, `run_envelope.py:80`). Replay code reads it and branches if needed.
- `WIRE_VERSION = "1.0.0"` (`vendor/LLMKernel/llm_kernel/wire/version.py:3`). Major mismatch on a JSONL-load → reject with a structured error (matches the runtime [wire-handshake](../atoms/protocols/wire-handshake.md) major-mismatch behavior).
- Minor mismatch → warn + proceed (newer minor must be backward-compatible per RFC-006 v2.1.0).
- Bump procedure: when wire goes 1.x → 2.0, the replayer needs a migration shim (read 1.x lines, transform to 2.x in-memory). Document the discipline; don't implement migrations until the bump happens.

### §3.H Concrete files

| Path | Edit nature | LoC |
|---|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/event_log.py` | `EventLogReplayer` only — consumes in-memory list, no file I/O | ~120 |
| `vendor/LLMKernel/llm_kernel/custom_messages.py` | tee in `emit()` (`:346`) and inbound handler entry (`:386`); append to `metadata.rts.event_log[]` | ~25 |
| `vendor/LLMKernel/llm_kernel/metadata_writer.py` | extend `event_log[]` to carry full envelopes (was `agent_ref_move`-only); add `event_log_max_entries` cap honoring; ensure save-path persists `event_log[]` | ~20 |
| `llm_client/boot.py` | accept `read_only` kwarg; gate `AgentSupervisor` instantiation | ~10 |
| `llm_client/executor.py` | (no changes needed for V1 — replay is invoked explicitly, not on every open) | 0 |
| **NEW** `vendor/LLMKernel/tests/test_event_log_replay.py` | replay determinism | new |
| **NEW** `vendor/LLMKernel/tests/test_event_log_round_trip.py` | round-trip tests | new |
| **NEW** `vendor/LLMKernel/tests/test_magic_fixture_replay.py` | `.magic` → events → tree pipeline | new |

---

## §4. Interface contracts (locked before dispatch)

### `llm_kernel.event_log` (NEW)

```python
class EventLogReplayer:
    def __init__(self, event_log: list[dict]) -> None:
        """Consumes metadata.rts.event_log[] in-memory; no file I/O."""

    def latest_snapshot(self) -> dict | None:
        """Return the most-recent envelope where kind == 'notebook.metadata'
        and payload.mode == 'snapshot', or None."""

    def envelopes_after_snapshot(self) -> Iterator[dict]:
        """Yield the envelopes that follow the latest snapshot, in order."""

    def project_state(self, *, dispatcher) -> dict:
        """Load latest snapshot, replay subsequent envelopes through the
        read-only dispatcher, return the resulting metadata.rts."""
```

No `EventLogWriter` is needed — the dispatcher tee writes directly to `metadata.rts.event_log[]`.

### `llm_client.boot.boot_minimal_kernel` (extended)

```python
def boot_minimal_kernel(
    *,
    proxy: Literal["litellm", "passthrough", "stub"] = "litellm",
    work_dir: Path | None = None,
    transport: Literal["pty", "unix", "tcp"] = "pty",
    bind: str | None = None,
    auth_token: str | None = None,
    read_only: bool = False,                # NEW — replay sandbox flag
) -> KernelConnection: ...
```

When `read_only=True`: dispatcher + writer are wired but `AgentSupervisor` is not instantiated. Replay path uses this. No `event_log_path` kwarg needed — the log lives in `metadata.rts`.

### `llm_client.executor.run_notebook`

No changes for V1. Notebook open continues to load `metadata.rts` from `.llmnb` directly. Replay is invoked by callers (UI undo, tests, time-travel) via `EventLogReplayer.project_state(...)` against the loaded `metadata.rts.event_log[]`.

---

## §5. Test surface

| Test | Asserts |
|---|---|
| `test_event_log_round_trip.py::test_append_and_read` | A known sequence of envelopes written via `EventLogWriter`, read back via `EventLogReplayer`, yields the identical sequence (line-for-line). |
| `test_event_log_round_trip.py::test_latest_snapshot` | A log containing 3 snapshots returns the third on `latest_snapshot()`. |
| `test_event_log_replay.py::test_replay_determinism` | A fixture JSONL replayed twice produces byte-identical `metadata.rts`. |
| `test_event_log_replay.py::test_no_agent_spawn_on_replay` | `AgentSupervisor` is never instantiated under `read_only=True`. |
| `test_event_log_replay.py::test_snapshot_equivalence` | Tree state at envelope N (replayed from log) matches direct construction of the same state via live dispatch. |
| `test_event_log_replay.py::test_hypothesis_random_envelopes` | Hypothesis fuzz: random valid envelope sequences replay without divergence; tree shape consistent. |
| `test_magic_fixture_replay.py::test_magic_to_events_to_tree` | A `.magic` text fixture parses → emits operator-action sequence → writes to JSONL → replays → resulting tree matches the assertion fixture. (Lifts the fixtures-as-tests work flagged in PLAN-S5.0.) |
| `test_event_log_replay.py::test_major_version_mismatch_rejected` | A JSONL with envelopes carrying `rfc_version: "2.0.0"` while kernel is 1.x is rejected on load. |
| `test_event_log_replay.py::test_minor_version_mismatch_warns` | A JSONL with `rfc_version: "1.1.0"` while kernel is 1.0.0 logs a warning and proceeds. |

---

## §6. Risks (may force RFC erratum or scope adjustment)

1. **Tee-on-emit doubles the in-memory work on the hot path.** Each emit appends to a Python list. Negligible cost (microseconds), no I/O. The previous risk about fsync is moot under in-tree storage.

2. **The thin v2 envelope drops `rfc_version` on egress** (per RFC-006 §3 flattening, applied in `_to_thin_v2`). Replay needs the version. Resolution: `event_log[]` persists the **internal v1 envelope** (`run_envelope.py:88` `make_envelope` shape), captured pre-`_to_thin_v2`. The wire send still carries the thin form. One-line decision in the dispatcher tee. (Was previously flagged as an open ambiguity in the sidecar plan; now closed.)

3. **`.llmnb` file size grows with event history.** A long session accumulates many envelopes. Mitigations: (a) blob extraction already runs (`metadata_writer.py:3619`), so large outputs are `$blob:sha256:…` refs, not inline bytes — `metadata_writer.py:236-249` confirms; (b) `event_log_max_entries` cap auto-archives older entries on save; (c) operator `@truncate` for explicit history discard. Net: file size grows linearly with operator-action count, not output volume.

4. **In-tree `metadata.rts.event_log[]` overlaps with `agent_ref_move`-only existing usage.** Today, `agent_ref_move` events land in the in-tree array (`metadata_writer.py:1686`). After this slice, `event_log[]` is broadened to carry the full envelope stream. Existing readers expecting only `agent_ref_move` may break. Resolution: existing readers must filter by envelope `kind`; document this in the migration notes for the slice.

5. **Truncation is dangerous.** Operator-initiated truncate-prefix discards history. Mitigation: `@truncate` and the CLI emit a confirmation prompt; truncation archives the prior prefix (to `metadata.rts.event_log_archive[]` or to `<notebook>.llmnb.archive-<timestamp>.json` per operator preference) rather than deleting outright.

If any risk surfaces an RFC ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §7. Atoms touched

- **NEW**: `docs/atoms/concepts/event-log.md` (the in-tree event-log concept; the thing this plan introduces).
- **NEW**: `docs/atoms/contracts/event-log-replayer.md` (the read-side contract; consumes `metadata.rts.event_log[]`).
- **MOD**: `docs/atoms/protocols/family-f-notebook-metadata.md` — note that snapshot envelopes appended to `event_log[]` serve as replay checkpoints.
- **MOD**: `docs/atoms/discipline/wire-as-public-api.md` — note that the wire stream is now also the in-tree persistence channel.
- **MOD**: `docs/atoms/protocols/family-d-event-log.md` — point out that the family name reflects the substrate this plan ships (the family was named for this purpose; `metadata.rts.event_log[]` is its persistence form).

---

## §8. Cross-references

- [PLAN-S5.0.3](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — parent plan; the wire layer this builds on.
- [PLAN-S5.0.3.1](PLAN-S5.0.3.1-executor-live-mode.md) — async recv loop the replayer reuses.
- [PLAN-S4.1](PLAN-S4.1-turn-graph-persistence.md) — `record_event` / `agent_ref_move` shape that lands in the in-tree `event_log[]` and (post-S6.0) in the JSONL.
- [docs/atoms/protocols/family-f-notebook-metadata.md](../atoms/protocols/family-f-notebook-metadata.md) — Family F snapshot semantics (the load-checkpoint).
- [docs/atoms/protocols/family-d-event-log.md](../atoms/protocols/family-d-event-log.md) — Family D operator-action shape (every envelope this plan persists).
- [docs/atoms/protocols/wire-handshake.md](../atoms/protocols/wire-handshake.md) — version mismatch behavior the replayer mirrors on load.
- [docs/atoms/protocols/operator-action.md](../atoms/protocols/operator-action.md) — action_type catalogue persisted in the JSONL.
- [docs/atoms/protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — intent envelope shape inside `zone_mutate` actions.
- [RFC-005 §"Persistence strategy"](../rfcs/RFC-005-llmnb-file-format.md) — JSON tree persistence (the JSONL is its peer).
- [RFC-006](../rfcs/RFC-006-kernel-extension-wire-format.md) — wire envelope contract.

---

## §9. Definition of done

1. `pixi run pytest vendor/LLMKernel/tests/test_event_log_*` and `pytest tests/test_magic_fixture_replay.py` green under `--timeout=60`.
2. A 10-cell live-mode run produces a `.llmnb` whose `metadata.rts.event_log[]` carries every operator.action + Family D + Family F snapshot envelope, in order.
3. The latest snapshot envelope's `payload.snapshot` byte-equals the post-run `metadata.rts` zone+cells+config (the snapshot accurately captures state).
4. Reopening that notebook and invoking `EventLogReplayer.project_state(...)` produces a projection byte-equal to the post-run `metadata.rts`.
5. Replay determinism: 10 consecutive replays of the same `event_log[]` produce byte-identical projections.
6. `read_only=True` boot path verified by test: `AgentSupervisor` is never instantiated; no agent processes spawn.
7. Major-version mismatch on a fixture event log is rejected; minor-version mismatch warns + proceeds.
8. Operator approves — typically as a tag (`v1.6-event-log-substrate`) or a commit message marker.

---

## §10. V2+ stretch — sidecar JSONL + magic-as-sole-IR

Two separate V2+ tightenings build on top of this slice. Both are deferred:

**§10.1 Sidecar `.jsonl` for streaming external observers.** Once external consumers want `tail -f` on the event stream (CI watchers, dashboards, replay debuggers, multi-window UI), a sidecar `<notebook>.llmnb.events.jsonl` becomes useful. The kernel would tee `metadata.rts.event_log[]` appends to the file as it writes them in-memory. V1 gets the value of in-tree storage (single file, no drift, simpler load); V2+ adds the sidecar when the streaming need arises. The in-memory log is the source of truth in either layout.

**§10.2 Magic-as-sole-IR.** L2 alone gets the event log and makes replay deterministic, but it does NOT enforce that all mutations come through magic-parsing. A V2+ tightening would route every UI affordance (move cell, delete cell, click run, drag-and-drop) through a magic representation so the UI becomes a projection of magic + event history.

Cost: every UI affordance needs a magic form. Some require new vocabulary (e.g., `@@move c_3 before c_2`, `@@delete c_5`). The cell-magic vocabulary (PLAN-S5.0) added the textual surface; magic-as-sole-IR adds the structural-mutation surface.

Benefit: uniform event grammar — every state change has a single textual form. UI actions become operator-reproducible: an operator can read `event_log[]`, see exactly what happened, and replay it by typing the magic.

**Both are out of scope for L2.** This plan delivers the in-tree persistence + replay substrate; the sidecar JSONL and magic-as-sole-IR are separate decisions that build on top.
