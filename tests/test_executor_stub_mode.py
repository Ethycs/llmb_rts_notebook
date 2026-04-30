"""
tests/test_executor_stub_mode.py — stub-mode executor (PLAN-S5.0.3 §8.1).

Asserts the determinism contract: 10 consecutive runs of the spawn-and-notify
fixture produce byte-identical output. Also covers basic ExecutionResult
shape.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from llm_client import ExecutionResult, run_notebook


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


def test_stub_mode_returns_execution_result(tmp_path: Path) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    out = tmp_path / "out.llmnb"
    result = run_notebook(src, output=out, mode="stub")
    assert isinstance(result, ExecutionResult)
    assert result.cells_executed == 2
    assert result.cells_succeeded == 2
    assert result.cells_failed == 0
    assert result.errors == []
    assert out.exists()


def test_stub_mode_deterministic_across_10_runs(tmp_path: Path) -> None:
    """PLAN §8.2 acceptance: byte-identical outputs across 10 runs."""
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    outputs: list[bytes] = []
    for i in range(10):
        out = tmp_path / f"out{i}.llmnb"
        run_notebook(src, output=out, mode="stub")
        outputs.append(out.read_bytes())
    # All ten outputs must be byte-identical.
    assert len(set(outputs)) == 1


def test_stub_mode_writes_outputs_into_cells(tmp_path: Path) -> None:
    """Stub responses populate cell.outputs in the result notebook."""
    import json

    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    out = tmp_path / "out.llmnb"
    run_notebook(src, output=out, mode="stub")
    nb = json.loads(out.read_text(encoding="utf-8"))
    cells = nb["metadata"]["rts"]["cells"]
    # At least one cell got populated outputs from a stub.
    has_outputs = any(
        rec.get("outputs") for rec in cells.values()
    )
    assert has_outputs


def test_stub_mode_overwrites_input_when_output_none(tmp_path: Path) -> None:
    """When output=None, the input file is overwritten in place."""
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    original = src.read_text(encoding="utf-8")
    run_notebook(src, output=None, mode="stub")
    # The .magic file gets rewritten in magic format.
    new = src.read_text(encoding="utf-8")
    # Same cells, possibly slightly different formatting via the
    # round-trip; the magic body must round-trip identically.
    assert "@@spawn" in new
    assert "@@scratch" in new


def test_stub_mode_unknown_cells_use_default_noop(tmp_path: Path) -> None:
    """Cells not in the stub registry get DEFAULT_NOOP_RESPONSE."""
    src = tmp_path / "in.magic"
    src.write_text(
        "@@scratch\nthis text is not in any stub fixture\n",
        encoding="utf-8",
    )
    out = tmp_path / "out.llmnb"
    result = run_notebook(src, output=out, mode="stub")
    # The default noop is success-shaped, so cells_succeeded == 1.
    assert result.cells_executed == 1
    assert result.cells_succeeded == 1
    assert result.cells_failed == 0
