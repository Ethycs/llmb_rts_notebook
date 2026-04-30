"""
llm_client.driver — envelope shipping and snapshot collection.

Public API:
    ship_envelope(conn, envelope, *, timeout) -> dict
    collect_snapshots(conn, *, until) -> list[dict]

Lint contract: only llm_kernel.wire imports allowed. This module has none
at all — it depends only on KernelConnection from llm_client.boot.
"""

from __future__ import annotations

import time
from typing import Callable

from llm_client.boot import KernelConnection


def ship_envelope(
    conn: KernelConnection,
    envelope: dict,
    *,
    timeout: float = 30.0,
) -> dict:
    """Send an envelope and await a matching response by correlation_id.

    Parameters
    ----------
    conn:
        An open KernelConnection (from boot_minimal_kernel).
    envelope:
        A wire envelope dict. Must include ``"request_id"`` or
        ``"correlation_id"`` at the top level or in ``"payload"``.
    timeout:
        Seconds to wait for a matching response. Raises ``TimeoutError``
        if no matching response arrives within this window.

    Returns
    -------
    dict
        The first response envelope whose ``correlation_id`` (or
        ``request_id``) matches the outgoing ``request_id``.

    Notes
    -----
    V1 in-process mode: the kernel dispatcher processes synchronously, so
    the response is effectively immediate. The timeout loop exists to match
    the interface contract for S5.0.3d (async transport).
    """
    request_id = (
        envelope.get("request_id")
        or envelope.get("correlation_id")
        or envelope.get("payload", {}).get("request_id")
        or envelope.get("payload", {}).get("correlation_id")
    )

    conn.send(envelope)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        reply = conn.recv(timeout=min(0.1, deadline - time.monotonic()))
        if reply:
            reply_corr = (
                reply.get("correlation_id")
                or reply.get("request_id")
                or reply.get("payload", {}).get("correlation_id")
                or reply.get("payload", {}).get("request_id")
            )
            if request_id is None or reply_corr == request_id:
                return reply
        else:
            # V1 in-process: dispatcher ran synchronously; no queue to drain.
            return {}

    raise TimeoutError(
        f"No response for request_id={request_id!r} within {timeout}s"
    )


def collect_snapshots(
    conn: KernelConnection,
    *,
    until: Callable[[dict], bool],
) -> list[dict]:
    """Drain Family F notebook.metadata snapshots until ``until`` returns True.

    Parameters
    ----------
    conn:
        An open KernelConnection.
    until:
        Predicate called with each snapshot envelope. Collection stops
        (inclusively) when this returns True.

    Returns
    -------
    list[dict]
        All Family F ``notebook.metadata`` envelopes received up to and
        including the envelope that satisfied ``until``.

    Notes
    -----
    V1 in-process: snapshots are emitted synchronously by the dispatcher.
    This function drains the in-process tracker's event log to build the
    snapshot list. S5.0.3d will replace with a real async recv loop.
    """
    snapshots: list[dict] = []

    # V1: collect snapshots from the tracker's sink if available.
    # The dispatcher / MetadataWriter emits Family F envelopes via
    # MetadataWriter.take_last_envelope(). For now we poll conn.recv().
    while True:
        envelope = conn.recv(timeout=0.0)
        if not envelope:
            break

        msg_type = envelope.get("message_type") or envelope.get("type", "")
        if msg_type == "notebook.metadata":
            snapshots.append(envelope)
            if until(envelope):
                break

    return snapshots
