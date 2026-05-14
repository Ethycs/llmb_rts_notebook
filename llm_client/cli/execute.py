"""
llm_client.cli.execute — `llmnb execute` subcommand (PLAN-S5.0.3 §6.1).

Wraps llm_client.executor.run_notebook with argparse plumbing. Returns
exit code 0 on success, 1 if any cells failed, 2 on operator-action
errors (escalation guard, replay mismatch, malformed notebook, bad
``--connect`` URL / missing token).

``--connect tcp://HOST:PORT`` attaches to a kernel started via
``llmnb serve`` instead of spawning a fresh PTY-loopback kernel. The
bearer token is sourced from an env var (default ``LLMNB_AUTH_TOKEN``;
override with ``--auth-token-env``). Tokens are never accepted on argv
— they would leak via ``ps`` per transport-mode invariants.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional

from llm_client.executor import (
    EscalationRequiresOperatorError,
    ReplayMismatchError,
    run_notebook,
)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "path",
        type=Path,
        help="Notebook path (.llmnb / .magic / .ipynb auto-detected).",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="Write result here (default: overwrite input).",
    )
    parser.add_argument(
        "--mode",
        choices=["stub", "live", "replay"],
        default="live",
        help="Execution mode (default: live).",
    )
    parser.add_argument(
        "--replay",
        type=Path,
        default=None,
        help="Replay recording file (.replay.jsonl); required when --mode replay.",
    )
    parser.add_argument(
        "--record",
        type=Path,
        default=None,
        help="Capture (sent, received) envelope pairs to this file (JSONL).",
    )
    parser.add_argument(
        "--unattended",
        action="store_true",
        help=(
            "Auto-reject all request_approval envelopes. Required when the "
            "notebook contains escalate-bearing cells."
        ),
    )
    parser.add_argument(
        "--cell-timeout",
        type=float,
        default=60.0,
        help="Per-cell hard timeout in seconds (live mode). Default: 60.",
    )
    parser.add_argument(
        "--quiescence-window",
        type=float,
        default=2.0,
        help=(
            "Seconds of empty kernel recv before considering a cell "
            "complete in live mode. Default: 2.0."
        ),
    )
    parser.add_argument(
        "--total-timeout",
        type=float,
        default=600.0,
        help="Overall live-run timeout in seconds. Default: 600.",
    )
    parser.add_argument(
        "--connect",
        type=str,
        default=None,
        metavar="URL",
        help=(
            "Attach to a running `llmnb serve` instead of spawning a "
            "fresh kernel. Format: tcp://HOST:PORT (bare HOST:PORT also "
            "accepted; tcp:// is assumed). Requires --mode live. Kernel "
            "state persists across invocations — agents stay alive "
            "between executions."
        ),
    )
    parser.add_argument(
        "--auth-token-env",
        type=str,
        default="LLMNB_AUTH_TOKEN",
        metavar="VAR",
        help=(
            "Name of the env var holding the bearer token for --connect "
            "(default: LLMNB_AUTH_TOKEN). Tokens MUST NOT be passed on "
            "argv — they would leak via `ps`."
        ),
    )


def _parse_connect_url(url: str) -> tuple[str, str]:
    """Parse ``--connect`` URL into ``(transport, bind)``.

    Accepts:
        tcp://HOST:PORT       -> ("tcp",  "HOST:PORT")
        HOST:PORT             -> ("tcp",  "HOST:PORT")   # bare, defaults tcp
        unix:///path/to/sock  -> ("unix", "/path/to/sock")

    Raises ``ValueError`` on unsupported schemes.
    """
    if url.startswith("tcp://"):
        return "tcp", url[len("tcp://"):]
    if url.startswith("unix://"):
        return "unix", url[len("unix://"):]
    if "://" in url:
        scheme = url.split("://", 1)[0]
        raise ValueError(
            f"unsupported transport scheme: {scheme!r} "
            "(expected tcp:// or unix://)"
        )
    return "tcp", url


def _open_connection(args: argparse.Namespace) -> Any:
    """Open a kernel connection per ``--connect``, or raise ValueError.

    Returns a ``KernelConnection`` ready to be passed to
    ``run_notebook(connection=...)``. Raises ``ValueError`` with a
    user-facing message on bad URL / missing token / unsupported
    transport. Lets transport-level errors (auth fail, kernel busy,
    version mismatch, refused) propagate to the caller.
    """
    transport, bind = _parse_connect_url(args.connect)

    if transport == "unix":
        raise ValueError(
            "--connect unix:// is not yet wired through `llmnb execute` "
            "(connect_to_kernel only supports tcp in V1.5). Use "
            "tcp://HOST:PORT for now."
        )
    if transport != "tcp":
        raise ValueError(f"unsupported transport: {transport!r}")

    token = os.environ.get(args.auth_token_env, "")
    if not token:
        raise ValueError(
            f"--connect requires bearer token in ${args.auth_token_env} "
            "(env var is unset or empty); tokens are never accepted on argv"
        )

    # Import here so the lazy-load of the transport stack only happens
    # on the --connect path (keeps `--help` and stub-mode runs cheap).
    from llm_client.boot import connect_to_kernel
    return connect_to_kernel(bind, token=token, transport="tcp")


def run(args: argparse.Namespace) -> int:
    connection: Optional[Any] = None

    if args.connect:
        if args.mode != "live":
            print(
                f"error: --connect requires --mode live (got {args.mode!r}); "
                "stub and replay modes do not use a kernel",
                file=sys.stderr,
            )
            return 2
        try:
            connection = _open_connection(args)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        except ConnectionRefusedError as e:
            print(
                f"error: cannot reach kernel at {args.connect}: {e} "
                "(is `llmnb serve` running?)",
                file=sys.stderr,
            )
            return 2
        except Exception as e:
            # TcpAuthFailedError / TcpVersionMismatchError / TcpKernelBusyError
            # / TcpHandshakeError — all subclasses of RuntimeError. Surface
            # the reason verbatim; the kernel's wire-failure label is the
            # canonical error code.
            print(
                f"error: handshake with {args.connect} failed: {e}",
                file=sys.stderr,
            )
            return 2

    try:
        try:
            result = run_notebook(
                args.path,
                output=args.output,
                mode=args.mode,
                replay_recording=args.replay,
                record_to=args.record,
                unattended=args.unattended,
                cell_timeout=args.cell_timeout,
                quiescence_window=args.quiescence_window,
                total_timeout=args.total_timeout,
                connection=connection,
            )
        except EscalationRequiresOperatorError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        except (ReplayMismatchError, FileNotFoundError, ValueError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        except NotImplementedError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

    print(
        f"executed {result.cells_executed} cells "
        f"({result.cells_succeeded} ok, {result.cells_failed} failed) "
        f"-> {result.notebook_path}"
    )
    if result.errors:
        for err in result.errors:
            print(
                f"  {err.get('cell_id')}: "
                f"{err.get('k_code') or ''} {err.get('message') or ''}",
                file=sys.stderr,
            )
        return 1
    return 0
