"""
tests/test_boot_minimal_kernel.py — smoke-level test for boot_minimal_kernel.

Verifies that:
1. boot_minimal_kernel() returns a KernelConnection with session_id and
   wire_version populated.
2. wire_version matches llm_kernel.wire.WIRE_VERSION.
3. .close() is idempotent (no exception on double-close).
4. The connection reports itself as closed after .close().
"""

from __future__ import annotations

import pytest

from llm_kernel.wire import WIRE_VERSION


def test_boot_returns_connection() -> None:
    """boot_minimal_kernel returns a KernelConnection with expected attributes."""
    from llm_client import boot_minimal_kernel, KernelConnection

    conn = boot_minimal_kernel(proxy="litellm")
    try:
        assert isinstance(conn, KernelConnection)
        assert isinstance(conn.session_id, str)
        assert len(conn.session_id) == 36, "session_id should be a UUID string"
        assert conn.wire_version == WIRE_VERSION
    finally:
        conn.close()


def test_boot_wire_version_matches() -> None:
    """KernelConnection.wire_version matches the kernel wire's WIRE_VERSION."""
    from llm_client import boot_minimal_kernel

    conn = boot_minimal_kernel()
    try:
        assert conn.wire_version == WIRE_VERSION
    finally:
        conn.close()


def test_close_is_idempotent() -> None:
    """Calling .close() twice must not raise."""
    from llm_client import boot_minimal_kernel

    conn = boot_minimal_kernel()
    conn.close()
    conn.close()  # second call must be a no-op


def test_closed_connection_send_raises() -> None:
    """Sending on a closed connection raises RuntimeError."""
    from llm_client import boot_minimal_kernel

    conn = boot_minimal_kernel()
    conn.close()
    with pytest.raises(RuntimeError, match="closed"):
        conn.send({"type": "test", "payload": {}})


def test_closed_connection_recv_raises() -> None:
    """Receiving from a closed connection raises RuntimeError."""
    from llm_client import boot_minimal_kernel

    conn = boot_minimal_kernel()
    conn.close()
    with pytest.raises(RuntimeError, match="closed"):
        conn.recv()


def test_boot_different_session_ids() -> None:
    """Two consecutive boots produce distinct session_ids."""
    from llm_client import boot_minimal_kernel

    conn1 = boot_minimal_kernel()
    conn2 = boot_minimal_kernel()
    try:
        assert conn1.session_id != conn2.session_id
    finally:
        conn1.close()
        conn2.close()


def test_boot_tcp_requires_bind_and_token() -> None:
    """Requesting TCP transport without bind/token raises ValueError (S5.0.3d).

    S5.0.3d wired transport='tcp' to llm_client.transport.tcp.connect.
    The wrapper enforces that ``bind`` and ``auth_token`` are supplied
    BEFORE attempting the connect (so operators get a clear local error
    rather than ``ConnectionRefusedError``).
    """
    from llm_client import boot_minimal_kernel

    with pytest.raises(ValueError, match="bind"):
        boot_minimal_kernel(transport="tcp")
    with pytest.raises(ValueError, match="auth_token"):
        boot_minimal_kernel(transport="tcp", bind="127.0.0.1:65535")
