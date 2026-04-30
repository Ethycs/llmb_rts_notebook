"""tests/test_one_connection_at_a_time.py — single-client invariant (S5.0.3d).

Per PLAN-S5.0.3 §5.2 + the wire-handshake atom: V1 kernel accepts one
connection at a time. A second simultaneous client must receive a
``kernel_busy`` handshake response and the connection must close.
"""

from __future__ import annotations

import pytest

from llm_client.transport.tcp import TcpKernelBusyError, connect as tcp_connect

from tests.test_tcp_transport import _spawn_serve  # type: ignore[import]


pytestmark = pytest.mark.integration


def test_second_client_receives_kernel_busy() -> None:
    with _spawn_serve() as (host, port, token):
        first = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)
        try:
            with pytest.raises(TcpKernelBusyError) as excinfo:
                tcp_connect(bind=f"{host}:{port}", token=token, timeout=5.0)
            assert excinfo.value.reason == "kernel_busy"
        finally:
            first.close()


def test_kernel_accepts_new_client_after_first_disconnects() -> None:
    """Closing the first connection must let a fresh client through."""
    with _spawn_serve() as (host, port, token):
        first = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)
        first.close()

        # Give the kernel a moment to notice the close and free the slot.
        # The serve loop's per-connection thread exits when the socket
        # reads EOF; at that point the busy_lock check on the next
        # accept will see no live thread.
        import time
        deadline = time.monotonic() + 5.0
        last_exc: Exception | None = None
        while time.monotonic() < deadline:
            try:
                second = tcp_connect(bind=f"{host}:{port}", token=token, timeout=2.0)
                second.close()
                last_exc = None
                break
            except TcpKernelBusyError as exc:
                last_exc = exc
                time.sleep(0.1)
        if last_exc is not None:
            raise AssertionError(
                f"kernel never re-accepted after disconnect: {last_exc}"
            )
