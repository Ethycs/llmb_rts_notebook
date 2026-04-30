"""tests/test_auth_token_storage.py — `auth init` + `auth verify` (S5.0.3d).

Covers token-storage discipline:
    * ``auth init`` writes the token to ``.env``.
    * ``auth init`` refuses overwrite without ``--force``.
    * ``auth init`` refuses to write when ``.env`` is git-tracked.
    * ``auth verify`` reports presence + an 8-char sha256 hash, never the
      raw token.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


def test_auth_init_writes_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    rc = main(["auth", "init", "--env-file", str(env)])
    assert rc == 0
    text = env.read_text(encoding="utf-8")
    assert "LLMNB_AUTH_TOKEN=" in text
    line = next(l for l in text.splitlines() if l.startswith("LLMNB_AUTH_TOKEN="))
    token = line.split("=", 1)[1]
    assert len(token) >= 32


def test_auth_init_refuses_when_env_is_tracked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If .env is git-tracked, ``auth init`` MUST refuse (returns 2)."""
    monkeypatch.chdir(tmp_path)
    # Set up a git repo and track .env.
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path, check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path, check=True, capture_output=True,
    )
    env = tmp_path / ".env"
    env.write_text("LLMNB_AUTH_TOKEN=existing\n", encoding="utf-8")
    subprocess.run(["git", "add", ".env"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=tmp_path, check=True, capture_output=True,
    )

    rc = main(["auth", "init", "--env-file", str(env), "--force"])
    assert rc == 2  # refuses tracked file


def test_auth_verify_reports_presence_with_hash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    main(["auth", "init", "--env-file", str(env)])

    # Strip the var from the process env so verify reads from the file.
    monkeypatch.delenv("LLMNB_AUTH_TOKEN", raising=False)

    rc = main(["auth", "verify", "--env-file", str(env)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "LLMNB_AUTH_TOKEN" in out
    assert "present" in out
    assert "sha256[:8]=" in out

    # Crucially: the raw token must NOT appear in the output.
    raw_token = next(
        l for l in env.read_text(encoding="utf-8").splitlines()
        if l.startswith("LLMNB_AUTH_TOKEN=")
    ).split("=", 1)[1]
    assert raw_token not in out


def test_auth_verify_reports_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LLMNB_AUTH_TOKEN", raising=False)
    env = tmp_path / ".env"
    rc = main(["auth", "verify", "--env-file", str(env)])
    assert rc == 2
    out = capsys.readouterr().out
    assert "missing" in out


def test_auth_verify_prefers_environment_over_env_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """When LLMNB_AUTH_TOKEN is set in the env, that wins over .env."""
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    env.write_text("LLMNB_AUTH_TOKEN=from-file-token\n", encoding="utf-8")
    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "from-env-token")

    rc = main(["auth", "verify", "--env-file", str(env)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "source=environment" in out
    expected_hash = hashlib.sha256(b"from-env-token").hexdigest()[:8]
    assert expected_hash in out


def test_auth_init_with_custom_token_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Operators can scope a token under a custom env-var name."""
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    rc = main([
        "auth", "init",
        "--env-file", str(env),
        "--token-name", "CI_LLMNB_TOKEN",
    ])
    assert rc == 0
    text = env.read_text(encoding="utf-8")
    assert "CI_LLMNB_TOKEN=" in text
    assert "LLMNB_AUTH_TOKEN" not in text
