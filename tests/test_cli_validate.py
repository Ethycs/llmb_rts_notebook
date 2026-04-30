"""
tests/test_cli_validate.py — `python -m llm_client validate` (PLAN-S5.0.3 §6.1).

Well-formed notebook → exit 0. Ill-formed (K30/K31) → exit 1 with K-code.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


FIXTURES = Path(__file__).parent / "fixtures"


def test_validate_well_formed_notebook(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = main(["validate", str(FIXTURES / "spawn-and-notify.magic")])
    assert rc == 0
    captured = capsys.readouterr()
    assert "ok:" in captured.out


def test_validate_unknown_cell_magic_returns_1(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Unknown @@<x> at the kind position raises K31."""
    src = tmp_path / "bad.magic"
    src.write_text("@@nonexistent_magic\nbody\n", encoding="utf-8")
    rc = main(["validate", str(src)])
    assert rc == 1
    captured = capsys.readouterr()
    assert "K31" in captured.err


def test_validate_multiple_kinds_returns_1(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Two @@<kind> declarations in one cell raises K30."""
    src = tmp_path / "bad.magic"
    src.write_text("@@scratch\nbody\n@@spawn alpha\n", encoding="utf-8")
    rc = main(["validate", str(src)])
    assert rc == 1
    captured = capsys.readouterr()
    assert "K30" in captured.err


def test_validate_ipynb_treated_as_cell_text(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """An ipynb with non-magic source still validates (each cell is its
    own text; without an @@<kind> declaration it parses as agent-default
    which is permitted)."""
    rc = main(["validate", str(FIXTURES / "simple.ipynb")])
    # The simple.ipynb fixture cells have no @@<kind>; they default to
    # @@agent which parses successfully.
    assert rc == 0
