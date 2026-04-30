"""
tests/test_cli_execute.py — `python -m llm_client execute` (PLAN-S5.0.3 §6.1).

Acceptance per PLAN §8.2: stub-mode execute runs in <5s with byte-
identical outputs across runs. We use the in-process main() rather than
subprocess.run() to keep the test fast and deterministic.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


def test_cli_execute_stub_mode_succeeds(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    out = tmp_path / "out.llmnb"
    rc = main([
        "execute", str(src),
        "--output", str(out),
        "--mode", "stub",
    ])
    assert rc == 0
    assert out.exists()
    captured = capsys.readouterr()
    assert "executed 2 cells" in captured.out


def test_cli_execute_stub_mode_under_5_seconds(tmp_path: Path) -> None:
    """PLAN §8.2 acceptance: <5s for the spawn-and-notify fixture."""
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    out = tmp_path / "out.llmnb"
    t0 = time.monotonic()
    rc = main([
        "execute", str(src),
        "--output", str(out),
        "--mode", "stub",
    ])
    elapsed = time.monotonic() - t0
    assert rc == 0
    assert elapsed < 5.0, f"stub-mode exec took {elapsed:.2f}s (>5s)"


def test_cli_execute_replay_missing_file_returns_2(tmp_path: Path) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "replay",
        "--replay", str(tmp_path / "missing.jsonl"),
    ])
    assert rc == 2


def test_cli_execute_escalate_without_unattended_returns_2(tmp_path: Path) -> None:
    src = tmp_path / "esc.magic"
    src.write_text(
        "@@scratch\nrequest_approval('foo')\n", encoding="utf-8",
    )
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "stub",
    ])
    assert rc == 2


def test_cli_execute_escalate_with_unattended_succeeds(tmp_path: Path) -> None:
    src = tmp_path / "esc.magic"
    src.write_text(
        "@@scratch\nrequest_approval('foo')\n", encoding="utf-8",
    )
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "stub",
        "--unattended",
    ])
    assert rc == 0
