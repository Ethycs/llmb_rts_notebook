"""
llm_client.transport.pty — PTY / in-process transport for V1.

For V1 this is a thin wrapper over boot_minimal_kernel with
transport="pty". The PTY mode spawns the kernel in-process via
the existing MagicMock scaffold, mirroring _run_pty_mode from
llm_kernel.__main__ for the boot path.

S5.0.3d will replace the in-process call with a real PTY subprocess
and a socket-based KernelConnection.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from llm_client.boot import KernelConnection, boot_minimal_kernel


def connect(
    *,
    proxy: Literal["litellm", "passthrough", "stub"] = "litellm",
    work_dir: Path | None = None,
) -> KernelConnection:
    """Boot and return an in-process PTY-mode KernelConnection.

    Parameters
    ----------
    proxy:
        Proxy selection (``"litellm"``, ``"passthrough"``, ``"stub"``).
    work_dir:
        Working directory for spawn artifacts.

    Returns
    -------
    KernelConnection
        A handle to the booted kernel. Caller calls ``.close()`` to stop.
    """
    return boot_minimal_kernel(proxy=proxy, work_dir=work_dir, transport="pty")
