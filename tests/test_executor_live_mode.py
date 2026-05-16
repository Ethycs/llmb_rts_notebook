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


# PLAN-S5.5 Phase 4 — @@section cell envelope mapping.


def test_derive_envelope_for_section_cell_with_title() -> None:
    """``@@section <title>`` cell → ``apply_overlay_commit`` envelope
    with a ``create_section`` op carrying the title + minted section_id."""
    record = {
        "kind": "section",
        "text": "@@section Architecture\nnotes",
        "bound_agent_id": None,
    }
    env = _derive_cell_envelope(
        "c_arch", record, session_id="s1", ordinal=3,
    )
    assert env is not None
    assert env["type"] == "operator.action"
    payload = env["payload"]
    assert payload["action_type"] == "zone_mutate"
    assert payload["intent_kind"] == "apply_overlay_commit"
    ops = payload["parameters"]["operations"]
    assert len(ops) == 1
    assert ops[0]["kind"] == "create_section"
    assert ops[0]["title"] == "Architecture"
    # Minted section_id includes the slugified title.
    assert ops[0]["section_id"].startswith("sec_architecture_")
    # message field captures the operator-typed magic text for audit.
    assert "Architecture" in payload["parameters"]["message"]


def test_derive_envelope_for_section_cell_with_explicit_id() -> None:
    """``id:"sec_xxx"`` named arg pins the section_id verbatim."""
    record = {
        "kind": "section",
        "text": '@@section Tests id:"sec_tests_pinned"\nfoo',
        "bound_agent_id": None,
    }
    env = _derive_cell_envelope(
        "c_tests", record, session_id="s1", ordinal=2,
    )
    assert env is not None
    ops = env["payload"]["parameters"]["operations"]
    assert ops[0]["section_id"] == "sec_tests_pinned"
    assert ops[0]["title"] == "Tests"


def test_derive_envelope_for_section_cell_with_quoted_title() -> None:
    """Quoted title round-trips through parse_cell into the envelope."""
    record = {
        "kind": "section",
        "text": '@@section "Runtime Concerns"\nbody',
        "bound_agent_id": None,
    }
    env = _derive_cell_envelope(
        "c_rc", record, session_id="s1", ordinal=1,
    )
    assert env is not None
    assert env["payload"]["parameters"]["operations"][0]["title"] == "Runtime Concerns"


def test_derive_envelope_for_section_cell_without_title_returns_none() -> None:
    """Bare ``@@section`` (no title) is a no-op envelope (W4-tolerant);
    the cell records as a structural success so the run completes."""
    record = {
        "kind": "section",
        "text": "@@section\nbody",
        "bound_agent_id": None,
    }
    env = _derive_cell_envelope(
        "c_bare", record, session_id="s1", ordinal=0,
    )
    assert env is None


def test_derive_envelope_for_section_cell_intent_id_includes_ordinal() -> None:
    """``intent_id`` is unique per cell — combines minted section_id + ordinal
    so two distinct ``@@section`` runs at different ordinals don't collide
    on the writer's idempotency key."""
    record = {
        "kind": "section",
        "text": "@@section Architecture",
        "bound_agent_id": None,
    }
    env_a = _derive_cell_envelope("c_a", record, session_id="s1", ordinal=0)
    env_b = _derive_cell_envelope("c_b", record, session_id="s1", ordinal=5)
    assert env_a is not None and env_b is not None
    assert env_a["payload"]["intent_id"] != env_b["payload"]["intent_id"]
    # Both should carry ordinal in the tail.
    assert env_a["payload"]["intent_id"].endswith("-0")
    assert env_b["payload"]["intent_id"].endswith("-5")
