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


# ---------------------------------------------------------------------------
# `--connect` flag — Tier 2: attach to a running `llmnb serve`.
#
# These tests verify the CLI-surface gates and cleanup contract WITHOUT
# requiring a live kernel. The actual TCP handshake is exercised by
# tests/test_tcp_transport.py; here we focus on the CLI's validation /
# error-path / lifecycle behavior.
# ---------------------------------------------------------------------------


def test_cli_execute_connect_url_parsing() -> None:
    from llm_client.cli.execute import _parse_connect_url

    assert _parse_connect_url("tcp://127.0.0.1:7474") == ("tcp", "127.0.0.1:7474")
    assert _parse_connect_url("127.0.0.1:7474") == ("tcp", "127.0.0.1:7474")
    assert _parse_connect_url("unix:///tmp/llmnb.sock") == ("unix", "/tmp/llmnb.sock")

    with pytest.raises(ValueError, match="unsupported transport scheme"):
        _parse_connect_url("ws://example.com:80")
    with pytest.raises(ValueError, match="unsupported transport scheme"):
        _parse_connect_url("ftp://x")


def test_cli_execute_connect_requires_live_mode(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "stub",
        "--connect", "tcp://127.0.0.1:7474",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "--connect requires --mode live" in err


def test_cli_execute_connect_requires_token_env(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LLMNB_AUTH_TOKEN", raising=False)
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "tcp://127.0.0.1:7474",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "LLMNB_AUTH_TOKEN" in err
    assert "tokens are never accepted on argv" in err


def test_cli_execute_connect_custom_token_env_name(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The auth-token-env name appears in the error message, not the default."""
    monkeypatch.delenv("CI_LLMNB_TOKEN", raising=False)
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "tcp://127.0.0.1:7474",
        "--auth-token-env", "CI_LLMNB_TOKEN",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "CI_LLMNB_TOKEN" in err


def test_cli_execute_connect_unix_not_wired(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "x" * 32)
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "unix:///tmp/llmnb.sock",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "unix://" in err


def test_cli_execute_connect_rejects_unsupported_scheme(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "x" * 32)
    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "ws://127.0.0.1:7474",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "unsupported transport scheme" in err


def test_cli_execute_connect_closes_connection_after_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When --connect is used, the CLI MUST close the connection after
    run_notebook returns (success or failure), but MUST NOT terminate
    the remote kernel."""
    from llm_client.cli import execute as execute_mod
    from llm_client.executor import ExecutionResult

    closed: list[bool] = []
    passed: dict[str, object] = {}

    class _FakeConn:
        session_id = "fake-session"

        def close(self) -> None:
            closed.append(True)

    def _fake_connect_to_kernel(bind, *, token, transport="tcp", timeout=30.0):
        passed["bind"] = bind
        passed["token"] = token
        passed["transport"] = transport
        return _FakeConn()

    def _fake_run_notebook(path, **kwargs):
        passed["received_connection"] = kwargs.get("connection")
        return ExecutionResult(
            notebook_path=Path(path),
            cells_executed=0,
            cells_succeeded=0,
            cells_failed=0,
            final_state={},
            errors=[],
        )

    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "secret-token")
    monkeypatch.setattr(
        "llm_client.boot.connect_to_kernel", _fake_connect_to_kernel,
    )
    monkeypatch.setattr(execute_mod, "run_notebook", _fake_run_notebook)

    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "tcp://127.0.0.1:7474",
    ])

    assert rc == 0
    assert passed["bind"] == "127.0.0.1:7474"
    assert passed["token"] == "secret-token"
    assert passed["transport"] == "tcp"
    assert isinstance(passed["received_connection"], _FakeConn)
    assert closed == [True], "connection.close() must be called exactly once"


def test_cli_execute_connect_closes_connection_on_run_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even if run_notebook raises, the connection must be closed."""
    from llm_client.cli import execute as execute_mod

    closed: list[bool] = []

    class _FakeConn:
        session_id = "fake"

        def close(self) -> None:
            closed.append(True)

    def _fake_connect_to_kernel(bind, *, token, transport="tcp", timeout=30.0):
        return _FakeConn()

    def _boom(path, **kwargs):
        raise ValueError("synthetic failure")

    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "tok")
    monkeypatch.setattr(
        "llm_client.boot.connect_to_kernel", _fake_connect_to_kernel,
    )
    monkeypatch.setattr(execute_mod, "run_notebook", _boom)

    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "tcp://127.0.0.1:7474",
    ])
    assert rc == 2
    assert closed == [True]


def test_cli_execute_connect_refused_returns_2(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real ConnectionRefusedError surfaces as exit code 2 with a hint
    about `llmnb serve`. We synthesize the refusal via monkeypatch so the
    test doesn't depend on a port being closed on the host."""
    def _refuse(bind, *, token, transport="tcp", timeout=30.0):
        raise ConnectionRefusedError("nothing listening")

    monkeypatch.setenv("LLMNB_AUTH_TOKEN", "tok")
    monkeypatch.setattr("llm_client.boot.connect_to_kernel", _refuse)

    src = tmp_path / "in.magic"
    shutil.copy(SPAWN_AND_NOTIFY, src)
    rc = main([
        "execute", str(src),
        "--output", str(tmp_path / "out.llmnb"),
        "--mode", "live",
        "--connect", "tcp://127.0.0.1:7474",
    ])
    assert rc == 2
    err = capsys.readouterr().err
    assert "is `llmnb serve` running?" in err
