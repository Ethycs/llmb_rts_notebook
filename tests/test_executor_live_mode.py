"""tests/test_executor_live_mode.py — live-mode executor unit tests (S5.0.3.1).

Per PLAN-S5.0.3.1 §5: 4 unit tests covering the per-cell envelope
derivation. The integration test lives in
``tests/test_executor_live_integration.py``.

These tests target ``_derive_cell_envelope`` directly. They do NOT spin
up a kernel; the per-cell envelope helper is a pure function.
"""

from __future__ import annotations

from llm_client.executor import _derive_cell_envelope


def test_derive_envelope_for_spawn_cell() -> None:
    """`@@spawn` cells produce an `agent_spawn` operator-action."""
    record = {
        "kind": "spawn",
        "text": "@@spawn alpha\nhello world\n",
        "bound_agent_id": "alpha",
    }
    env = _derive_cell_envelope(
        "cell-1", record, session_id="sess", ordinal=0,
    )
    assert env is not None
    assert env["type"] == "operator.action"
    assert env["request_id"] == "sess:0"
    payload = env["payload"]
    assert payload["action_type"] == "agent_spawn"
    assert payload["parameters"]["agent_id"] == "alpha"
    assert payload["parameters"]["cell_id"] == "cell-1"
    # task is the first non-magic line.
    assert payload["parameters"]["task"] == "hello world"
    assert payload["originating_cell_id"] == "cell-1"


def test_derive_envelope_for_agent_cell() -> None:
    """`@@agent` cells produce an `agent_continue` operator-action."""
    record = {
        "kind": "agent",
        "text": "@@agent alpha\nWhat is 2+2?\n",
        "bound_agent_id": "alpha",
    }
    env = _derive_cell_envelope(
        "cell-2", record, session_id="sess", ordinal=3,
    )
    assert env is not None
    assert env["request_id"] == "sess:3"
    payload = env["payload"]
    assert payload["action_type"] == "agent_continue"
    assert payload["intent_kind"] == "send_user_turn"
    assert payload["parameters"]["agent_id"] == "alpha"
    assert payload["parameters"]["cell_id"] == "cell-2"
    # The leading @@agent directive is stripped from the body.
    assert payload["parameters"]["text"] == "What is 2+2?"


def test_derive_envelope_for_scratch_and_markdown_returns_none() -> None:
    """`scratch` / `markdown` / `native` cells ship no envelope (no-op)."""
    for kind in ("scratch", "markdown", "native"):
        record = {"kind": kind, "text": "anything", "bound_agent_id": None}
        env = _derive_cell_envelope(
            "c", record, session_id="s", ordinal=0,
        )
        assert env is None, f"{kind!r} should be a no-op cell"


def test_derive_envelope_for_unknown_kind_returns_none() -> None:
    """Unknown / agent-without-binding cells ship no envelope (W4 tolerant)."""
    # Unknown kind.
    env = _derive_cell_envelope(
        "c1", {"kind": "synthetic", "text": "x", "bound_agent_id": None},
        session_id="s", ordinal=0,
    )
    assert env is None

    # agent kind without a bound agent_id (defensive).
    env2 = _derive_cell_envelope(
        "c2", {"kind": "agent", "text": "x", "bound_agent_id": None},
        session_id="s", ordinal=0,
    )
    assert env2 is None
