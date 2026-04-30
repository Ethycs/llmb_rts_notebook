"""
llm_client.executor — headless notebook executor (PLAN-S5.0.3 §6.2 / §9).

Public API:
    run_notebook(path, *, output, mode, replay_recording, record_to,
                 unattended) -> ExecutionResult

Three execution modes per PLAN §6.2:
    stub    — deterministic canned responses from llm_client.stubs;
              no API keys required; primary tests-as-notebooks mode.
    live    — real kernel boot + LiteLLM/Anthropic-passthrough proxy.
              V1 NOTE: live-mode end-to-end requires the async recv
              path scheduled in S5.0.3d. The V1 implementation here
              boots a real kernel and ships the hydrate envelope but
              defers full agent-spawn drive to S5.0.3d.
    replay  — read a `.replay.jsonl` recording captured from a prior
              live run and reconstruct the ExecutionResult deterministically.

`unattended` flag (PLAN §10 risk #7):
    Default False. If False AND the notebook contains any
    escalate-bearing cells (any cell whose magic resolves to a
    request_approval surface), run_notebook raises
    EscalationRequiresOperatorError before booting. Operators must
    pass unattended=True to acknowledge that all approvals will be
    auto-rejected.

Lint contract: only llm_kernel.wire and llm_kernel.cell_text imports.
"""

from __future__ import annotations

import dataclasses
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

from llm_kernel.wire import WIRE_VERSION  # noqa: F401  (re-exported in result)

from llm_client.notebook import (
    detect_format,
    llmnb_to_magic,
    magic_to_llmnb,
)
from llm_client.stubs import lookup_stub, stub_key


__all__ = [
    "ExecutionResult",
    "EscalationRequiresOperatorError",
    "ReplayMismatchError",
    "run_notebook",
]


# ---------------------------------------------------------------------------
# Data classes + errors
# ---------------------------------------------------------------------------


class EscalationRequiresOperatorError(RuntimeError):
    """Raised when a notebook contains escalate-bearing cells but
    ``unattended=False`` (PLAN §10 risk #7).

    Operator either runs interactively (unsupported in V1 — there is
    no operator-attached executor yet) or passes ``unattended=True``
    to acknowledge that all ``request_approval`` calls auto-reject.
    """


class ReplayMismatchError(RuntimeError):
    """Raised when a replay recording does not match the notebook
    being executed (cell count differs, or a key event in the
    recording references a cell that no longer exists)."""


@dataclass
class ExecutionResult:
    """The result of ``run_notebook(...)``.

    Fields per PLAN §9 interface contract.
    """

    notebook_path: Path
    cells_executed: int
    cells_succeeded: int
    cells_failed: int
    final_state: dict
    errors: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


_ESCALATE_MARKERS = (
    "@@escalate",      # speculative future kind
    "request_approval", # body-level call (heuristic)
)


def _has_escalate(rts_cells: dict[str, dict[str, Any]]) -> bool:
    """Detect escalate-bearing cells (PLAN §10 risk #7).

    Heuristic: any cell whose ``text`` contains an escalate marker.
    The marker set is intentionally conservative — operators can rename
    by adding to ``_ESCALATE_MARKERS``. False-positives (the word
    appearing in prose) are acceptable; ``unattended`` is opt-in so a
    spurious raise is recoverable with one flag.
    """
    for record in rts_cells.values():
        if not isinstance(record, dict):
            continue
        text = record.get("text", "")
        if not isinstance(text, str):
            continue
        lower = text.lower()
        for marker in _ESCALATE_MARKERS:
            if marker in lower:
                return True
    return False


def _load_notebook(path: Path) -> dict:
    """Parse a notebook from disk into a dict (.llmnb shape).

    Format-detection per llm_client.notebook.detect_format. Magic-text
    inputs are converted via magic_to_llmnb on load.
    """
    fmt = detect_format(path)
    text = path.read_text(encoding="utf-8")
    if fmt == "llmnb":
        return json.loads(text)
    if fmt == "ipynb":
        # Convert ipynb to llmnb on load. Imports are warned at the
        # CLI layer; this function is pure (no print).
        from llm_client.notebook import ipynb_to_llmnb
        return ipynb_to_llmnb(json.loads(text))
    if fmt == "magic":
        return magic_to_llmnb(text)
    raise ValueError(f"Unable to detect notebook format for {path}")


