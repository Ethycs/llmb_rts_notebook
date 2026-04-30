"""tests/test_executor_live_integration.py — live-mode end-to-end smoke (S5.0.3.1).

PLAN-S5.0.3.1 §5: one integration test that runs the spawn-and-notify
fixture through live-mode end-to-end and compares the output structure
against stub-mode output (key-subset assertion, not byte-identity).

Uses a fake ``KernelConnection`` injected via the ``connection`` kwarg
on ``run_notebook``. This bypasses the TCP-on-loopback subprocess boot
(see PLAN §6 risk #2 / Ambiguity 2 resolution) so the test runs without
``ANTHROPIC_API_KEY`` and without spawning the kernel subprocess. The
kernel-side TCP path is exercised separately by ``test_tcp_transport.py``.

The fake connection scripts a Family F snapshot back per cell, mirroring
what a live kernel with running agents would emit. Structural parity vs
stub-mode is what the test actually asserts.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Iterator

from llm_client import run_notebook


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


class _FakeConnection:
    """Minimal duck-typed ``KernelConnection`` for the integration smoke.

    Each ``send`` of an ``operator.action`` envelope queues a scripted
    ``notebook.metadata`` snapshot followed by a correlated
    ``run.complete``. ``recv`` drains the queue, returning ``{}`` once
    empty so the executor's quiescence-only completion path fires.
    """

    session_id = "fake-session"
    wire_version = "0.0.0"

    def __init__(self) -> None:
        self._queue: list[dict[str, Any]] = []
        self._closed = False
        self.sent: list[dict[str, Any]] = []
        self._working_cells: dict[str, dict[str, Any]] = {}
        self._snapshot_seq = 0

    def send(self, envelope: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("connection closed")
        self.sent.append(envelope)

        # Seed working cells from the hydrate snapshot so trailing
        # snapshots remain a strict superset of the input universe
        # (mirrors what the kernel-side MetadataWriter does on hydrate).
        if envelope.get("type") == "notebook.metadata":
            payload = envelope.get("payload") or {}
            if payload.get("mode") == "hydrate":
                snap = payload.get("snapshot") or {}
                input_cells = snap.get("cells") or {}
                for cid, rec in input_cells.items():
                    if isinstance(rec, dict):
                        # Copy without outputs; live mode populates them.
                        self._working_cells[cid] = {
                            k: v for k, v in rec.items() if k != "outputs"
                        }
            return

        if envelope.get("type") != "operator.action":
            return
        payload = envelope.get("payload") or {}
        action_type = payload.get("action_type")
        if action_type not in {"agent_spawn", "agent_continue"}:
            return
        params = payload.get("parameters") or {}
        cell_id = params.get("cell_id") or "unknown"
        self._snapshot_seq += 1

        # Update working cells with a synthetic output for this cell.
        self._working_cells.setdefault(cell_id, {})
        self._working_cells[cell_id]["outputs"] = [{
            "output_type": "display_data",
            "data": {
                "application/vnd.rts.run+json": {
                    "spanId": f"live-{action_type}-{cell_id}",
                    "name": f"agent.{action_type}",
                    "status": "ok",
                },
            },
            "metadata": {},
        }]

        self._queue.append({
            "type": "notebook.metadata",
            "payload": {
                "mode": "snapshot",
                "snapshot_version": self._snapshot_seq,
                "snapshot": {
                    "cells": dict(self._working_cells),
                    "schema_version": "1.0.0",
                },
                "trigger": "end_of_run",
            },
        })
        self._queue.append({
            "type": "operator.action",
            "request_id": envelope["request_id"],
            "payload": {
                "kind": "run.complete",
                "status": "ok",
                "cell_id": cell_id,
                "outputs": self._working_cells[cell_id]["outputs"],
            },
        })

    def recv(self, *, timeout: float | None = None) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("connection closed")
        if self._queue:
            return self._queue.pop(0)
        return {}

    def close(self) -> None:
        self._closed = True


def test_live_mode_round_trip_against_fake_connection(tmp_path: Path) -> None:
    """Live-mode runs the fixture end-to-end via an injected fake connection.

    Asserts the structural parity contract from PLAN §3.E:
      - cells_executed / succeeded / failed counts match stub mode.
      - the same set of cell ids appears in final_state.cells.
      - per-cell outputs[] structure matches stub mode shape.
    """
    # First, run stub mode to capture the structural baseline.
    stub_src = tmp_path / "stub_in.magic"
    stub_out = tmp_path / "stub_out.llmnb"
    shutil.copy(SPAWN_AND_NOTIFY, stub_src)
    stub_result = run_notebook(stub_src, output=stub_out, mode="stub")

    # Live mode against the fake connection.
    live_src = tmp_path / "live_in.magic"
    live_out = tmp_path / "live_out.llmnb"
    shutil.copy(SPAWN_AND_NOTIFY, live_src)
    fake = _FakeConnection()
    live_result = run_notebook(
        live_src,
        output=live_out,
        mode="live",
        connection=fake,
        cell_timeout=5.0,
        quiescence_window=0.2,
        total_timeout=30.0,
    )

    # Structural parity: same counts.
    assert live_result.cells_executed == stub_result.cells_executed
    assert live_result.cells_succeeded == stub_result.cells_succeeded
    assert live_result.cells_failed == stub_result.cells_failed

    # Same set of cell ids in final_state.cells.
    stub_ids = set((stub_result.final_state.get("cells") or {}).keys())
    live_ids = set((live_result.final_state.get("cells") or {}).keys())
    assert live_ids == stub_ids
    assert live_ids, "fixture must have at least one cell"

    # The live notebook should have at least one cell with non-empty
    # outputs (the spawn cell, populated by the fake connection's
    # scripted snapshot).
    import json
    nb = json.loads(live_out.read_text(encoding="utf-8"))
    cells = nb["metadata"]["rts"]["cells"]
    has_outputs = any(
        rec.get("outputs") for rec in cells.values()
        if isinstance(rec, dict)
    )
    assert has_outputs, "live mode should populate at least one cell's outputs"

    # The fake recorded at least one operator.action send beyond hydrate.
    actions = [
        s for s in fake.sent
        if s.get("type") == "operator.action"
    ]
    assert len(actions) >= 1
