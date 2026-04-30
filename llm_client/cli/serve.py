"""
llm_client.cli.serve -- ``llmnb serve`` subcommand (PLAN-S5.0.3 §6.1, §5.2).

Thin wrapper that invokes the kernel-side ``python -m llm_kernel serve``
entry. The wrapper exists so operators see a unified ``llmnb`` CLI; the
heavy lifting (TCP bind, handshake, token check) lives in the kernel.

Token discipline
~~~~~~~~~~~~~~~~

This subcommand never accepts a token on argv. It accepts the **name**
of an environment variable (``--auth-token-env``, default
``LLMNB_AUTH_TOKEN``) and forwards that name to the kernel, which then
reads the token from its own environment. Bypassing this would leak the
token to ``ps`` -- documented in PLAN-S5.0.3 §5.3 and the wire-handshake
atom.

Trusted-network model
~~~~~~~~~~~~~~~~~~~~~

V1 binds to ``127.0.0.1`` by default. ``--bind 0.0.0.0:...`` is an
explicit operator opt-in for trusted-network deployments (CI runners,
single-tenant cloud, devcontainers). There is no mTLS; this mode is
NOT for hostile networks. PLAN-S5.0.3 §10 risk #3 documents the bound.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--bind",
        default="127.0.0.1:7474",
        help=(
            "Bind address HOST:PORT (default 127.0.0.1:7474). "
            "Use 0.0.0.0 to expose externally; that is a trusted-network "
            "decision the operator makes explicitly."
        ),
    )
    parser.add_argument(
        "--auth-token-env",
        default="LLMNB_AUTH_TOKEN",
        help=(
            "Name of the environment variable holding the bearer token "
            "(default LLMNB_AUTH_TOKEN). The token is NEVER accepted on "
            "argv -- ps would leak it."
        ),
    )
    parser.add_argument(
        "--proxy",
        choices=["litellm", "passthrough", "none"],
        default="none",
        help=(
            "Optional proxy to start alongside the kernel. Default: none. "
            "Most external drivers run their own proxy."
        ),
    )


def run(args: argparse.Namespace) -> int:
    # Confirm the env var is set BEFORE spawning so the operator gets a
    # local error message rather than the kernel exiting with rc=2 from
    # inside a subprocess. The kernel will re-validate; this is a
    # convenience check, not a security check.
    if not os.environ.get(args.auth_token_env):
        print(
            f"error: env var {args.auth_token_env!r} is unset or empty. "
            "Run `llmnb auth init` to generate a token, or set the var "
            "directly.",
            file=sys.stderr,
        )
        return 2

    # Subprocess path: launch `python -m llm_kernel serve`. The kernel
    # process owns its own lifecycle; we forward signals via the OS.
    cmd = [
        sys.executable, "-m", "llm_kernel", "serve",
        "--transport", "tcp",
        "--bind", args.bind,
        "--auth-token-env", args.auth_token_env,
        "--proxy", args.proxy,
    ]
    try:
        proc = subprocess.Popen(cmd)
    except OSError as exc:
        print(f"error: failed to launch kernel: {exc}", file=sys.stderr)
        return 3
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            return proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            return 130
