"""
tests/test_executor_replay_mode.py — record-then-replay regression.

Per PLAN §6.2 / §8.1: a `record_to=...` run captures (sent, received)
pairs; a subsequent `mode="replay"` run reads the recording and yields
identical output.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from llm_client import run_notebook
from llm_client.executor import ReplayMismatchError


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


def test_record_and_replay_byte_identical(tmp_path: Path) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rec = tmp_path / "recording.jsonl"
    out_record = tmp_path / "record.llmnb"
    out_replay = tmp_path / "replay.llmnb"

    # 1) Stub-mode run with record_to.
    r1 = run_notebook(src, output=out_record, mode="stub", record_to=rec)
    assert r1.cells_executed == 2
    assert rec.exists()
    rec_lines = rec.read_text(encoding="utf-8").splitlines()
    assert len(rec_lines) == 2  # one entry per cell

    # 2) Replay against the recorded output (same cell layout).
    r2 = run_notebook(
        out_record,
        output=out_replay,
        mode="replay",
        replay_recording=rec,
    )
    assert r2.cells_executed == 2
    assert r2.cells_succeeded == 2
    # The replay output reproduces the record output.
    assert out_record.read_bytes() == out_replay.read_bytes()


def test_replay_missing_file_raises(tmp_path: Path) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    with pytest.raises(FileNotFoundError):
        run_notebook(
            src,
            output=tmp_path / "out.llmnb",
            mode="replay",
            replay_recording=tmp_path / "does-not-exist.jsonl",
        )


def test_replay_without_recording_arg_raises(tmp_path: Path) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    with pytest.raises(ValueError, match="replay_recording"):
        run_notebook(
            src,
            output=tmp_path / "out.llmnb",
            mode="replay",
            replay_recording=None,
        )


def test_replay_mismatch_cell_count(tmp_path: Path) -> None:
    """A recording with the wrong cell count raises ReplayMismatchError."""
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)

    # Create an empty recording — count won't match.
    rec = tmp_path / "empty.jsonl"
    rec.write_text("", encoding="utf-8")

    with pytest.raises(ReplayMismatchError):
        run_notebook(
            src,
            output=tmp_path / "out.llmnb",
            mode="replay",
            replay_recording=rec,
        )
