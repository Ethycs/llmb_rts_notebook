"""tests/test_executor_unattended_reject.py — PLAN-S5.0.3 §10 risk #7.

Unattended live runs answer every ``request_approval`` / ``escalate``
run with an ``approval_response`` (``decision: "deny"``) keyed by the
run's spanId, and record it; attended runs never answer.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from llm_client import run_notebook
from tests.test_executor_live_quiescence import _TickConnection, _envelope


def _on_action(conn: _TickConnection, envelope: dict[str, Any], tick: int):
    payload = envelope["payload"]
    if payload.get("action_type") != "agent_spawn" or payload["parameters"]["cell_id"] != "cell-0":
        return []
    span = {"spanId": "a1b2c3d4e5f60718", "name": "request_approval", "attributes": []}
    return [(2, _envelope("run.start", span, correlation_id=span["spanId"]))]


def _approval_responses(conn: _TickConnection) -> list[dict[str, Any]]:
    return [e for e in conn.sent
            if e.get("type") == "operator.action"
            and e["payload"].get("action_type") == "approval_response"]


@pytest.mark.parametrize("unattended", [True, False])
def test_unattended_auto_rejects_and_records(tmp_path: Path, unattended: bool) -> None:
    src = tmp_path / "nb.magic"
    src.write_text('@@spawn alpha task:"go"\n@@break\n@@scratch\nx\n', encoding="utf-8")
    rec = tmp_path / "rec.jsonl"
    conn = _TickConnection(on_action=_on_action)
    result = run_notebook(
        src, output=tmp_path / "out.llmnb", mode="live", connection=conn,
        unattended=unattended, cell_timeout=5.0, quiescence_window=0.3, record_to=rec,
    )
    assert result.cells_failed == 0, result.errors
    entries = [json.loads(l) for l in rec.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not unattended:
        assert _approval_responses(conn) == []
        assert "approval_responses" not in entries[0]
        return
    [response] = _approval_responses(conn)
    assert response["payload"]["parameters"]["request_id"] == "a1b2c3d4e5f60718"
    assert response["payload"]["parameters"]["decision"] == "deny"
    assert entries[0]["approval_responses"] == [response]
