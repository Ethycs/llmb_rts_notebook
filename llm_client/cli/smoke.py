"""
llm_client.cli.smoke — `llmnb smoke <name>` subcommand (PLAN-S5.0.3e).

Native implementation: calls smoke functions directly via
llm_client._test_helpers.smokes (lint-exempted shim; option (a) per
PLAN-S5.0.3e §3). No subprocess spawning in V1.

The old `python -m llm_kernel <name>-smoke` aliases still work but print
a one-time deprecation notice (added in S5.0.3e).
"""

from __future__ import annotations

import argparse
import sys


SMOKE_TARGETS = {
    "paper-telephone": "run_paper_telephone",
    "supervisor": "run_supervisor",
    "metadata-writer": "run_metadata_writer",
    "pty": "run_pty",
}


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "target",
        choices=sorted(SMOKE_TARGETS.keys()),
        help="Which smoke to run.",
    )


def run(args: argparse.Namespace) -> int:
    fn_name = SMOKE_TARGETS[args.target]
    # Lazy import via the lint-exempted _test_helpers shim.
    from llm_client._test_helpers.smokes import (  # type: ignore[attr-defined]
        run_supervisor,
        run_paper_telephone,
        run_metadata_writer,
        run_pty,
    )
    fn_map = {
        "run_supervisor": run_supervisor,
        "run_paper_telephone": run_paper_telephone,
        "run_metadata_writer": run_metadata_writer,
        "run_pty": run_pty,
    }
    fn = fn_map[fn_name]
    return int(fn())
