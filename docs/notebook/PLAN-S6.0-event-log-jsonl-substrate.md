# Plan: S6.0 — Event-log JSONL substrate (L2 architecture)

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: persist the wire envelope stream as a sidecar `.llmnb.events.jsonl` so the JSON tree (`.llmnb`) becomes a derived projection of the event log, not the in-place mutation source. Unlock undo/redo, time-travel, branch-as-replay, and tests-as-event-traces — features that without an event log would each be ad-hoc bolts.
**Time budget**: ~1.0–1.4 dispatcher-day, single agent. Re-derived from reading the code: the kernel already has the dispatcher emit point (`metadata_writer.py:3503`), the executor already drains snapshots and reapplies them whole (`llm_client/executor.py:582-584`), and `record_to=<.replay.jsonl>` already writes per-cell envelope pairs to disk (`executor.py:255-259`). The new code is one ~200-LoC module plus a tee-call in the dispatcher and a load-on-open path in the driver.

---

## §1. Why this work exists

The campaign reached V1.5 substrate complete (`docs/atoms/discipline/wire-as-public-api.md` Status flipped 2026-04-29). The wire envelope stream is now the kernel's only public surface. An architectural design conversation surfaced a coherent next-phase observation: **the wire envelope stream is already an event log; persisting it as a sidecar JSONL is mostly a tee, not a redesign.**

Three pressures motivate L2 now:

1. **State-mutation features without history are ad-hoc bolts.** Undo/redo, time-travel, branch-as-replay, and tests-as-event-traces all want the same thing: a deterministic record of every operator-typed action and every state checkpoint. Building each on its own fork of the metadata-writer is N redundant log structures. Building one event log is N-into-1.
2. **The current `.replay.jsonl` is per-cell {sent,received} pairs (`executor.py:202-259`), not envelopes.** It records executor-side I/O, not the kernel's truth. Replaying it can reconstruct an `ExecutionResult` but cannot rebuild `metadata.rts`. A real event log persists the kernel's emitted stream so any consumer (driver, UI, test, time-travel debugger) can replay deterministically.
3. **The `metadata.rts.event_log[]` in-tree array (`metadata_writer.py:1686`) collects `agent_ref_move` events but is bounded by snapshot size, not history.** It's the right shape for *recent* events that ride along with snapshots; it is the wrong place for the full append-only log. Sidecaring the JSONL frees the in-tree array from being the persistence channel.

L2 is the slice level: persist + replay. L3 (full event-sourcing where the JSON tree is *only* derived) is V3 territory and out of scope here.

---

## §2. Goals and non-goals

### Goals

- One new module `vendor/LLMKernel/llm_kernel/event_log.py` (~200 LoC) that exposes `EventLogWriter` (append-only JSONL sink) and `EventLogReplayer` (load + project state).
- `MetadataWriter._build_envelope` → `dispatcher.emit` path (`metadata_writer.py:3499-3503`) gains a tee-call to the event-log writer when an event-log path is configured.
- On notebook open, the driver checks for `<notebook>.llmnb.events.jsonl`; if present and parseable, projects state from it (load latest snapshot envelope + replay subsequent events). If absent, falls back to today's behavior (load `metadata.rts` from the JSON tree).
- Replay is deterministic: same JSONL prefix → same in-memory state, every time. No agent processes spawn during replay.
- Operator-driven compaction: a `@checkpoint` line-magic forces a Family F `mode: "snapshot"` envelope to land as a checkpoint in the JSONL; auto on save / shutdown.
- Schema-version reads: each envelope's `rfc_version` field (already present per `run_envelope.py:53`) is the version branch point. Major mismatch on load → reject; minor mismatch → warn + proceed.

### Non-goals (V1 — explicit)

- **L3 full event-sourcing.** The JSON tree (`.llmnb`) remains the file format. The JSONL is a *peer/sidecar*. `vscode.NotebookEdit` integration depends on the JSON tree; breaking that is V3+.
- **Magic-as-sole-IR.** Routing every UI affordance (move cell, delete cell, click run) through a magic representation is a V2+ tightening. See §10.
- **Multi-driver-write coordination.** The kernel is the single logical writer of envelopes (already true today; see §4). Multi-writer-with-CRDT is V2+.
- **In-flight snapshot patches as separate persisted events.** V1.5+ Family F `mode: "patch"` envelopes (per `wire/families.py:85`) are transient deltas on the wire. The persisted log carries only `mode: "snapshot"` checkpoint envelopes; patches are a wire-side optimization and replay reconstructs from snapshots + Family A/D events between them.
- **OTLP spans persisted to the event log.** Family A `run.start | run.event | run.complete` (the OTLP run lifecycle per `families.py:31`) goes through a different observability sink already; persisting it twice is out of scope. (The closed span lands in `metadata.rts.event_log.runs[]` via `_build_event_log` at `metadata_writer.py:3632`; replay reconstructs it from the snapshot envelope.)
- **History truncation as automatic policy.** Truncating the JSONL prefix is operator-initiated only — history is valuable; only the operator decides when to discard.

