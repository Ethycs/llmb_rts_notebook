"""
llm_client.transport.unix — Unix socket transport for V1.

Connects to a kernel that is already running and listening on a Unix
domain socket (UDS). Mirrors the UDS server logic in llm_kernel.__main__
_run_pty_mode_smoke for the client side.

On Windows, where AF_UNIX may be unavailable or the kernel fell back to
loopback TCP, this module transparently switches to a TCP loopback
connection on the same address. The env var ``LLMKERNEL_IPC_SOCKET``
is the kernel's advertised address (same format as RFC-008 §2:
``/path/to/sock`` for UDS, ``tcp:127.0.0.1:<port>`` for TCP fallback).

V1 implementation: connects synchronously, returns a KernelConnection
whose send()/recv() forward JSON newline-delimited frames over the socket.
"""

from __future__ import annotations

import json
import socket as _socket
import sys
import time

from llm_client.boot import KernelConnection


class _UnixSocketConnection(KernelConnection):
    """KernelConnection backed by a Unix/TCP socket."""

    def __init__(
        self,
        session_id: str,
        sock: _socket.socket,
        *,
        recv_timeout: float = 30.0,
    ) -> None:
        # We bypass the parent __init__ since there's no in-process dispatcher.
        self.session_id = session_id
        from llm_kernel.wire import WIRE_VERSION
        self.wire_version = WIRE_VERSION
        self._sock = sock
        self._recv_timeout = recv_timeout
        self._buf = bytearray()
        self._closed = False
        # Not used in socket mode:
        self._dispatcher = None
        self._tracker = None
        self._server = None
        self._supervisor = None

    def send(self, envelope: dict) -> None:
        if self._closed:
            raise RuntimeError("UnixSocketConnection is already closed")
        frame = json.dumps(envelope, default=str).encode() + b"\n"
        self._sock.sendall(frame)

    def recv(self, *, timeout: float | None = None) -> dict:
        if self._closed:
            raise RuntimeError("UnixSocketConnection is already closed")
        effective_timeout = timeout if timeout is not None else self._recv_timeout
        self._sock.settimeout(effective_timeout)
        deadline = time.monotonic() + (effective_timeout or 0.0)
        while True:
            nl = self._buf.find(b"\n")
            if nl >= 0:
                line = bytes(self._buf[:nl])
                del self._buf[: nl + 1]
                if line.strip():
                    return json.loads(line)
            try:
                chunk = self._sock.recv(4096)
            except _socket.timeout:
                return {}
            except OSError:
                return {}
            if not chunk:
                return {}
            self._buf.extend(chunk)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._sock.close()
        except OSError:
            pass


def connect(
    address: str,
    *,
    session_id: str | None = None,
    recv_timeout: float = 30.0,
) -> _UnixSocketConnection:
    """Connect to a running kernel over a Unix socket or TCP loopback.

    Parameters
    ----------
    address:
        Socket address. Formats (per RFC-008 §2):
        - ``/path/to/sock`` — Unix domain socket (POSIX only).
        - ``tcp:127.0.0.1:<port>`` — TCP loopback (Windows / fallback).
    session_id:
        Session ID to use. Defaults to a new UUID if not provided.
    recv_timeout:
        Receive timeout in seconds.

    Returns
    -------
    _UnixSocketConnection
        Connected KernelConnection. Caller calls ``.close()`` when done.

    Raises
    ------
    ConnectionRefusedError:
        If the kernel is not listening at ``address``.
    OSError:
        For other socket errors.
    """
    import uuid as _uuid

    sid = session_id or str(_uuid.uuid4())

    if address.startswith("tcp:"):
        # ``tcp:127.0.0.1:<port>``
        _, host_port = address.split(":", 1)
        host, port_str = host_port.rsplit(":", 1)
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        sock.connect((host, int(port_str)))
    elif hasattr(_socket, "AF_UNIX") and sys.platform != "win32":
        sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        sock.connect(address)
    else:
        raise OSError(
            f"Unix domain sockets unavailable on {sys.platform}; "
            "use tcp: prefix for TCP loopback addresses."
        )

    return _UnixSocketConnection(sid, sock, recv_timeout=recv_timeout)
