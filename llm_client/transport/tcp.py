"""
llm_client.transport.tcp -- TCP + bearer-token transport (PLAN-S5.0.3d).

Drivers running out-of-process from the kernel use this module to
connect to a kernel started via ``python -m llm_kernel serve``. The
contract:

    1. Open a TCP socket to ``--bind``.
    2. Send a ``kernel.handshake`` envelope carrying client name,
       wire version, and bearer-token auth.
    3. Await the kernel's handshake response within ``timeout``.
    4. Verify the kernel's wire-version major matches the driver's;
       record ``session_id`` and ``accepted_capabilities``.
    5. Return a :class:`KernelConnection` ready for ``ship_envelope``.

On any error (timeout, version mismatch, auth fail, ``kernel_busy``),
the socket is closed and a :class:`TcpHandshakeError` (or subclass) is
raised carrying the kernel's reason.

Security
~~~~~~~~

- Token comparison is constant-time (``hmac.compare_digest``) on the
  KERNEL side. The driver simply sends the token; the kernel decides.
- Token is loaded by the caller (typically from ``LLMNB_AUTH_TOKEN``).
  Do NOT stash it in this module's globals.
- Default V1 model is trusted-network. PLAN-S5.0.3 §10 risk #3 is
  documented in ``llmnb serve --help`` and ``--help`` of this module's
  consumers.
"""

from __future__ import annotations

import json
import socket as _socket
import time
import uuid as _uuid
from typing import Any, Dict, List, Optional

from llm_kernel.wire import WIRE_MAJOR, WIRE_VERSION

from llm_client.boot import KernelConnection


__all__ = [
    "connect",
    "TcpHandshakeError",
    "TcpAuthFailedError",
    "TcpVersionMismatchError",
    "TcpKernelBusyError",
]


# ---------------------------------------------------------------------------
# Errors -- one per documented kernel-side failure mode.
# ---------------------------------------------------------------------------


