"""tests/test_executor_live_quiescence.py — quiescence is per-cell, not per-socket.

Regression tests for the ``--quiescence-window`` collision with the
kernel's clock-driven traffic. On a facade-booted ``llmnb serve`` the
dispatcher's ``heartbeat.kernel`` (RFC-006 §7, every 5 s, mandatory) and
the metadata writer's ``trigger: "timer"`` autosave snapshots reach the
driver. The executor used to reset the quiescence clock on *any*
non-empty ``recv`` before looking at the envelope, so a window >= the
heartbeat period could never elapse and every agent cell ran to
``cell_timeout`` with a recording that showed nothing unusual.

All tests use a tick-driven fake ``KernelConnection`` (no kernel
subprocess, no wall-clock heartbeat threads): each ``recv`` is one tick
and clock-driven envelopes are emitted every N ticks. Timing assertions
carry generous margins and only distinguish "completed by quiescence"
from "ran to the cell budget".
"""

from __future__ import annotations

import argparse
import copy
import inspect
import json
import socket
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from llm_client import run_notebook
from llm_client.executor import _run_live_mode
from llm_client.cli.execute import add_arguments
from llm_client.transport.tcp import _TcpKernelConnection


# ---------------------------------------------------------------------------
# Tick-driven fake connection
# ---------------------------------------------------------------------------

def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _envelope(message_type: str, payload: dict[str, Any], *, correlation_id: Optional[str] = None) -> dict[str, Any]:
    """Internal v1 envelope exactly as ``llmnb serve`` forwards it."""
    return {
        "message_type": message_type,
        "direction": "kernel→extension",
        "correlation_id": correlation_id or str(uuid.uuid4()),
        "timestamp": _iso_now(),
        "rfc_version": "1.0.0",
        "payload": payload,
    }


def _heartbeat(tick: int) -> dict[str, Any]:
    return _envelope("heartbeat.kernel", {
        "kernel_state": "ok",
        "uptime_seconds": tick * 0.005,
        "last_run_timestamp": None,
    })


