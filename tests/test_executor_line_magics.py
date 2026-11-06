"""tests/test_executor_line_magics.py — @branch / @revert / @stop / @handoff (PLAN-S5 §3.6).

The live driver ships one ``operator.action`` per control line magic,
in cell order, before the cell's own envelope; ``@handoff <id>`` ships
nothing and re-binds the next agent cell.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from llm_client import run_notebook
from llm_client.executor import _derive_line_magic_envelopes


def test_derive_line_magic_envelopes_shapes_and_body() -> None:
    envs, handoff, body = _derive_line_magic_envelopes(
        "cell-7",
        "@@agent alpha\n@branch alpha at t_3 as beta\n@stop alpha\n@handoff beta\nkeep going",
        session_id="s", ordinal=7,
    )
    assert [e["payload"]["action_type"] for e in envs] == ["agent_branch", "agent_stop"]
    assert envs[0]["payload"]["parameters"] == {
        "source_agent": "alpha", "new_agent_id": "beta", "at_turn_id": "t_3",
        "cell_id": "cell-7",
    }
    assert envs[1]["payload"]["parameters"] == {"agent_id": "alpha", "cell_id": "cell-7"}
    assert [e["request_id"] for e in envs] == ["s:7:0", "s:7:1"]
    assert handoff == "beta"
    assert body.strip() == "keep going"


def test_cell_without_control_magics_is_untouched() -> None:
    envs, handoff, body = _derive_line_magic_envelopes(
        "c", "@@agent alpha\n@pin\nhello", session_id="s", ordinal=0,
    )
    assert (envs, handoff, body) == ([], None, None)


class _Conn:
    session_id = "line-magics"
    wire_version = "0.0.0"

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, envelope: dict[str, Any]) -> None:
        self.sent.append(envelope)

    def recv(self, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return {}

    def close(self) -> None:
        pass


def test_live_run_revert_then_handoff(tmp_path: Path) -> None:
    src = tmp_path / "nb.magic"
    src.write_text(
        '@@spawn alpha task:"plan"\n@@break\n'
        '@@spawn beta task:"review"\n@@break\n'
        "@revert alpha to t_1\n@handoff beta\n@@break\n"
        "any objections?\n",
        encoding="utf-8",
    )
    out = tmp_path / "out.llmnb"
    conn = _Conn()
    result = run_notebook(
        src, output=out, mode="live", connection=conn,
        cell_timeout=5.0, quiescence_window=0.1, total_timeout=30.0,
    )
    assert result.cells_failed == 0, result.errors
    actions = [e["payload"] for e in conn.sent if e.get("type") == "operator.action"]
    assert [(a["action_type"], a["parameters"].get("agent_id")) for a in actions] == [
        ("agent_spawn", "alpha"),
        ("agent_spawn", "beta"),
        ("agent_revert", "alpha"),
        ("agent_continue", "beta"),
    ]
    assert actions[2]["parameters"]["target_turn_id"] == "t_1"
    assert actions[3]["parameters"]["text"] == "any objections?"
    nb = json.loads(out.read_text(encoding="utf-8"))
    assert nb["metadata"]["rts"]["cells"]["cell-3"]["bound_agent_id"] == "beta"
