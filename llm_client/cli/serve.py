"""
llm_client.cli.serve — `llmnb serve` subcommand stub (PLAN-S5.0.3 §6.1).

V1 stub: TCP serve ships in S5.0.3d. This subcommand is wired so the
CLI surface is complete and operators see a clear deferral message
rather than a "subcommand not found" error.
"""

from __future__ import annotations

import argparse
import sys


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--bind",
        default="127.0.0.1:7474",
        help="Bind address HOST:PORT (default 127.0.0.1:7474).",
    )
    parser.add_argument(
        "--auth-token-env",
        default="LLMNB_AUTH_TOKEN",
        help="Environment variable holding the auth token.",
    )


def run(args: argparse.Namespace) -> int:
    print(
        "TCP serve ships in S5.0.3d. Use `python -m llm_kernel pty-mode` "
        "for V1 in-process mode, or wait for the next slice.",
        file=sys.stderr,
    )
    return 1
