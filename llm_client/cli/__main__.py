"""
llm_client.cli.__main__ — `python -m llm_client` argparse dispatcher.

Subcommands per PLAN-S5.0.3 §6.1. Each subcommand module exposes:
    add_arguments(parser) -> None
    run(args) -> int

Exit codes:
    0  success
    1  cell-level failure (some cells failed; notebook still wrote)
    2  operator-action error (escalation guard, malformed input,
       missing replay file, etc.)
    3  unimplemented (e.g., live mode in V1 — see executor.py)
"""

from __future__ import annotations

import argparse
import sys

from . import auth, convert, execute, serve, smoke, validate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="llmnb",
        description="LLMNB driver CLI (PLAN-S5.0.3).",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_exec = sub.add_parser("execute", help="Run a notebook end-to-end.")
    execute.add_arguments(p_exec)
    p_exec.set_defaults(_run=execute.run)

    p_conv = sub.add_parser("convert", help="Convert between notebook formats.")
    convert.add_arguments(p_conv)
    p_conv.set_defaults(_run=convert.run)

    p_val = sub.add_parser("validate", help="Validate magic syntax in a notebook.")
    validate.add_arguments(p_val)
    p_val.set_defaults(_run=validate.run)

    p_smoke = sub.add_parser("smoke", help="Run a named smoke test.")
    smoke.add_arguments(p_smoke)
    p_smoke.set_defaults(_run=smoke.run)

    p_auth = sub.add_parser("auth", help="Manage auth tokens.")
    auth.add_arguments(p_auth)
    p_auth.set_defaults(_run=auth.run)

    p_serve = sub.add_parser("serve", help="Start a TCP-mode kernel (S5.0.3d stub).")
    serve.add_arguments(p_serve)
    p_serve.set_defaults(_run=serve.run)

    args = parser.parse_args(argv)
    return int(args._run(args))


if __name__ == "__main__":
    raise SystemExit(main())