class _TickConnection:
    """Duck-typed ``KernelConnection`` driven by a recv tick counter.

    ``clock_every`` / ``clock_factory`` emit a clock-driven envelope every
    N ticks regardless of cell state (the heartbeat / autosave timer).
    ``on_action`` is called for every ``operator.action`` the executor
    ships and returns ``[(tick_offset, envelope), ...]`` to deliver.
    """

    session_id = "tick-session"
    wire_version = "0.0.0"

    def __init__(
        self,
        *,
        clock_every: int = 0,
        clock_factory: Optional[Callable[["_TickConnection", int], dict[str, Any]]] = None,
        on_action: Optional[Callable[["_TickConnection", dict[str, Any], int], list[tuple[int, dict[str, Any]]]]] = None,
        tick_sleep: float = 0.005,
    ) -> None:
        self.tick = 0
        self.sent: list[dict[str, Any]] = []
        self.action_ticks: list[int] = []
        self.delivered: list[dict[str, Any]] = []
        self.working_cells: dict[str, dict[str, Any]] = {}
        self._clock_every = clock_every
        self._clock_factory = clock_factory
        self._on_action = on_action
        self._tick_sleep = tick_sleep
        self._scheduled: list[tuple[int, dict[str, Any]]] = []
        self._closed = False

    def send(self, envelope: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("connection closed")
        self.sent.append(envelope)
        payload = envelope.get("payload") or {}
        if envelope.get("type") == "notebook.metadata" and payload.get("mode") == "hydrate":
            snap = payload.get("snapshot") or {}
            self.working_cells = copy.deepcopy(snap.get("cells") or {})
            return
        if envelope.get("type") == "operator.action":
            self.action_ticks.append(self.tick)
            if self._on_action is not None:
                for offset, env in self._on_action(self, envelope, self.tick):
                    self._scheduled.append((self.tick + offset, env))

    def recv(self, *, timeout: Optional[float] = None) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("connection closed")
        self.tick += 1
        if self._tick_sleep:
            time.sleep(self._tick_sleep)
        for idx, (due, env) in enumerate(self._scheduled):
            if due <= self.tick:
                self._scheduled.pop(idx)
                self.delivered.append(env)
                return env
        if self._clock_every and self._clock_factory is not None and self.tick % self._clock_every == 0:
            env = self._clock_factory(self, self.tick)
            self.delivered.append(env)
            return env
        return {}

    def pending(self) -> int:
        return len(self._scheduled)

    def close(self) -> None:
        self._closed = True


def _write_magic(tmp_path: Path, name: str = "nb.magic", *, two_agents: bool = False) -> Path:
    text = '@@spawn alpha task:"hello world"\n@@break\n'
    text += '@@spawn beta task:"second"\n' if two_agents else "@@scratch\nprint('hello from stub')\n"
    src = tmp_path / name
    src.write_text(text, encoding="utf-8")
    return src


def _run(tmp_path: Path, fake: _TickConnection, *, window: float, cell_timeout: float, two_agents: bool = False):
    src = _write_magic(tmp_path, two_agents=two_agents)
    out = tmp_path / "out.llmnb"
    rec = tmp_path / "rec.jsonl"
    t0 = time.monotonic()
    result = run_notebook(
        src, output=out, mode="live", connection=fake,
        cell_timeout=cell_timeout, quiescence_window=window, total_timeout=60.0,
        record_to=rec,
    )
    elapsed = time.monotonic() - t0
    entries = [json.loads(l) for l in rec.read_text(encoding="utf-8").splitlines() if l.strip()]
    nb = json.loads(out.read_text(encoding="utf-8"))
    return result, elapsed, entries, nb


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_heartbeats_do_not_extend_quiescence_window(tmp_path: Path) -> None:
    """heartbeat.kernel every 3 ticks (far faster than the window) must not
    keep the cell alive: it completes by quiescence, not by cell budget."""
    fake = _TickConnection(clock_every=3, clock_factory=lambda c, t: _heartbeat(t))
    result, elapsed, entries, _ = _run(tmp_path, fake, window=0.5, cell_timeout=4.0)
    assert result.cells_failed == 0, result.errors
    assert result.cells_succeeded == 2
    # window 0.5 s + trailing drain 0.5 s + slack; the budget path is >= 4.5 s.
    assert elapsed < 2.0, f"cell ran to its budget instead of quiescing ({elapsed:.2f}s)"
    assert entries[0]["completion_reason"] == "quiescence"
    assert any(e["message_type"] == "heartbeat.kernel" for e in fake.delivered)


def test_timer_snapshots_do_not_extend_window_but_update_working_state(tmp_path: Path) -> None:
    """A ``trigger: "timer"`` autosave snapshot is clock-driven: it is
    applied to the working state (and lands in the output notebook) but
    does not reset the quiescence clock."""
    def timer_snapshot(conn: _TickConnection, tick: int) -> dict[str, Any]:
        return _envelope("notebook.metadata", {
            "mode": "snapshot",
            "snapshot_version": tick,
            "trigger": "timer",
            "snapshot": {
                "schema_version": "1.0.0",
                "cells": copy.deepcopy(conn.working_cells),
                "zone": {"event_log": [_heartbeat(t) for t in range(0, tick, 3)]},
                "timer_marker": tick,
            },
        }, correlation_id=f"tick-session:{tick}")

    fake = _TickConnection(clock_every=3, clock_factory=timer_snapshot)
    result, elapsed, entries, nb = _run(tmp_path, fake, window=0.5, cell_timeout=4.0)
    assert result.cells_failed == 0, result.errors
    assert elapsed < 2.0, f"timer snapshots kept the cell alive ({elapsed:.2f}s)"
    rts = nb["metadata"]["rts"]
    assert rts.get("timer_marker"), "timer snapshot must still replace working_rts"
    assert set(rts["cells"]) == {"cell-0", "cell-1"}
    assert entries[0]["completion_reason"] == "quiescence"
    assert any(d["classification"] == "timer_snapshot" and d["extended_window"] is False
               for d in entries[0]["drained"])


def test_genuine_progress_extends_window(tmp_path: Path) -> None:
    """Family A run.event and end_of_run snapshots whose cell record changed
    are real progress: the cell must stay open until they stop."""
    progress_ticks = list(range(3, 121, 3))  # 40 envelopes over 120 ticks

    def on_action(conn: _TickConnection, envelope: dict[str, Any], tick: int):
        cid = envelope["payload"]["parameters"]["cell_id"]
        if cid != "cell-0":
            return []
        out: list[tuple[int, dict[str, Any]]] = []
        run_id = str(uuid.uuid4())
        for i, off in enumerate(progress_ticks):
            if i % 2 == 0:
                out.append((off, _envelope("run.event", {
                    "spanId": run_id,
                    "event": {"name": "tool.call", "attributes": {"i": i}},
                }, correlation_id=run_id)))
            else:
                cells = copy.deepcopy(conn.working_cells)
                rec = cells.setdefault(cid, {})
                rec["outputs"] = [{"output_type": "stream", "text": f"step {j}"} for j in range(i + 1)]
                conn.working_cells = cells
                out.append((off, _envelope("notebook.metadata", {
                    "mode": "snapshot", "snapshot_version": i, "trigger": "end_of_run",
                    "snapshot": {"schema_version": "1.0.0", "cells": copy.deepcopy(cells)},
                })))
        return out

    fake = _TickConnection(on_action=on_action)
    result, elapsed, entries, nb = _run(tmp_path, fake, window=0.3, cell_timeout=6.0, two_agents=True)
    assert result.cells_failed == 0, result.errors
    assert fake.pending() == 0, "cell-0 completed before its progress stopped"
    assert len(fake.action_ticks) == 2
    # cell-1's action is only shipped once cell-0 completed: that must be
    # after the last progress envelope (tick 120) plus the window.
    assert fake.action_ticks[1] - fake.action_ticks[0] >= 120
    assert entries[0]["completion_reason"] == "quiescence"
    assert entries[0]["window_extensions"] >= len(progress_ticks)
    assert len(nb["metadata"]["rts"]["cells"]["cell-0"]["outputs"]) == len(progress_ticks)


def test_correlated_reply_after_heartbeats_completes_cell(tmp_path: Path) -> None:
    """A correlated run.complete still completes the cell immediately, even
    when heartbeats are interleaved and the window is long."""
    def on_action(conn: _TickConnection, envelope: dict[str, Any], tick: int):
        cid = envelope["payload"]["parameters"]["cell_id"]
        return [(30, {
            "type": "operator.action",
            "request_id": envelope["request_id"],
            "payload": {"kind": "run.complete", "status": "ok", "cell_id": cid,
                        "outputs": [{"output_type": "stream", "text": "done"}]},
        })]

    fake = _TickConnection(clock_every=3, clock_factory=lambda c, t: _heartbeat(t), on_action=on_action)
    result, elapsed, entries, _ = _run(tmp_path, fake, window=1.0, cell_timeout=5.0)
    assert result.cells_failed == 0, result.errors
    assert elapsed < 3.0
    assert entries[0]["received"]["request_id"] == entries[0]["sent"]["request_id"]
    assert entries[0]["completion_reason"] == "correlated_reply"
    assert entries[0]["received"]["payload"]["outputs"][0]["text"] == "done"


def test_recording_explains_a_timeout(tmp_path: Path) -> None:
    """When a cell does run to its budget, the recording must say so and
    list every envelope that was drained meanwhile, with timestamps."""
    fake = _TickConnection(clock_every=3, clock_factory=lambda c, t: _heartbeat(t))
    # window longer than the budget: the only way out is the cell timeout.
    result, elapsed, entries, _ = _run(tmp_path, fake, window=5.0, cell_timeout=1.0)
    assert result.cells_failed == 1
    cell0 = entries[0]
    assert cell0["completion_reason"] == "cell_timeout"
    assert cell0["received"]["payload"]["k_code"] == "K_CELL_TIMEOUT"
    assert cell0["sent_at"] and cell0["completed_at"] and cell0["elapsed_s"] >= 1.0
    heartbeats = [d for d in cell0["drained"] if d["message_type"] == "heartbeat.kernel"]
    assert len(heartbeats) >= 10, "drained heartbeats must be visible in the record"
    for d in heartbeats:
        assert d["timestamp"] and d["received_at"]
        assert d["classification"] == "heartbeat"
        assert d["extended_window"] is False
    assert cell0["window_extensions"] == 0
    # No-op cells are recorded too, one line per cell (replay contract).
    assert len(entries) == 2
    assert entries[1]["completion_reason"] == "noop"


def test_transport_recv_still_returns_heartbeats() -> None:
    """The fix lives in the executor's classification, not in the transport:
    ``recv`` must still surface heartbeats (liveness is observable)."""
    a, b = socket.socketpair()
    try:
        conn = _TcpKernelConnection(
            "s", a, wire_version="1.0.0", accepted_capabilities=[], warnings=[],
        )
        hb = _heartbeat(1)
        b.sendall((json.dumps(hb) + "\n").encode("utf-8"))
        got = conn.recv(timeout=1.0)
        assert got.get("message_type") == "heartbeat.kernel"
        assert got["payload"]["kernel_state"] == "ok"
        assert conn.recv(timeout=0.05) == {}
    finally:
        a.close()
        b.close()


def test_live_mode_defaults_unchanged() -> None:
    """The fix is not a retune: defaults stay 2.0 s / 60.0 s everywhere."""
    for fn in (_run_live_mode, run_notebook):
        params = inspect.signature(fn).parameters
        assert params["quiescence_window"].default == 2.0
        assert params["cell_timeout"].default == 60.0
    parser = argparse.ArgumentParser()
    add_arguments(parser)
    ns = parser.parse_args(["nb.magic"])
    assert ns.quiescence_window == 2.0
    assert ns.cell_timeout == 60.0



def test_heartbeat_loss_fails_cell_promptly_with_kernel_lost(tmp_path: Path) -> None:
    """Keepalive semantics (TCP keepalive / HTTP-2 PING): heartbeats never
    extend the window, but once their cadence has been observed and they
    stop, the kernel is presumed gone and the cell ends with K_KERNEL_LOST
    well before the budget instead of a late K_CELL_TIMEOUT."""
    def beating_then_silent(conn: _TickConnection, tick: int) -> dict[str, Any]:
        return _heartbeat(tick) if tick <= 30 else {}

    fake = _TickConnection(clock_every=3, clock_factory=beating_then_silent)
    src = _write_magic(tmp_path)
    rec = tmp_path / "rec.jsonl"
    t0 = time.monotonic()
    result = run_notebook(
        src, output=tmp_path / "out.llmnb", mode="live", connection=fake,
        cell_timeout=4.0, quiescence_window=1.5, total_timeout=60.0, record_to=rec,
    )
    elapsed = time.monotonic() - t0
    assert result.cells_failed >= 1
    entries = [json.loads(l) for l in rec.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert entries[0]["completion_reason"] == "heartbeat_lost"
    assert entries[0]["received"]["payload"]["k_code"] == "K_KERNEL_LOST"
    assert elapsed < 2.0, elapsed
    assert len(entries) == 2 and entries[1]["completion_reason"] == "heartbeat_lost"
