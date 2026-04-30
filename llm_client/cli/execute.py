"""
llm_client.cli.execute — `llmnb execute` subcommand (PLAN-S5.0.3 §6.1).

Wraps llm_client.executor.run_notebook with argparse plumbing. Returns
exit code 0 on success, 1 if any cells failed, 2 on operator-action
errors (escalation guard, replay mismatch, malformed notebook).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

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


def run(args: argparse.Namespace) -> int:
    try:
        result = run_notebook(
            args.path,
            output=args.output,
            mode=args.mode,
            replay_recording=args.replay,
            record_to=args.record,
            unattended=args.unattended,
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
