"""
llm_client.transport.tcp — TCP + bearer-token transport.

Placeholder. TCP transport ships in S5.0.3d.

This file exists so that ``from llm_client.transport import tcp`` succeeds
and callers get a clear error message rather than an ImportError.
"""

from __future__ import annotations


def connect(
    address: str,
    *,
    auth_token: str | None = None,
    session_id: str | None = None,
    recv_timeout: float = 30.0,
):
    """Connect to a kernel over TCP with bearer-token auth.

    Raises
    ------
    NotImplementedError
        Always. TCP transport ships in S5.0.3d.
    """
    raise NotImplementedError(
        "TCP transport ships in S5.0.3d. "
        "Use transport='pty' (in-process) or transport='unix' (local socket)."
    )
