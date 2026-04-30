"""tests/test_tcp_transport.py — end-to-end TCP transport (S5.0.3d).

Boots ``python -m llm_kernel serve`` as a subprocess on an ephemeral
port (``--bind 127.0.0.1:0``), then connects via
``llm_client.transport.tcp.connect`` and exercises the handshake +
basic ship-envelope path.

Marked ``@pytest.mark.integration`` because subprocess boot is slow
(~2s) and needs a live socket. Each test uses an ephemeral port to stay
parallel-safe.
"""

from __future__ import annotations

import os
import re
import secrets
import subprocess
import sys
import time
from contextlib import contextmanager
from typing import Iterator

import pytest

from llm_client.transport.tcp import (
    TcpAuthFailedError,
    TcpHandshakeError,
    connect as tcp_connect,
)


pytestmark = pytest.mark.integration


_LISTEN_RE = re.compile(r"listening on ([\d.]+):(\d+)")


def _spawn_kernel_serve(
    *, token: str, bind: str = "127.0.0.1:0", timeout_boot: float = 30.0,
) -> tuple[subprocess.Popen[bytes], str, int]:
    """Spawn ``llm_kernel serve``; wait for the listening line.

    Returns ``(proc, host, port)``. Caller MUST terminate ``proc``.

    A daemon thread continuously drains the kernel's stderr so the pipe
    buffer never blocks the kernel mid-dispatch (logger.warning calls in
    the dispatcher would otherwise back-pressure the serve loop once the
    pipe fills, manifesting as "client times out on second connect" in
    surprising places).
    """
    import threading

    env = dict(os.environ)
    env["LLMNB_AUTH_TOKEN"] = token
    env.setdefault("PYTHONPATH", os.pathsep.join(sys.path))

    cmd = [
        sys.executable, "-u", "-m", "llm_kernel", "serve",
        "--transport", "tcp",
        "--bind", bind,
        "--auth-token-env", "LLMNB_AUTH_TOKEN",
        "--proxy", "none",
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    # Use a queue to signal the listening line; the drain thread keeps
    # reading after that so the kernel's stderr never backs up.
    import queue as _queue
    listen_q: _queue.Queue[tuple[str, int]] = _queue.Queue(maxsize=1)
    captured_stderr: list[bytes] = []
    seen_listen = threading.Event()

    def _drain_stderr() -> None:
        try:
            while True:
                line = proc.stderr.readline() if proc.stderr else b""
                if not line:
                    return
                captured_stderr.append(line)
                if not seen_listen.is_set():
                    match = _LISTEN_RE.search(
                        line.decode("utf-8", errors="replace"),
                    )
                    if match:
                        listen_q.put((match.group(1), int(match.group(2))))
                        seen_listen.set()
        except Exception:
            return

    drain_thread = threading.Thread(
        target=_drain_stderr, name="kernel-stderr-drain", daemon=True,
    )
    drain_thread.start()

    try:
        host, port = listen_q.get(timeout=timeout_boot)
    except _queue.Empty:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        stderr = b"".join(captured_stderr)
        raise RuntimeError(
            f"kernel never reported a listening port; stderr={stderr!r}"
        ) from None

    return proc, host, port


@contextmanager
def _spawn_serve(token: str | None = None) -> Iterator[tuple[str, int, str]]:
    """Context manager: spawn + cleanup. Yields (host, port, token)."""
    real_token = token if token is not None else secrets.token_urlsafe(16)
    proc, host, port = _spawn_kernel_serve(token=real_token)
    try:
        yield host, port, real_token
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def test_tcp_handshake_succeeds_with_right_token() -> None:
    with _spawn_serve() as (host, port, token):
        conn = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)
        try:
            assert conn.session_id
            assert conn.wire_version
            assert "family_a" in conn.accepted_capabilities
        finally:
            conn.close()


def test_tcp_handshake_rejects_wrong_token() -> None:
    with _spawn_serve() as (host, port, _token):
        with pytest.raises(TcpAuthFailedError) as excinfo:
            tcp_connect(bind=f"{host}:{port}", token="not-the-token", timeout=5.0)
        assert excinfo.value.reason == "auth_failed"


def test_tcp_handshake_rejects_empty_token() -> None:
    with _spawn_serve() as (host, port, _token):
        with pytest.raises(TcpAuthFailedError):
            tcp_connect(bind=f"{host}:{port}", token="", timeout=5.0)


def test_tcp_ship_envelope_round_trip() -> None:
    """Send an envelope; verify the kernel processes it without crashing.

    The dispatcher's no-handler path logs a warning and drops; what we
    care about is that (a) the connection stays open, (b) we can
    continue to send envelopes, (c) the kernel survives.
    """
    with _spawn_serve() as (host, port, token):
        conn = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)
        try:
            # Family F hydrate envelope -- thin v2 shape.
            conn.send({
                "type": "notebook.metadata",
                "payload": {
                    "mode": "hydrate",
                    "snapshot": {"schema_version": "1.0.0"},
                },
            })
            # Give the kernel a moment to process.
            time.sleep(0.5)
            # The send should not have raised; if the kernel crashed we'd
            # see the next send fail.
            conn.send({"type": "heartbeat.extension", "payload": {}})
        finally:
            conn.close()


def test_kernel_serve_missing_token_env_returns_2(tmp_path) -> None:
    """When the token env var is unset, the kernel exits with code 2."""
    env = {k: v for k, v in os.environ.items() if k != "LLMNB_AUTH_TOKEN"}
    env.setdefault("PYTHONPATH", os.pathsep.join(sys.path))
    cmd = [
        sys.executable, "-m", "llm_kernel", "serve",
        "--transport", "tcp",
        "--bind", "127.0.0.1:0",
        "--auth-token-env", "LLMNB_AUTH_TOKEN_DEFINITELY_UNSET",
    ]
    proc = subprocess.run(cmd, env=env, capture_output=True, timeout=30)
    assert proc.returncode == 2
    assert b"LLMNB_AUTH_TOKEN_DEFINITELY_UNSET" in proc.stderr
