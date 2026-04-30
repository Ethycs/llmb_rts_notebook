"""
llm_client.cli.smoke — `llmnb smoke <name>` subcommand (PLAN-S5.0.3 §6.1).

V1: thin alias for ``python -m llm_kernel <name>-smoke``. Listed here
for the deprecation path; the actual smoke implementations stay in the
kernel for now (the migration to `llm_client/cli/smoke.py` happens in
S5.0.3e). Per PLAN §3.2 we keep the old `python -m llm_kernel` aliases
working for one release.
"""

from __future__ import annotations

import argparse
import subprocess
import sys


SMOKE_TARGETS = {
    "paper-telephone": "paper-telephone-smoke",
    "supervisor": "agent-supervisor-smoke",
    "metadata-writer": "metadata-writer-smoke",
}


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "target",
        choices=sorted(SMOKE_TARGETS.keys()),
        help="Which smoke to run.",
    )


def run(args: argparse.Namespace) -> int:
    target = SMOKE_TARGETS[args.target]
    print(
        f"note: `llmnb smoke` is a thin alias for "
        f"`python -m llm_kernel {target}` in V1 (S5.0.3e migrates).",
        file=sys.stderr,
    )
    proc = subprocess.run(
        [sys.executable, "-m", "llm_kernel", target],
        check=False,
    )
    return proc.returncode
