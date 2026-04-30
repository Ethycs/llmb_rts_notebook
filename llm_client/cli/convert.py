"""
llm_client.cli.convert — `llmnb convert` subcommand (PLAN-S5.0.3 §6.1).

Auto-detects input format and dispatches to the appropriate converter.
For lossy conversions (ipynb → llmnb / .magic), prints a WARNING summary
of dropped data per PLAN §10 risk #5.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from llm_client.notebook import (
    detect_format,
    ipynb_to_llmnb,
    llmnb_to_magic,
    magic_to_llmnb,
)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("input", type=Path, help="Input notebook path.")
    parser.add_argument("output", type=Path, help="Output notebook path.")


def run(args: argparse.Namespace) -> int:
    src_fmt = detect_format(args.input)
    dst_ext = args.output.suffix.lower()
    dst_fmt = (
        "llmnb" if dst_ext == ".llmnb"
        else "magic" if dst_ext == ".magic"
        else "ipynb" if dst_ext == ".ipynb"
        else "unknown"
    )
    if src_fmt == "unknown":
        print(
            f"error: cannot detect format of input {args.input}",
            file=sys.stderr,
        )
        return 2
    if dst_fmt == "unknown":
        print(
            f"error: unknown target format for {args.output} "
            f"(expected .llmnb, .magic, or .ipynb)",
            file=sys.stderr,
        )
        return 2

    text = args.input.read_text(encoding="utf-8")
    # Source → in-memory llmnb dict.
    if src_fmt == "llmnb":
        nb = json.loads(text)
    elif src_fmt == "magic":
        nb = magic_to_llmnb(text)
    elif src_fmt == "ipynb":
        nb = ipynb_to_llmnb(json.loads(text))
        # PLAN §10 risk #5: warn about lossy conversion.
        print(
            "warning: ipynb → llmnb conversion is one-way. Outputs and "
            "kernelspec are dropped; code cells become @@scratch (no "
            "agent binding).",
            file=sys.stderr,
        )
    else:
        print(f"error: unsupported source format {src_fmt}", file=sys.stderr)
        return 2

    # llmnb dict → target.
    if dst_fmt == "llmnb":
        args.output.write_text(
            json.dumps(nb, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    elif dst_fmt == "magic":
        args.output.write_text(llmnb_to_magic(nb), encoding="utf-8")
    elif dst_fmt == "ipynb":
        # We don't ship a llmnb→ipynb converter (PLAN §6.3 lists ipynb
        # only as a one-way input). Print a clear error instead of
        # producing a half-baked file.
        print(
            "error: llmnb → ipynb conversion is not supported (PLAN-S5.0.3 §6.3 "
            "lists ipynb only as a one-way input; use .magic or keep .llmnb).",
            file=sys.stderr,
        )
        return 2

    print(f"converted {src_fmt} -> {dst_fmt}: {args.output}")
    return 0
