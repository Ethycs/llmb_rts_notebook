"""
llm_client.cli.gc — `llmnb gc` subcommand (RFC-005 §"Blob garbage collection").

The driver-side home of RFC-005's manual ``kernel-gc``: marks every
``$blob:`` sentinel the notebook still references, removes the
unreferenced entries from ``metadata.rts.blobs`` and rewrites the file
in place. The file is left untouched when nothing is removed.

Exit codes: 0 success; 2 the path is not a readable ``.llmnb`` file.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from llm_kernel.notebook.notebook_format import detect_format, gc_blobs


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("path", type=Path, help="Path to a .llmnb notebook.")


def run(args: argparse.Namespace) -> int:
    try:
        if detect_format(args.path) != "llmnb":
            raise ValueError(f"not an .llmnb notebook: {args.path}")
        notebook = json.loads(args.path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    removed = gc_blobs(notebook)
    if removed:
        args.path.write_text(
            json.dumps(notebook, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    for key in removed:
        print(f"removed: {key}")
    print(f"ok: {len(removed)} unreferenced blob(s) removed")
    return 0
