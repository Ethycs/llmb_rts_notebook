"""
tests/test_campaign_smoke.py — S5.0.3 campaign acceptance test.

Exercises the full operator journey end-to-end using the in-process CLI:
  validate → execute (stub) → convert (round-trip) → auth init → smoke --help.

All steps must exit 0. No subprocess, no network, no API key required.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


FIXTURES = Path(__file__).parent / "fixtures"
SPAWN_AND_NOTIFY = FIXTURES / "spawn-and-notify.magic"


def test_campaign_validate(capsys: pytest.CaptureFixture[str]) -> None:
    """Step 1: validate the campaign fixture — must exit 0."""
    rc = main(["validate", str(SPAWN_AND_NOTIFY)])
    assert rc == 0


def test_campaign_execute_stub(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Step 2: execute in stub mode — must exit 0 and produce output file."""
    out = tmp_path / "out.llmnb"
    rc = main([
        "execute", str(SPAWN_AND_NOTIFY),
        "--mode", "stub",
        "--output", str(out),
    ])
    assert rc == 0
    assert out.exists(), "execute --mode stub must produce output file"


def test_campaign_convert_round_trip(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Step 3: execute → convert back to .magic — round-trip must succeed."""
    out_llmnb = tmp_path / "out.llmnb"
    out_magic = tmp_path / "out.magic"
    # Execute first to produce the .llmnb
    rc_exec = main([
        "execute", str(SPAWN_AND_NOTIFY),
        "--mode", "stub",
        "--output", str(out_llmnb),
    ])
    assert rc_exec == 0, "execute step failed; cannot test round-trip"
    # Convert back
    rc_conv = main(["convert", str(out_llmnb), str(out_magic)])
    assert rc_conv == 0
    assert out_magic.exists(), "convert must produce .magic output"


def test_campaign_auth_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Step 4: auth init in isolated tmp_path — must write token to .env."""
    monkeypatch.chdir(tmp_path)
    env_file = tmp_path / ".env"
    rc = main(["auth", "init", "--env-file", str(env_file)])
    assert rc == 0
    text = env_file.read_text(encoding="utf-8")
    assert "LLMNB_AUTH_TOKEN=" in text


def test_campaign_smoke_help(capsys: pytest.CaptureFixture[str]) -> None:
    """Step 5: llmnb smoke --help exits 0 listing all targets."""
    result = subprocess.run(
        [sys.executable, "-m", "llm_client", "smoke", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"smoke --help exited {result.returncode};\n"
        f"stdout={result.stdout!r}\nstderr={result.stderr!r}"
    )
    output = result.stdout + result.stderr
    for target in ("supervisor", "metadata-writer", "paper-telephone", "pty"):
        assert target in output