class TcpHandshakeError(RuntimeError):
    """Generic TCP handshake failure. Subclasses carry the specific reason.

    Attributes
    ----------
    reason: str
        Kernel-side error code, one of:
        ``auth_failed | version_mismatch_major | kernel_busy | wire-failure``,
        or a transport-level failure (``timeout``, ``connection_refused``).
    payload: dict | None
        The raw handshake response payload (if one was received).
    """

    reason: str

    def __init__(self, reason: str, message: str, *, payload: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.reason = reason
        self.payload = payload


class TcpAuthFailedError(TcpHandshakeError):
    """Kernel rejected the bearer token (``auth_failed``)."""


class TcpVersionMismatchError(TcpHandshakeError):
    """Kernel rejected the wire-version major (``version_mismatch_major``)."""


class TcpKernelBusyError(TcpHandshakeError):
    """Kernel already serving another client (``kernel_busy``)."""


# ---------------------------------------------------------------------------
# TCP-backed KernelConnection.
# ---------------------------------------------------------------------------


class _TcpKernelConnection(KernelConnection):
    """KernelConnection backed by a TCP socket post-handshake.

    Bypasses the in-process scaffolding inherited from
    :class:`KernelConnection` (dispatcher, tracker, server) because the
    kernel runs out-of-process. ``send`` / ``recv`` push/pull
    newline-delimited JSON frames over the socket.
    """

    def __init__(
        self,
        session_id: str,
        sock: _socket.socket,
        *,
        wire_version: str,
        accepted_capabilities: List[str],
        warnings: List[str],
        recv_timeout: float = 30.0,
    ) -> None:
        # Bypass the parent __init__ -- no in-process subsystems here.
        self.session_id = session_id
        self.wire_version = wire_version
        self.accepted_capabilities = list(accepted_capabilities)
        self.handshake_warnings = list(warnings)
        self._sock = sock
        self._recv_timeout = recv_timeout
        self._buf = bytearray()
        self._closed = False
        # KernelConnection-internal fields that callers may probe.
        self._dispatcher = None
        self._tracker = None
        self._server = None
        self._supervisor = None

    def send(self, envelope: dict) -> None:
        if self._closed:
            raise RuntimeError("TCP KernelConnection is already closed")
        frame = json.dumps(envelope, default=str).encode("utf-8") + b"\n"
        self._sock.sendall(frame)

    def recv(self, *, timeout: Optional[float] = None) -> dict:
        if self._closed:
            raise RuntimeError("TCP KernelConnection is already closed")
        effective = timeout if timeout is not None else self._recv_timeout
        self._sock.settimeout(effective)
        while True:
            nl = self._buf.find(b"\n")
            if nl >= 0:
                line = bytes(self._buf[:nl])
                del self._buf[: nl + 1]
                if line.strip():
                    try:
                        return json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        return {}
            try:
                chunk = self._sock.recv(4096)
            except (_socket.timeout, TimeoutError):
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
            self._sock.shutdown(_socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Handshake driver-side (sends request, validates response).
# ---------------------------------------------------------------------------


def _read_one_frame(
    sock: _socket.socket, buf: bytearray, *, timeout: float,
) -> Optional[Dict[str, Any]]:
    """Read exactly one newline-delimited JSON frame, blocking up to ``timeout``."""
    deadline = time.monotonic() + timeout
    while True:
        nl = buf.find(b"\n")
        if nl >= 0:
            line = bytes(buf[:nl])
            del buf[: nl + 1]
            if not line.strip():
                continue
            try:
                return json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except (_socket.timeout, TimeoutError):
            return None
        except OSError:
            return None
        if not chunk:
            return None
        buf.extend(chunk)


def _parse_bind(bind: str) -> tuple[str, int]:
    """Accept ``HOST:PORT`` or ``tcp://HOST:PORT`` and return (host, port)."""
    raw = bind
    if raw.startswith("tcp://"):
        raw = raw[len("tcp://"):]
    if ":" not in raw:
        raise ValueError(f"bind must be HOST:PORT (got {bind!r})")
    host, port_str = raw.rsplit(":", 1)
    return host, int(port_str)


def connect(
    *,
    bind: str,
    token: str,
    wire_version_request: str = WIRE_VERSION,
    client_name: str = "llmnb-cli",
    client_version: str = "0.1.0",
    capabilities: Optional[List[str]] = None,
    timeout: float = 30.0,
) -> KernelConnection:
    """Open a TCP connection to a serve'd kernel; perform handshake.

    Parameters
    ----------
    bind:
        ``HOST:PORT`` or ``tcp://HOST:PORT`` (e.g. ``127.0.0.1:7474``).
    token:
        Bearer token. The caller MUST source this from a secure channel
        (``os.environ[LLMNB_AUTH_TOKEN]``, a keychain, etc). Never
        accept it on argv -- leaks via ``ps``.
    wire_version_request:
        Wire version the driver requests. Defaults to
        :data:`llm_kernel.wire.WIRE_VERSION`.
    client_name, client_version:
        Driver identity. Logged kernel-side; no security significance.
    capabilities:
        Capability set the driver advertises. V1 default: full set.
    timeout:
        Total budget (seconds) for the connect + handshake. The kernel
        gets at most this long to respond; on timeout the socket is
        closed and ``TcpHandshakeError(reason='timeout')`` raises.

    Returns
    -------
    KernelConnection
        Ready for ``ship_envelope`` etc. ``conn.session_id`` carries the
        kernel-issued session id; ``conn.accepted_capabilities`` carries
        the kernel's response.

    Raises
    ------
    TcpAuthFailedError
        Kernel rejected the token.
    TcpVersionMismatchError
        Major-version mismatch between driver and kernel.
    TcpKernelBusyError
        Another driver is already connected (V1: one-at-a-time).
    TcpHandshakeError
        Generic handshake failure (timeout, malformed response, etc).
    ConnectionRefusedError
        TCP-level connect failed.
    """
    host, port = _parse_bind(bind)
    if capabilities is None:
        capabilities = [
            "family_a", "family_b", "family_c", "family_f", "family_g",
        ]

    sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
        except (ConnectionRefusedError, OSError):
            sock.close()
            raise

        request = {
            "type": "kernel.handshake",
            "payload": {
                "client_name": client_name,
                "client_version": client_version,
                "wire_version": wire_version_request,
                "transport": "tcp",
                "auth": {
                    "scheme": "bearer",
                    "token": token,
                },
                "capabilities": list(capabilities),
            },
        }
        sock.sendall((json.dumps(request) + "\n").encode("utf-8"))

        buf = bytearray()
        response = _read_one_frame(sock, buf, timeout=timeout)
        if response is None:
            sock.close()
            raise TcpHandshakeError(
                "timeout",
                f"no handshake response from {bind} within {timeout}s",
            )

        if not isinstance(response, dict) or response.get("type") != "kernel.handshake":
            sock.close()
            raise TcpHandshakeError(
                "wire-failure",
                f"malformed handshake response from kernel: {response!r}",
                payload=response if isinstance(response, dict) else None,
            )

        payload = response.get("payload") or {}
        if not isinstance(payload, dict):
            sock.close()
            raise TcpHandshakeError(
                "wire-failure",
                f"handshake response missing payload object: {response!r}",
            )

        # Kernel-reported error.
        error = payload.get("error")
        if error:
            sock.close()
            cls = {
                "auth_failed": TcpAuthFailedError,
                "version_mismatch_major": TcpVersionMismatchError,
                "kernel_busy": TcpKernelBusyError,
            }.get(error, TcpHandshakeError)
            raise cls(error, f"kernel rejected handshake: {error}", payload=payload)

        # Driver-side major-version check (defence in depth -- kernel
        # already enforced this, but a kernel that accidentally accepted
        # a mismatched major must not pass our gate).
        kernel_wire = payload.get("wire_version", "")
        try:
            kernel_major = int(str(kernel_wire).split(".", 1)[0])
        except (ValueError, IndexError):
            sock.close()
            raise TcpHandshakeError(
                "wire-failure",
                f"kernel returned malformed wire_version: {kernel_wire!r}",
                payload=payload,
            )
        if kernel_major != WIRE_MAJOR:
            sock.close()
            raise TcpVersionMismatchError(
                "version_mismatch_major",
                (
                    f"kernel wire_version major={kernel_major} differs from "
                    f"driver major={WIRE_MAJOR}"
                ),
                payload=payload,
            )

        accepted = payload.get("accepted_capabilities") or []
        if not isinstance(accepted, list):
            accepted = []
        warnings = payload.get("warnings") or []
        if not isinstance(warnings, list):
            warnings = []

        session_id = str(payload.get("session_id") or _uuid.uuid4())

        # Capabilities check: the kernel MUST echo every capability the
        # driver advertises (V1). A missing capability would mean the
        # kernel speaks a strict subset; raise rather than proceed.
        missing = [c for c in capabilities if c not in accepted]
        if missing:
            sock.close()
            raise TcpHandshakeError(
                "wire-failure",
                (
                    "kernel did not accept required capabilities: "
                    f"{missing}; accepted={accepted}"
                ),
                payload=payload,
            )

        return _TcpKernelConnection(
            session_id=session_id,
            sock=sock,
            wire_version=str(kernel_wire) or WIRE_VERSION,
            accepted_capabilities=list(accepted),
            warnings=list(warnings),
            recv_timeout=timeout,
        )
    except TcpHandshakeError:
        raise
    except Exception:
        try:
            sock.close()
        except OSError:
            pass
        raise
