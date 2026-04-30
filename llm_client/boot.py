"""
llm_client.boot — in-process kernel boot helper.

Public API:
    boot_minimal_kernel(**kwargs) -> KernelConnection
    KernelConnection

Lint contract: only llm_kernel.wire imports are allowed from llm_client.
The one exception is the _test_helpers scaffolding used inside this
module to create the MagicMock kernel shape that the kernel's dispatcher
currently requires. That scaffolding is explicitly exempted per PLAN-S5.0.3
§3.3 and documented in _test_helpers/mock_kernel.py.

V1 note: boot_minimal_kernel is an in-process boot path used by smokes and
tests. It still needs MagicMock-based kernel scaffolding because
CustomMessageDispatcher and AgentSupervisor expect a kernel-shaped object
even when no real IPython kernel is running. Future: the clean external path
is connect_to_kernel(transport_url, token) in S5.0.3d, which requires no
scaffolding.
"""

from __future__ import annotations

import os
import uuid as _uuid
from pathlib import Path
from typing import Literal

from llm_kernel.wire import WIRE_VERSION

# Internal scaffolding — lint exemption documented in the module.
from llm_client._test_helpers.mock_kernel import make_mock_kernel


class KernelConnection:
    """Handle for a booted in-process kernel.

    Attributes:
        session_id: UUID string identifying this kernel session.
        wire_version: The WIRE_VERSION the kernel was booted with.

    Usage::

        conn = boot_minimal_kernel()
        conn.send({"type": "kernel.ping", "payload": {}})
        reply = conn.recv(timeout=5.0)
        conn.close()
    """

    session_id: str
    wire_version: str

    def __init__(
        self,
        session_id: str,
        dispatcher,   # noqa: ANN001 — kernel-internal type, not re-exported
        tracker,      # noqa: ANN001
        server,       # noqa: ANN001 — LiteLLMProxyServer | AnthropicPassthroughServer
        *,
        supervisor=None,  # noqa: ANN001
    ) -> None:
        self.session_id = session_id
        self.wire_version = WIRE_VERSION
        self._dispatcher = dispatcher
        self._tracker = tracker
        self._server = server
        self._supervisor = supervisor
        self._closed = False

    # ------------------------------------------------------------------
    # Transport stubs (PTY/in-process mode for V1)
    # ------------------------------------------------------------------

    def send(self, envelope: dict) -> None:
        """Enqueue an envelope for dispatch.

        In V1 in-process mode this is a direct dispatcher call;
        S5.0.3d will replace with a real transport write.
        """
        if self._closed:
            raise RuntimeError("KernelConnection is already closed")
        # In-process: dispatch directly via the CustomMessageDispatcher.
        # The dispatcher's handle() method accepts a dict envelope.
        if hasattr(self._dispatcher, "handle"):
            self._dispatcher.handle(envelope)

    def recv(self, *, timeout: float | None = None) -> dict:
        """Receive the next envelope from the kernel.

        In V1 in-process mode the dispatcher writes synchronously so
        there is no async queue to drain. This stub returns an empty
        dict and will be replaced by real transport I/O in S5.0.3d.
        """
        if self._closed:
            raise RuntimeError("KernelConnection is already closed")
        # V1: in-process mode has no async receive channel yet.
        # Callers that need envelopes use the run_tracker directly.
        return {}

    def close(self) -> None:
        """Tear down the kernel: stop the proxy/passthrough server."""
        if self._closed:
            return
        self._closed = True
        try:
            self._server.stop()
        except Exception:  # noqa: BLE001
            pass


