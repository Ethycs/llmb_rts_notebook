from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "-f",
        "--connection-file",
        dest="connection_file",
        type=str,
        default=None,
        help="Jupyter connection file path passed by a Jupyter frontend.",
    )
    parser.add_argument(
        "--notebook",
        type=Path,
        default=None,
        help="Optional .llmnb/.magic/.ipynb file to hydrate on start and persist on shutdown.",
    )
    parser.add_argument(
        "--workdir",
        type=Path,
        default=None,
        help="Workspace root directory for the kernel session.",
    )


def run(args: argparse.Namespace) -> int:
    cmd = [sys.executable, "-m", "llm_kernel", "jupyter"]
    if args.connection_file is not None:
        cmd.extend(["-f", args.connection_file])
    if args.notebook is not None:
        cmd.extend(["--notebook", str(args.notebook)])
    if args.workdir is not None:
        cmd.extend(["--workdir", str(args.workdir)])
    try:
        proc = subprocess.Popen(cmd)
    except OSError as exc:
        print(f"error: failed to launch Jupyter kernel: {exc}", file=sys.stderr)
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
