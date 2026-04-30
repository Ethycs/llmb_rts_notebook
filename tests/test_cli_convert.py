"""
tests/test_cli_convert.py — `python -m llm_client convert` (PLAN-S5.0.3 §6.1).

Round-trip via the CLI subcommand preserves cells and kinds.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


FIXTURES = Path(__file__).parent / "fixtures"


def test_convert_magic_to_llmnb(tmp_path: Path) -> None:
    src = FIXTURES / "spawn-and-notify.magic"
    dst = tmp_path / "out.llmnb"
    rc = main(["convert", str(src), str(dst)])
    assert rc == 0
    nb = json.loads(dst.read_text(encoding="utf-8"))
    cells = nb["metadata"]["rts"]["cells"]
    assert len(cells) == 2


def test_convert_llmnb_back_to_magic(tmp_path: Path) -> None:
    """Round-trip: magic → llmnb → magic preserves cell text."""
    src = FIXTURES / "spawn-and-notify.magic"
    intermediate = tmp_path / "out.llmnb"
    final = tmp_path / "back.magic"
    rc = main(["convert", str(src), str(intermediate)])
    assert rc == 0
    rc = main(["convert", str(intermediate), str(final)])
    assert rc == 0
    original = src.read_text(encoding="utf-8")
    roundtripped = final.read_text(encoding="utf-8")
    assert roundtripped.rstrip("\n") == original.rstrip("\n")


def test_convert_ipynb_to_llmnb_warns(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    src = FIXTURES / "simple.ipynb"
    dst = tmp_path / "out.llmnb"
    rc = main(["convert", str(src), str(dst)])
    assert rc == 0
    captured = capsys.readouterr()
    assert "warning" in captured.err.lower()
    assert "ipynb" in captured.err.lower()


def test_convert_unknown_target_format(tmp_path: Path) -> None:
    src = FIXTURES / "spawn-and-notify.magic"
    dst = tmp_path / "out.weird"
    rc = main(["convert", str(src), str(dst)])
    assert rc == 2


def test_convert_llmnb_to_ipynb_unsupported(tmp_path: Path) -> None:
    """ipynb is one-way only per PLAN §6.3."""
    intermediate = tmp_path / "intermediate.llmnb"
    main(["convert", str(FIXTURES / "spawn-and-notify.magic"), str(intermediate)])
    rc = main(["convert", str(intermediate), str(tmp_path / "out.ipynb")])
    assert rc == 2
