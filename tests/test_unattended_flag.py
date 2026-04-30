"""
tests/test_unattended_flag.py — escalate-cell guard (PLAN-S5.0.3 §10 risk #7).

Default unattended=False raises EscalationRequiresOperatorError when
the notebook contains escalate-bearing cells. unattended=True proceeds.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from llm_client import run_notebook
from llm_client.executor import EscalationRequiresOperatorError


def _write_escalate_notebook(path: Path) -> None:
    """A magic-text fixture with an escalate-bearing cell."""
    path.write_text(
        "@@scratch\nfoo = request_approval('do thing')\n",
        encoding="utf-8",
    )


def test_unattended_false_raises_on_escalate(tmp_path: Path) -> None:
    src = tmp_path / "with_escalate.magic"
    _write_escalate_notebook(src)
    with pytest.raises(EscalationRequiresOperatorError):
        run_notebook(src, output=tmp_path / "out.llmnb", mode="stub")


def test_unattended_true_proceeds_on_escalate(tmp_path: Path) -> None:
    src = tmp_path / "with_escalate.magic"
    _write_escalate_notebook(src)
    result = run_notebook(
        src,
        output=tmp_path / "out.llmnb",
        mode="stub",
        unattended=True,
    )
    assert result.cells_executed == 1


def test_unattended_no_op_when_no_escalate(tmp_path: Path) -> None:
    """A notebook without escalate cells runs fine without the flag."""
    src = tmp_path / "plain.magic"
    src.write_text("@@scratch\nprint('hello')\n", encoding="utf-8")
    result = run_notebook(src, output=tmp_path / "out.llmnb", mode="stub")
    assert result.cells_executed == 1