def _write_notebook(notebook: dict, target: Path) -> None:
    """Write a notebook dict back to disk in the appropriate format."""
    suffix = target.suffix.lower()
    if suffix == ".magic":
        target.write_text(llmnb_to_magic(notebook), encoding="utf-8")
        return
    # Default: JSON-serialized .llmnb (matches extension/serializer.ts).
    target.write_text(
        json.dumps(notebook, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _stamp_cell_response(
    response: dict[str, Any],
    cell_id: str,
    ordinal: int,
) -> dict[str, Any]:
    """Stamp a deterministic ``cell_id`` and ``ordinal`` into a stub response.

    Returns a deep-ish copy so the registry entry is not mutated.
    """
    out = json.loads(json.dumps(response))
    payload = out.setdefault("payload", {})
    payload["cell_id"] = cell_id
    payload["ordinal"] = ordinal
    return out


# ---------------------------------------------------------------------------
# Stub-mode driver
# ---------------------------------------------------------------------------


def _run_stub_mode(
    notebook: dict,
    *,
    record_to: Optional[Path],
) -> tuple[dict, list[dict], list[dict]]:
    """Execute every cell using the canned-response stub registry.

    Returns ``(updated_notebook, succeeded_envelopes, failed_envelopes)``
    so the caller can populate ExecutionResult.

    Determinism: the stub registry is keyed by ``stub_key(kind, text,
    agent_id)``; identical inputs yield identical envelopes. Cell ids
    are read from the input notebook (operator-authored) and stamped
    into responses; if absent, deterministic ``cell-<n>`` ids are used.
    """
    rts = notebook.get("metadata", {}).get("rts", {})
    cells = rts.get("cells", {}) or {}
    layout = rts.get("layout", {}) or {}

    succeeded: list[dict] = []
    failed: list[dict] = []
    sent_received: list[dict] = []  # for record_to

    # Walk the layout in order so determinism doesn't depend on dict
    # iteration semantics across CPython versions (it's stable in 3.7+
    # but we should not rely on that for byte-identity contracts).
    from llm_client.notebook import _layout_walk_ids
    ordered_ids = _layout_walk_ids(layout.get("tree"))
    for cid in cells:
        if cid not in ordered_ids:
            ordered_ids.append(cid)

    for ordinal, cid in enumerate(ordered_ids):
        record = cells.get(cid)
        if not isinstance(record, dict):
            continue
        text = record.get("text", "") or ""
        kind = record.get("kind") or "agent"
        agent = record.get("bound_agent_id")
        sent = {
            "type": "operator.action",
            "payload": {
                "kind": "run.start",
                "cell_id": cid,
                "ordinal": ordinal,
                "cell_kind": kind,
                "agent_id": agent,
                "stub_key": stub_key(kind, text, agent),
            },
        }
        # Stub lookup. The registry returns DEFAULT_NOOP_RESPONSE when
        # there's no canned hit — which is success-shaped so unmatched
        # cells degrade to a deterministic ack. Tests targeting failure
        # behavior should register an explicit error-shaped stub.
        canned = lookup_stub(kind, text, agent)
        received = _stamp_cell_response(canned, cid, ordinal)

        if record_to is not None:
            sent_received.append({"sent": sent, "received": received})

        # Determine success vs failure from the response payload.
        payload = received.get("payload") or {}
        status = payload.get("status", "ok")
        if status == "ok":
            succeeded.append(received)
            # Persist outputs back into the cell record (drops outputs
            # that can't round-trip through magic-text but preserves
            # them in the JSON snapshot).
            outputs = payload.get("outputs") or []
            if isinstance(outputs, list):
                record["outputs"] = outputs
        else:
            failed.append(received)

    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return notebook, succeeded, failed


# ---------------------------------------------------------------------------
# Replay-mode driver
# ---------------------------------------------------------------------------


def _run_replay_mode(
    notebook: dict,
    *,
    replay_recording: Path,
) -> tuple[dict, list[dict], list[dict]]:
    """Reconstruct ExecutionResult from a `.replay.jsonl` recording.

    Determinism contract (this slice's choice — see report):
    - The recording is the source of truth for cell outputs and status.
    - The recording is matched to the notebook by (cell_id, ordinal)
      pair from the recorded ``sent.payload``. A drift in cell_id or
      ordinal raises ReplayMismatchError.
    - Timestamps + run_ids in the recording are preserved verbatim
      (we record verbatim, replay verbatim) — ipoperator-side wall-clock
      tests must use the recorded timestamps, not the replay-time clock.
    """
    if not replay_recording.exists():
        raise FileNotFoundError(f"replay recording not found: {replay_recording}")

    entries: list[dict[str, Any]] = []
    with replay_recording.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entries.append(json.loads(line))

    rts = notebook.get("metadata", {}).get("rts", {})
    cells = rts.get("cells", {}) or {}
    layout = rts.get("layout", {}) or {}
    from llm_client.notebook import _layout_walk_ids
    ordered_ids = _layout_walk_ids(layout.get("tree"))
    for cid in cells:
        if cid not in ordered_ids:
            ordered_ids.append(cid)

    if len(entries) != len(ordered_ids):
        raise ReplayMismatchError(
            f"replay recording has {len(entries)} entries but notebook has "
            f"{len(ordered_ids)} cells — recording does not match"
        )

    succeeded: list[dict] = []
    failed: list[dict] = []
    for ordinal, (cid, entry) in enumerate(zip(ordered_ids, entries)):
        sent = entry.get("sent", {})
        received = entry.get("received", {})
        sent_payload = sent.get("payload") or {}
        rec_cid = sent_payload.get("cell_id")
        if rec_cid is not None and rec_cid != cid:
            raise ReplayMismatchError(
                f"replay entry {ordinal}: recorded cell_id={rec_cid!r} "
                f"does not match notebook cell_id={cid!r}"
            )
        payload = received.get("payload") or {}
        status = payload.get("status", "ok")
        if status == "ok":
            succeeded.append(received)
            outputs = payload.get("outputs") or []
            if isinstance(outputs, list):
                record = cells.get(cid)
                if isinstance(record, dict):
                    record["outputs"] = outputs
        else:
            failed.append(received)

    return notebook, succeeded, failed


# ---------------------------------------------------------------------------
# Live-mode driver (V1 minimal)
# ---------------------------------------------------------------------------


def _derive_cell_envelope(
    cell_id: str,
    record: dict[str, Any],
    *,
    session_id: str,
    ordinal: int,
) -> Optional[dict[str, Any]]:
    """Derive a wire envelope for a cell, or ``None`` for no-op cell-kinds.

    PLAN-S5.0.3.1 §3.B — per-cell envelope mapping (LOCKED).

    Returns ``None`` for ``markdown`` / ``scratch`` / ``native`` / unknown
    cell kinds (no envelope shipped; the cell is recorded as a structural
    no-op success). Returns a Family A ``operator.action`` envelope for
    ``agent`` / ``spawn`` cells per ``protocols/operator-action.md``.
    """
    kind = (record.get("kind") or "").lower()
    text = record.get("text", "") or ""
    agent_id = record.get("bound_agent_id")
    request_id = f"{session_id}:{ordinal}"

    if kind == "spawn":
        # ``@@spawn <id>`` cell — body may carry task description.
        # Extract a coarse ``task`` from the body (first non-empty line),
        # mirroring the extension's cell-magic dispatcher behavior.
        task = ""
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("@@"):
                task = stripped
                break
        return {
            "type": "operator.action",
            "request_id": request_id,
            "payload": {
                "action_type": "agent_spawn",
                "parameters": {
                    "agent_id": agent_id,
                    "task": task,
                    "cell_id": cell_id,
                },
                "originating_cell_id": cell_id,
            },
        }

    if kind == "agent" and agent_id:
        # Strip the leading ``@@agent <id>`` directive line, if present.
        body_lines = text.splitlines()
        if body_lines and body_lines[0].strip().startswith("@@agent"):
            body_lines = body_lines[1:]
        body = "\n".join(body_lines).strip() or text.strip()
        return {
            "type": "operator.action",
            "request_id": request_id,
            "payload": {
                "action_type": "agent_continue",
                "intent_kind": "send_user_turn",
                "parameters": {
                    "agent_id": agent_id,
                    "text": body,
                    "cell_id": cell_id,
                },
                "originating_cell_id": cell_id,
            },
        }

    # markdown, scratch, native, or unknown -> no envelope (W4 tolerant).
    return None


def _run_live_mode(
    notebook: dict,
    path: Path,
    *,
    record_to: Optional[Path],
    unattended: bool,
    cell_timeout: float = 60.0,
    quiescence_window: float = 2.0,
    total_timeout: float = 600.0,
    connection: Optional[Any] = None,
) -> tuple[dict, list[dict], list[dict]]:
    """V1 live-mode driver — per-cell ship-then-drain with quiescence.

    PLAN-S5.0.3.1 §3 (LOCKED). Boots a kernel via TCP-on-loopback by
    default (Ambiguity 2 resolution: in-process recv has no event queue;
    TCP loopback is the minimum-LoC path that keeps the lint boundary
    intact). Tests inject a pre-built ``connection`` to bypass the boot.

    Completion criterion (Ambiguity 1 resolution): the kernel does NOT
    currently emit ``runtime_status: idle`` in Family F snapshots
    (verified against ``vendor/LLMKernel/llm_kernel/agent_supervisor.py``
    and ``metadata_writer.py`` — the only ``runtime_status`` references
    are read-only resume gates). Live-mode therefore uses **quiescence-
    only** completion: a cell is done when either a correlated
    ``run.complete`` arrives, OR ``quiescence_window`` of empty recv
    ticks elapses, OR ``cell_timeout`` is exceeded.
    """
    # Lazy import to keep the lint surface narrow for unit tests that
    # never reach the boot path.
    if connection is None:
        # TCP-on-loopback path. Spin up `python -m llm_kernel serve`
        # as a subprocess with `--proxy none` and connect via the
        # already-shipped TCP transport. This keeps the driver/kernel
        # lint boundary intact (no llm_kernel internals imported) and
        # mirrors tests/test_tcp_transport.py.
        conn = _boot_tcp_loopback_kernel()
        owns_connection = True
    else:
        conn = connection
        owns_connection = False

    sent_received: list[dict] = []
    succeeded: list[dict] = []
    failed: list[dict] = []
    interrupted = False

    try:
        # Initial Family F hydrate — same as V1's prior shape.
        rts = notebook.get("metadata", {}).get("rts", {}) or {}
        hydrate_env = {
            "type": "notebook.metadata",
            "payload": {
                "mode": "hydrate",
                "snapshot": rts,
                "trigger": "executor.live",
            },
        }
        try:
            conn.send(hydrate_env)
        except Exception as exc:  # noqa: BLE001 — surface as transport-lost
            return _live_transport_lost(
                notebook, sent_received, str(exc), record_to,
            )

        cells = rts.get("cells", {}) or {}
        layout = rts.get("layout", {}) or {}
        from llm_client.notebook import _layout_walk_ids
        ordered_ids = _layout_walk_ids(layout.get("tree"))
        for cid in cells:
            if cid not in ordered_ids:
                ordered_ids.append(cid)

        working_rts: dict[str, Any] = rts
        session_id = getattr(conn, "session_id", "live") or "live"
        run_deadline = time.monotonic() + total_timeout

        for ordinal, cid in enumerate(ordered_ids):
            if time.monotonic() > run_deadline:
                # Total run timeout exceeded — fail-fast remaining cells.
                failed.append(_synthetic_k_envelope(
                    cid, "K_CELL_TIMEOUT",
                    f"total run timeout ({total_timeout}s) exceeded",
                ))
                continue

            record = cells.get(cid)
            if not isinstance(record, dict):
                continue

            envelope = _derive_cell_envelope(
                cid, record, session_id=session_id, ordinal=ordinal,
            )
            if envelope is None:
                # No-op cell-kind (markdown / scratch / native / unknown).
                # Counted as succeeded with empty outputs to match stub-
                # mode's degrade-to-noop behavior.
                synth = {
                    "type": "operator.action",
                    "payload": {
                        "kind": "run.complete",
                        "status": "ok",
                        "cell_id": cid,
                        "ordinal": ordinal,
                        "outputs": [],
                    },
                }
                succeeded.append(synth)
                if record_to is not None:
                    sent_received.append({"sent": None, "received": synth})
                continue

            # Ship the envelope.
            try:
                conn.send(envelope)
            except Exception as exc:  # noqa: BLE001
                failed.append(_synthetic_k_envelope(
                    cid, "K_TRANSPORT_LOST", str(exc),
                ))
                if record_to is not None:
                    sent_received.append({
                        "sent": envelope,
                        "received": failed[-1],
                    })
                # Fail-fast remaining cells with the same code.
                for remaining in ordered_ids[ordinal + 1:]:
                    failed.append(_synthetic_k_envelope(
                        remaining, "K_TRANSPORT_LOST", "connection closed",
                    ))
                break

            # Per-cell ship-then-drain loop.
            cell_deadline = time.monotonic() + cell_timeout
            quiescence_start: Optional[float] = None
            cell_completed = False
            received_for_cell: Optional[dict] = None

            while time.monotonic() < cell_deadline:
                try:
                    reply = conn.recv(timeout=0.1)
                except KeyboardInterrupt:
                    interrupted = True
                    break
                except Exception as exc:  # noqa: BLE001
                    failed.append(_synthetic_k_envelope(
                        cid, "K_TRANSPORT_LOST", str(exc),
                    ))
                    cell_completed = True
                    break

                if not reply:
                    if quiescence_start is None:
                        quiescence_start = time.monotonic()
                    elif time.monotonic() - quiescence_start >= quiescence_window:
                        # Quiescence-only completion (Ambiguity 1).
                        cell_completed = True
                        break
                    continue

                # Got an envelope — reset quiescence.
                quiescence_start = None

                msg_type = (
                    reply.get("message_type")
                    or reply.get("type", "")
                )
                payload = reply.get("payload") or {}

                if msg_type == "notebook.metadata":
                    snap = payload.get("snapshot")
                    if isinstance(snap, dict):
                        # PLAN §3.C: replace working state, no patch mode.
                        working_rts = snap

                # Correlate by request_id for clean per-cell completion.
                reply_corr = (
                    reply.get("correlation_id")
                    or reply.get("request_id")
                    or payload.get("correlation_id")
                    or payload.get("request_id")
                )
                if reply_corr == envelope["request_id"]:
                    received_for_cell = reply
                    if payload.get("k_code"):
                        failed.append(reply)
                    else:
                        succeeded.append(reply)
                    cell_completed = True
                    break

                # K-class envelope keyed on cell_id (no correlation_id).
                if (
                    payload.get("k_code")
                    and payload.get("cell_id") == cid
                ):
                    received_for_cell = reply
                    failed.append(reply)
                    cell_completed = True
                    break

            if interrupted:
                if record_to is not None:
                    sent_received.append({
                        "sent": envelope,
                        "received": received_for_cell,
                    })
                break

            if not cell_completed:
                # Cell-timeout exceeded.
                fail_env = _synthetic_k_envelope(
                    cid, "K_CELL_TIMEOUT",
                    f"cell exceeded {cell_timeout}s budget",
                )
                failed.append(fail_env)
                received_for_cell = fail_env
            elif received_for_cell is None:
                # Quiescence path — synthesize a success record so
                # record_to has something to log; uses working_rts
                # outputs for the cell if present.
                cell_outputs: list[Any] = []
                cell_record = working_rts.get("cells", {}).get(cid)
                if isinstance(cell_record, dict):
                    co = cell_record.get("outputs") or []
                    if isinstance(co, list):
                        cell_outputs = co
                received_for_cell = {
                    "type": "operator.action",
                    "payload": {
                        "kind": "run.complete",
                        "status": "ok",
                        "cell_id": cid,
                        "ordinal": ordinal,
                        "outputs": cell_outputs,
                    },
                }
                succeeded.append(received_for_cell)

            if record_to is not None:
                sent_received.append({
                    "sent": envelope,
                    "received": received_for_cell,
                })

        # Trailing drain for `end_of_run` snapshot.
        if not interrupted:
            tail_deadline = time.monotonic() + quiescence_window
            while time.monotonic() < tail_deadline:
                try:
                    reply = conn.recv(timeout=0.1)
                except Exception:  # noqa: BLE001
                    break
                if not reply:
                    continue
                msg_type = (
                    reply.get("message_type")
                    or reply.get("type", "")
                )
                if msg_type == "notebook.metadata":
                    snap = (reply.get("payload") or {}).get("snapshot")
                    if isinstance(snap, dict):
                        working_rts = snap

        # Mirror per-cell outputs from working_rts back into the notebook.
        nb_cells = notebook.get("metadata", {}).get("rts", {}).get("cells", {})
        if isinstance(nb_cells, dict):
            for cid, working_record in (working_rts.get("cells") or {}).items():
                if not isinstance(working_record, dict):
                    continue
                nb_record = nb_cells.get(cid)
                if not isinstance(nb_record, dict):
                    continue
                outputs = working_record.get("outputs")
                if isinstance(outputs, list):
                    nb_record["outputs"] = outputs

        # Update the notebook's metadata.rts to the final working state
        # (mirrors stub mode's behavior of treating the result as the
        # source of truth for the on-disk file).
        notebook.setdefault("metadata", {})["rts"] = working_rts

    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

    if interrupted:
        raise KeyboardInterrupt()

    return notebook, succeeded, failed


def _synthetic_k_envelope(
    cell_id: str, k_code: str, message: str,
) -> dict[str, Any]:
    """Build a synthetic K-class failure envelope for the given cell."""
    return {
        "type": "operator.action",
        "payload": {
            "kind": "run.complete",
            "status": "error",
            "cell_id": cell_id,
            "k_code": k_code,
            "message": message,
            "outputs": [],
        },
    }


def _live_transport_lost(
    notebook: dict,
    sent_received: list[dict],
    message: str,
    record_to: Optional[Path],
) -> tuple[dict, list[dict], list[dict]]:
    """Bail-out path: the initial hydrate ship failed."""
    failed = [_synthetic_k_envelope("<hydrate>", "K_TRANSPORT_LOST", message)]
    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    return notebook, [], failed


def _boot_tcp_loopback_kernel():  # noqa: ANN202 — returns a duck-typed conn
    """Spawn ``python -m llm_kernel serve`` on 127.0.0.1:0 and connect.

    Returns a wrapper around the TCP ``KernelConnection`` that also
    cleans up the kernel subprocess on ``.close()``.

    Reuses the pattern from tests/test_tcp_transport.py — kernel-stderr
    is drained by a daemon thread so the pipe never back-pressures the
    serve loop. Auth token is randomly minted (never logged).
    """
    import os
    import re
    import secrets
    import subprocess
    import sys
    import threading
    import queue as _queue

    from llm_client.transport.tcp import connect as tcp_connect

    token = secrets.token_urlsafe(16)
    env = dict(os.environ)
    env["LLMNB_AUTH_TOKEN"] = token
    env.setdefault("PYTHONPATH", os.pathsep.join(sys.path))

    cmd = [
        sys.executable, "-u", "-m", "llm_kernel", "serve",
        "--transport", "tcp",
        "--bind", "127.0.0.1:0",
        "--auth-token-env", "LLMNB_AUTH_TOKEN",
        "--proxy", os.environ.get("LLMNB_LIVE_PROXY", "litellm"),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    listen_q: _queue.Queue[tuple[str, int]] = _queue.Queue(maxsize=1)
    seen_listen = threading.Event()
    listen_re = re.compile(r"listening on ([\d.]+):(\d+)")

    def _drain_stderr() -> None:
        try:
            while True:
                if proc.stderr is None:
                    return
                line = proc.stderr.readline()
                if not line:
                    return
                if not seen_listen.is_set():
                    match = listen_re.search(
                        line.decode("utf-8", errors="replace"),
                    )
                    if match:
                        listen_q.put((match.group(1), int(match.group(2))))
                        seen_listen.set()
        except Exception:
            return

    threading.Thread(target=_drain_stderr, daemon=True).start()

    try:
        host, port = listen_q.get(timeout=30.0)
    except _queue.Empty:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise RuntimeError(
            "kernel never reported a listening port within 30s"
        ) from None

    conn = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)

    # Wrap close() so we also tear down the subprocess.
    original_close = conn.close

    def _wrapped_close() -> None:
        try:
            original_close()
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

    conn.close = _wrapped_close  # type: ignore[method-assign]
    return conn


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_notebook(
    path: Path,
    *,
    output: Optional[Path] = None,
    mode: Literal["stub", "live", "replay"] = "live",
    replay_recording: Optional[Path] = None,
    record_to: Optional[Path] = None,
    unattended: bool = False,
    cell_timeout: float = 60.0,
    quiescence_window: float = 2.0,
    total_timeout: float = 600.0,
    connection: Optional[Any] = None,
) -> ExecutionResult:
    """Boot a kernel, drive every cell, write outputs back. PLAN-S5.0.3 §9.

    Parameters
    ----------
    path:
        Path to the notebook (auto-detected: .llmnb / .magic / .ipynb).
    output:
        Path to write the result. ``None`` overwrites the input.
    mode:
        ``"stub"`` (deterministic), ``"live"`` (real LiteLLM proxy),
        ``"replay"`` (from a recording).
    replay_recording:
        Path to a ``.replay.jsonl`` file. Required when ``mode="replay"``.
    record_to:
        When set in stub or live modes, write a ``.replay.jsonl``
        recording to this path. Useful for capturing a deterministic
        regression fixture from a one-off live run.
    unattended:
        Default ``False``. When ``False`` and the notebook contains
        escalate-bearing cells, raises EscalationRequiresOperatorError
        before booting. ``True`` proceeds with auto-rejected escalates.

    Returns
    -------
    ExecutionResult
        Counts + final state + per-cell errors.

    Raises
    ------
    EscalationRequiresOperatorError
        Notebook has an escalate cell and ``unattended=False``.
    FileNotFoundError
        ``mode="replay"`` and the recording is missing.
    """
    path = Path(path)
    notebook = _load_notebook(path)

    rts = notebook.get("metadata", {}).get("rts", {}) or {}
    cells = rts.get("cells") or {}
    if not isinstance(cells, dict):
        cells = {}

    # Escalate-cell guard (PLAN §10 risk #7).
    if not unattended and _has_escalate(cells):
        raise EscalationRequiresOperatorError(
            "Notebook contains escalate-bearing cells. Pass "
            "unattended=True to auto-reject all approvals (or run "
            "interactively, currently unsupported in V1)."
        )

    if mode == "stub":
        notebook, succeeded, failed = _run_stub_mode(
            notebook, record_to=record_to,
        )
    elif mode == "replay":
        if replay_recording is None:
            raise ValueError("mode='replay' requires replay_recording=...")
        notebook, succeeded, failed = _run_replay_mode(
            notebook, replay_recording=replay_recording,
        )
    elif mode == "live":
        notebook, succeeded, failed = _run_live_mode(
            notebook, path,
            record_to=record_to,
            unattended=unattended,
            cell_timeout=cell_timeout,
            quiescence_window=quiescence_window,
            total_timeout=total_timeout,
            connection=connection,
        )
    else:
        raise ValueError(f"unknown mode: {mode!r}")

    # Write back.
    target = output if output is not None else path
    _write_notebook(notebook, Path(target))

    final_rts = notebook.get("metadata", {}).get("rts", {}) or {}
    cells_count = len(cells)

    errors_list: list[dict] = []
    for env in failed:
        payload = env.get("payload") or {}
        errors_list.append({
            "cell_id": payload.get("cell_id"),
            "k_code": payload.get("k_code"),
            "message": payload.get("message") or payload.get("error"),
        })

    return ExecutionResult(
        notebook_path=Path(target),
        cells_executed=cells_count,
        cells_succeeded=len(succeeded),
        cells_failed=len(failed),
        final_state=final_rts,
        errors=errors_list,
    )