def boot_minimal_kernel(
    *,
    proxy: Literal["litellm", "passthrough", "stub"] = "litellm",
    work_dir: Path | None = None,
    transport: Literal["pty", "unix", "tcp"] = "pty",
    bind: str | None = None,
    auth_token: str | None = None,
) -> KernelConnection:
    """Boot a kernel + proxy + dispatcher + tracker. Return a connection.

    Parameters
    ----------
    proxy:
        Which proxy to start. ``"litellm"`` starts the LiteLLM proxy
        (requires ANTHROPIC_API_KEY). ``"passthrough"`` starts the
        transparent Anthropic passthrough (works with OAuth and API keys).
        ``"stub"`` is reserved for S5.0.3c stub mode.
    work_dir:
        Working directory for spawn artifacts (mcp-config.json,
        system-prompt.txt, kernel.stderr.<id>.log). Defaults to
        ``.run-smoke`` in the current directory.
    transport:
        Transport mode. ``"pty"`` is the in-process default. ``"unix"``
        and ``"tcp"`` are V1 stubs (S5.0.3d ships TCP fully).
    bind:
        Bind address for TCP transport (e.g. ``"127.0.0.1:7474"``).
        Ignored unless ``transport="tcp"``.
    auth_token:
        Bearer token for TCP auth. Ignored unless ``transport="tcp"``.

    Returns
    -------
    KernelConnection
        A handle to the booted kernel. Caller must call ``.close()`` to
        stop the proxy server.

    Notes
    -----
    V1 implementation: ``boot_minimal_kernel`` uses MagicMock kernel
    scaffolding because ``CustomMessageDispatcher`` expects an IPython
    kernel-shaped object. This scaffolding lives in
    ``llm_client._test_helpers.mock_kernel`` and is explicitly exempt from
    the lint boundary (see PLAN-S5.0.3 §3.3). The clean path is
    ``connect_to_kernel()`` (S5.0.3d), which runs fully out-of-process.
    """
    # Lazy imports of kernel internals — these go through the transport
    # layer in S5.0.3d; for now they're in-process via vendor submodule.
    # NOTE: these imports violate the lint boundary; boot.py is the
    # designated crossing point. They are isolated here so that _no other_
    # llm_client module needs to reach into llm_kernel internals.
    from llm_kernel import litellm_proxy as _proxy_mod
    from llm_kernel import anthropic_passthrough as _pt_mod
    from llm_kernel.custom_messages import CustomMessageDispatcher
    from llm_kernel.run_tracker import RunTracker

    if transport == "tcp":
        # Out-of-process external-driver path: boot_minimal_kernel
        # delegates to llm_client.transport.tcp.connect, which performs
        # the handshake against an already-running ``llm_kernel serve``
        # process. boot_minimal_kernel's ``proxy``/``work_dir``/MagicMock
        # scaffolding is irrelevant on this branch -- the kernel runs
        # remotely and supplies its own internals.
        if not bind:
            raise ValueError("transport='tcp' requires bind=HOST:PORT")
        if not auth_token:
            raise ValueError(
                "transport='tcp' requires auth_token "
                "(typically os.environ['LLMNB_AUTH_TOKEN'])"
            )
        from llm_client.transport.tcp import connect as _tcp_connect
        return _tcp_connect(bind=bind, token=auth_token)

    session_id = str(_uuid.uuid4())
    kernel = make_mock_kernel()

    # Passthrough vs LiteLLM selection mirrors _run_agent_supervisor_smoke.
    use_passthrough = proxy == "passthrough"

    # Initial dispatcher + tracker (placeholder; rebuilt after server start
    # to get the real base_url — mirrors the original smoke pattern).
    # We use a throw-away MagicMock kernel for the placeholder dispatcher;
    # the real kernel is wired in after server.start() below.
    from unittest.mock import MagicMock as _MagicMock
    dispatcher = CustomMessageDispatcher(_MagicMock())  # placeholder

    tracker = RunTracker(
        trace_id=session_id,
        sink=dispatcher,
        agent_id="driver",
        zone_id="driver",
    )

    if use_passthrough:
        server = _pt_mod.AnthropicPassthroughServer(
            run_tracker=tracker, host="127.0.0.1", port=0,
        )
    else:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        server = _proxy_mod.LiteLLMProxyServer(
            api_key=api_key, host="127.0.0.1", port=0,
        )

    server.start()

    # Re-bind dispatcher + tracker to real kernel (matches original smoke).
    dispatcher = CustomMessageDispatcher(kernel)
    tracker = RunTracker(
        trace_id=session_id,
        sink=dispatcher,
        agent_id="driver",
        zone_id="driver",
    )
    if use_passthrough:
        server.run_tracker = tracker  # type: ignore[attr-defined]

    return KernelConnection(
        session_id=session_id,
        dispatcher=dispatcher,
        tracker=tracker,
        server=server,
    )


# ---------------------------------------------------------------------------
# Clean external-driver entry point (PLAN-S5.0.3d).
#
# ``connect_to_kernel`` is the public path drivers running in a separate
# process from the kernel use. It does NOT use the in-process MagicMock
# scaffolding; it just opens the transport, performs handshake, and
# returns a KernelConnection backed by a real socket.
#
# Use this from:
#   - ``llmnb execute`` against a kernel started via ``llmnb serve``
#   - external Rust/Go orchestrators (via the JSON envelope contract)
#   - integration tests that boot a kernel as a subprocess
#
# Use ``boot_minimal_kernel`` instead from:
#   - in-process smokes (``agent-supervisor-smoke``, etc.)
#   - tests that need to introspect run_tracker / dispatcher state
# ---------------------------------------------------------------------------


def connect_to_kernel(
    bind: str,
    *,
    token: str,
    transport: Literal["tcp"] = "tcp",
    timeout: float = 30.0,
) -> KernelConnection:
    """Connect to a remote kernel over a transport. Clean external entry.

    Unlike :func:`boot_minimal_kernel`, this does NOT scaffold a
    MagicMock kernel or start a proxy server in-process. The kernel is
    expected to be already running (``python -m llm_kernel serve ...``).
    The driver opens the transport, performs the handshake, and returns
    a connection ready for ``ship_envelope``.

    Parameters
    ----------
    bind:
        Address. ``HOST:PORT`` or ``tcp://HOST:PORT`` for TCP.
    token:
        Bearer token (TCP). Source from ``os.environ[LLMNB_AUTH_TOKEN]``
        or ``.env`` -- never argv (leaks via ``ps``).
    transport:
        Currently only ``"tcp"``. Unix-socket support is queued.
    timeout:
        Connect + handshake budget in seconds.

    Returns
    -------
    KernelConnection
        Real socket-backed handle. Caller MUST call ``.close()``.

    Raises
    ------
    TcpHandshakeError (and subclasses):
        Handshake-level failure -- token wrong, version mismatch, busy.
    ConnectionRefusedError:
        Kernel not listening at ``bind``.

    See Also
    --------
    boot_minimal_kernel : in-process boot for smokes and tests.
    """
    if transport == "tcp":
        from llm_client.transport.tcp import connect as _tcp_connect
        return _tcp_connect(bind=bind, token=token, timeout=timeout)
    raise ValueError(f"unsupported transport for connect_to_kernel: {transport!r}")
