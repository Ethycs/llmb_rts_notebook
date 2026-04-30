"""
llm_client.cli.validate — `llmnb validate` subcommand (PLAN-S5.0.3 §6.1).

Runs cell_text.parse_cell on every cell. Exits non-zero on K30/K31
failures with the K-code listing. K33/K35 advisory emissions are
printed as warnings but do not affect the exit code (per cell_text
parser semantics — they're advisory, not fatal).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from llm_kernel.cell_text import (  # type: ignore[import-not-found]
    CellParseError,
    parse_cell,
    split_at_breaks,
)

from llm_client.notebook import detect_format


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "path",
        type=Path,
        help="Notebook path (.llmnb / .magic / .ipynb auto-detected).",
    )


def _iter_cell_texts(path: Path) -> list[tuple[str, str]]:
    """Return [(cell_id_or_ordinal, text), ...] for a notebook on disk."""
    fmt = detect_format(path)
    text = path.read_text(encoding="utf-8")
    if fmt == "magic":
        return [(f"cell-{i}", t) for i, t in enumerate(split_at_breaks(text))]
    if fmt == "llmnb":
        nb = json.loads(text)
        rts = nb.get("metadata", {}).get("rts", {}) or {}
        cells = rts.get("cells", {}) or {}
        # Preserve insertion order; layout walk is the metadata writer's
        # canonical order but for validation we want every cell touched.
        return [(cid, rec.get("text", "") or "") for cid, rec in cells.items()]
    if fmt == "ipynb":
        nb = json.loads(text)
        out: list[tuple[str, str]] = []
        for i, c in enumerate(nb.get("cells", []) or []):
            src = c.get("source", "")
            if isinstance(src, list):
                src = "".join(src)
            out.append((f"cell-{i}", src or ""))
        return out
    raise ValueError(f"cannot detect notebook format: {path}")


def run(args: argparse.Namespace) -> int:
    try:
        cell_texts = _iter_cell_texts(args.path)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    failures: list[tuple[str, str, str]] = []  # (cell_id, k_code, reason)
    advisories: list[tuple[str, str, str]] = []

    for cid, text in cell_texts:
        if not text.strip():
            continue
        try:
            parsed = parse_cell(text)
        except CellParseError as e:
            failures.append((cid, e.code, e.reason))
            continue
        for emission in parsed.k_class_emissions:
            advisories.append(
                (cid, emission.get("code", "K??"), emission.get("reason", ""))
            )

    if advisories:
        for cid, code, reason in advisories:
            print(f"warning: {cid}: {code}: {reason}", file=sys.stderr)
    if failures:
        for cid, code, reason in failures:
            print(f"error: {cid}: {code}: {reason}", file=sys.stderr)
        return 1

    print(f"ok: {len(cell_texts)} cells parsed")
    return 0
