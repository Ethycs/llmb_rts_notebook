"""
tests/test_cli_auth.py — `python -m llm_client auth init` (PLAN-S5.0.3 §5.3).

Generates LLMNB_AUTH_TOKEN and writes to .env. Errors when .env is git-tracked.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


def test_auth_init_creates_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    rc = main(["auth", "init", "--env-file", str(env)])
    assert rc == 0
    text = env.read_text(encoding="utf-8")
    assert "LLMNB_AUTH_TOKEN=" in text
    # Token is base64-url-safe, length comparable to token_urlsafe(48).
    line = next(
        (l for l in text.splitlines() if l.startswith("LLMNB_AUTH_TOKEN=")), None
    )
    assert line is not None
    token = line.split("=", 1)[1]
    assert len(token) >= 32


def test_auth_init_refuses_overwrite_without_force(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    env.write_text("LLMNB_AUTH_TOKEN=existing-token\n", encoding="utf-8")
    rc = main(["auth", "init", "--env-file", str(env)])
    assert rc == 2
    # The token is preserved.
    assert "existing-token" in env.read_text(encoding="utf-8")


def test_auth_init_force_overwrites(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    env.write_text("LLMNB_AUTH_TOKEN=existing-token\n", encoding="utf-8")
    rc = main(["auth", "init", "--env-file", str(env), "--force"])
    assert rc == 0
    assert "existing-token" not in env.read_text(encoding="utf-8")


def test_auth_init_custom_token_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    env = tmp_path / ".env"
    rc = main([
        "auth", "init",
        "--env-file", str(env),
        "--token-name", "MY_TOKEN",
    ])
    assert rc == 0
    text = env.read_text(encoding="utf-8")
    assert "MY_TOKEN=" in text
    assert "LLMNB_AUTH_TOKEN" not in text


def test_serve_subcommand_errors_when_token_unset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Serve refuses to launch when the token env var is unset (rc=2).

    Implemented in S5.0.3d. The CLI checks the env var BEFORE spawning
    the kernel subprocess so operators get a local error message.
    """
    monkeypatch.delenv("LLMNB_AUTH_TOKEN", raising=False)
    rc = main(["serve", "--auth-token-env", "LLMNB_AUTH_TOKEN_DEFINITELY_UNSET"])
    assert rc == 2
    captured = capsys.readouterr()
    assert "LLMNB_AUTH_TOKEN_DEFINITELY_UNSET" in captured.err