---

## §3. Concrete work

### §3.A File format

- Sidecar path: `<notebook>.llmnb.events.jsonl` next to `<notebook>.llmnb` (e.g., `experiment.llmnb` ↔ `experiment.llmnb.events.jsonl`).
- Operator-overridable: `metadata.rts.config.event_log_path` (a string path, absolute or relative to the notebook). If unset, the default sidecar location applies. If `None` (explicit), the event log is disabled for that notebook.
- One JSON-serialized envelope per line. UTF-8. No compression. Append-only during a session.
- Each line is the **outbound thin v2 envelope** (the same shape that crosses the wire, per `custom_messages.py:371` `_to_thin_v2`). The internal envelope's `rfc_version` is preserved on the thin form for replay branching; absent fields are tolerated by future readers.

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

On notebook open:

1. Driver checks for `<notebook>.llmnb.events.jsonl`.
2. If absent: fall back to current behavior — read `metadata.rts` from the JSON tree (`executor.py:461`).
3. If present: parse the JSONL, scan from EOF backward for the last `notebook.metadata` envelope with `payload.mode == "snapshot"` (the most-recent checkpoint).
4. Set `working_rts := snapshot.payload.snapshot` (matches today's apply path at `executor.py:584` and `executor.py:691`).
5. Re-apply each envelope **after** that checkpoint through the same dispatcher routing the live path uses, but in **read-only mode** (see §3.D).
6. Resume: any subsequent operator action emits a new envelope appended to the log.

Determinism contract: same JSONL prefix → byte-identical `working_rts`, every time. Tests assert this (§5).

### §3.D Replay sandbox

Replay must work without spawning agents (UI undo, time-travel, regression tests):

- The replayer instantiates the kernel-side dispatcher in **read-only mode**: a flag on `boot_minimal_kernel(...)` (`llm_client/boot.py:1`) that wires `MetadataWriter` but does NOT instantiate `AgentSupervisor`. The supervisor is the only kernel component that spawns agent processes; gating it is sufficient.
- `MetadataWriter` consumes intent envelopes the same way it does live (`metadata_writer.py:1649` `_handle_record_event` and siblings); state mutations are deterministic.
- Operator-typed re-execution is the only path that re-spawns agents — that's a *new* envelope appended to the log, not a replayed one. Replay never reaches that branch.

### §3.E Persistence path: kernel-side

Concrete decision: **kernel-side**. The kernel already has the writer that emits envelopes (`CustomMessageDispatcher.emit` at `custom_messages.py:346`); it just tees the same emission stream to the JSONL file.

- `EventLogWriter` is created during kernel boot when `metadata.rts.config.event_log_path` is set (or a default is applied). It exposes `append(envelope: dict) -> None` and `close() -> None`.
- The dispatcher's `emit(...)` call is teed: after `_to_thin_v2` and before (or in parallel with) the wire send, the thin envelope is also `event_log.append`-ed.
- For inbound traffic the kernel sees on `register_handler` (`custom_messages.py:386`), the handler-entry path also tees the inbound thin envelope so the log captures both directions.
- Append on each emit; flush on `kernel.shutdown_request` and on the explicit `mode: "snapshot"` `trigger == "save"` emission (`metadata_writer.py:3490`).

Drivers see the same wire stream they always did — the tee is invisible to them.

### §3.F Compaction

Policy:

- On save (operator triggers `mode: "snapshot"` `trigger: "save"` per RFC-005 §"Snapshot triggers"; today emitted by `MetadataWriter.snapshot()` at `metadata_writer.py:3490`), the JSONL also receives that snapshot envelope as the LAST line. Subsequent loads find this checkpoint first and skip preceding lines.
- On clean shutdown (`MetadataWriter.stop(emit_final=True)` at `metadata_writer.py:3529`) the same path runs.
- Operator-driven explicit checkpoint: a `@checkpoint` line-magic forces an out-of-cycle snapshot envelope. (Magic-vocabulary precedent: PLAN-S5.0 §3.6 already routes line-magics through `cell_edit` → kernel; `@checkpoint` lands as an `operator.action` whose handler calls `MetadataWriter.snapshot(trigger="explicit")`.)
- Truncate-prefix is operator-initiated: a `@truncate` line-magic OR a CLI flag (`llmnb event-log truncate <notebook>`). Reason: history is valuable; only the operator discards.

### §3.G Schema versioning

- Every envelope already carries `rfc_version` (`run_envelope.py:53`, `run_envelope.py:80`). Replay code reads it and branches if needed.
- `WIRE_VERSION = "1.0.0"` (`vendor/LLMKernel/llm_kernel/wire/version.py:3`). Major mismatch on a JSONL-load → reject with a structured error (matches the runtime [wire-handshake](../atoms/protocols/wire-handshake.md) major-mismatch behavior).
- Minor mismatch → warn + proceed (newer minor must be backward-compatible per RFC-006 v2.1.0).
- Bump procedure: when wire goes 1.x → 2.0, the replayer needs a migration shim (read 1.x lines, transform to 2.x in-memory). Document the discipline; don't implement migrations until the bump happens.

### §3.H Concrete files

| Path | Edit nature | LoC |
|---|---|---|
| **NEW** `vendor/LLMKernel/llm_kernel/event_log.py` | `EventLogWriter` + `EventLogReplayer` | ~200 |
| `vendor/LLMKernel/llm_kernel/custom_messages.py` | tee in `emit()` (`:346`) and inbound handler entry (`:386`) | ~30 |
| `vendor/LLMKernel/llm_kernel/metadata_writer.py` | flush on `snapshot()` and `stop()` | ~10 |
| `llm_client/boot.py` | accept `event_log_path` kwarg; pass to dispatcher | ~15 |
| `llm_client/executor.py` | check sidecar JSONL on open; project state via replayer | ~40 |
| **NEW** `vendor/LLMKernel/tests/test_event_log_replay.py` | replay determinism | new |
| **NEW** `vendor/LLMKernel/tests/test_event_log_round_trip.py` | round-trip tests | new |
| **NEW** `vendor/LLMKernel/tests/test_magic_fixture_replay.py` | `.magic` → events → tree pipeline | new |

---

## §4. Interface contracts (locked before dispatch)

### `llm_kernel.event_log` (NEW)

```python
class EventLogWriter:
    def __init__(self, path: Path, *, fsync_on_close: bool = True) -> None: ...
    def append(self, envelope: dict) -> None: ...
    def close(self) -> None: ...

class EventLogReplayer:
    def __init__(self, path: Path) -> None: ...
    def latest_snapshot(self) -> dict | None:
        """Return the most-recent `notebook.metadata` snapshot envelope,
        or None if no snapshot is present in the log."""
    def envelopes_after_snapshot(self) -> Iterator[dict]:
        """Yield the envelopes that follow the latest snapshot, in order."""
    def project_state(
        self, *, dispatcher
    ) -> dict:
        """Load latest snapshot, replay subsequent envelopes through the
        read-only dispatcher, return the resulting `metadata.rts`."""
```

### `llm_client.boot.boot_minimal_kernel` (extended)

```python
def boot_minimal_kernel(
    *,
    proxy: Literal["litellm", "passthrough", "stub"] = "litellm",
    work_dir: Path | None = None,
    transport: Literal["pty", "unix", "tcp"] = "pty",
    bind: str | None = None,
    auth_token: str | None = None,
    event_log_path: Path | None = None,    # NEW
    read_only: bool = False,                # NEW — replay sandbox flag
) -> KernelConnection: ...
```

When `read_only=True`: dispatcher + writer are wired but `AgentSupervisor` is not instantiated. Replay path uses this.

### `llm_client.executor.run_notebook` — load-from-jsonl

`run_notebook` checks for the sidecar JSONL before constructing the hydrate envelope. If found, the replayer projects state and the projected `metadata.rts` is hydrated instead of the JSON tree's `metadata.rts`. The resulting wire trace is identical to today's path from the kernel's point of view.

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

1. **Tee-on-emit doubles the I/O on the hot path.** If the JSONL writer fsyncs per-append, the kernel emit cadence drops. Mitigation: `EventLogWriter.append` does a buffered write; explicit flush only on `snapshot()` and `stop()`. Crash-during-run loses the tail of the log between checkpoints — operator-acceptable trade for V1.

2. **The thin v2 envelope drops `rfc_version` on egress** (per RFC-006 §3 flattening, applied in `_to_thin_v2`). Replay needs the version. Resolution: the JSONL persists the **internal v1 envelope** (`run_envelope.py:88` `make_envelope` shape), not the thin v2. Receivers reading the JSONL get the version field; the wire send still carries the thin form. This is a one-line decision in `EventLogWriter.append` (capture pre-thin envelope).

3. **Family F snapshot envelopes are large.** A 10-cell notebook's snapshot can be tens of KB; emitting one per save bloats the JSONL. Mitigation: blob extraction already runs (`metadata_writer.py:3619`), so large outputs are `$blob:sha256:…` refs, not inline bytes — confirmed at `metadata_writer.py:236-249`. Snapshot size is bounded by the cell count, not the output volume.

4. **The driver and the kernel disagree on which path is canonical (JSON tree vs JSONL).** If both exist on disk and disagree, which wins? V1 rule: the JSONL is canonical when present; the JSON tree's `metadata.rts` is treated as a stale snapshot. On save, the kernel writes both: a fresh snapshot envelope to the JSONL AND the JSON tree's `metadata.rts` from the same snapshot. Drift between them is impossible at write time; only manual edits to the JSON tree create drift, and the JSONL still wins on next open.

5. **Truncation is dangerous.** Operator-initiated truncate-prefix discards history. Mitigation: `@truncate` and the CLI emit a confirmation prompt; truncation rotates the file (`<notebook>.llmnb.events.jsonl` → `<notebook>.llmnb.events.jsonl.archive-<timestamp>`) rather than deleting.

6. **In-tree `metadata.rts.event_log[]` overlaps the sidecar.** Today, `agent_ref_move` events land in the in-tree array (`metadata_writer.py:1686`). After this slice, those events ALSO appear in the JSONL (as the kernel's emit stream contains them). Resolution: keep both for V1.5; the in-tree array stays the recent-events query surface, the JSONL is the durable log. V2+ may collapse the in-tree array into a derived view.

If any risk surfaces an RFC ambiguity, the implementing agent flags it (Engineering Guide §8.5 — flag, don't guess); operator ratifies an erratum before implementation continues.

---

## §7. Atoms touched

- **NEW**: `docs/atoms/concepts/event-log.md` (the JSONL substrate concept; the thing this plan introduces).
- **NEW**: `docs/atoms/contracts/event-log-writer.md` and `docs/atoms/contracts/event-log-replayer.md` (the kernel-side contracts).
- **MOD**: `docs/atoms/protocols/family-f-notebook-metadata.md` — note that snapshot envelopes are the JSONL load-checkpoint.
- **MOD**: `docs/atoms/discipline/wire-as-public-api.md` — note that the wire stream is now also the persistence channel.
- **MOD**: `docs/atoms/protocols/family-d-event-log.md` — point out that the family name reflects the substrate this plan ships (the family was named for this purpose; the JSONL is its persistence form).

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
2. A 10-cell live-mode run produces a `<notebook>.llmnb.events.jsonl` whose latest snapshot's `payload.snapshot` byte-equals the post-run `metadata.rts`.
3. Closing and reopening that notebook (without VS Code; via `llmnb execute --resume`) projects the same `metadata.rts` from the JSONL — verified via `assert working_rts == post_run_rts`.
4. Replay determinism: 10 consecutive replays of the same JSONL produce byte-identical projections.
5. `read_only=True` boot path verified by test: `AgentSupervisor` is never instantiated; no agent processes spawn.
6. Major-version mismatch on a fixture JSONL is rejected; minor-version mismatch warns + proceeds.
7. Operator approves — typically as a tag (`v1.6-event-log-substrate`) or a commit message marker.

---

## §10. V2+ stretch — magic-as-sole-IR

L2 alone gets the JSONL and makes replay deterministic, but it does NOT enforce that all mutations come through magic-parsing. A V2+ tightening would route every UI affordance (move cell, delete cell, click run, drag-and-drop) through a magic representation so the UI becomes a projection of magic + event history.

Cost: every UI affordance needs a magic form. Some require new vocabulary (e.g., `@@move c_3 before c_2`, `@@delete c_5`). The cell-magic vocabulary (PLAN-S5.0) added the textual surface; magic-as-sole-IR adds the structural-mutation surface.

Benefit: uniform event grammar — every state change has a single textual form. UI actions become operator-reproducible: an operator can read the JSONL, see exactly what happened, and replay it by typing the magic.

**Out of scope for L2.** This plan delivers the persistence + replay substrate; magic-as-sole-IR is a separate discipline-level decision that builds on top.
