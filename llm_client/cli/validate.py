"""
llm_client.cli.validate — `llmnb validate` subcommand (PLAN-S5.0.3 §6.1).

Runs cell_text.parse_cell on every cell. Exits non-zero on K30/K31
failures with the K-code listing. K33/K35 advisory emissions are
printed as warnings but do not affect the exit code (per cell_text
parser semantics — they're advisory, not fatal).

``.llmnb`` files first pass the RFC-005 load-time integrity checks
(``check_rts_integrity``): a rejected file (F5/F9/F10/F11) exits 2 with
the RFC-005 code in the error; tolerated rows (F4/F12) print warnings.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from llm_kernel.text.cell_text import (  # type: ignore[import-not-found]
    CellParseError,
    ParserContext,
    parse_cell,
    parser_context_from_config,
    split_at_breaks,
)

from llm_kernel.notebook.notebook_format import check_rts_integrity

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


def _load_parser_context(path: Path) -> ParserContext | None:
    """Hash-mode context for an ``.llmnb`` file (None for other formats).

    Reads ``metadata.rts.config``; hash mode is honoured only when the
    in-session pin matches the file's fingerprint (see
    ``parser_context_from_config``), so validation classifies plain
    magics exactly as the kernel would.
    """
    if detect_format(path) != "llmnb":
        return None
    nb = json.loads(path.read_text(encoding="utf-8"))
    rts = nb.get("metadata", {}).get("rts", {}) or {}
    return parser_context_from_config(rts.get("config"))


def _check_integrity(path: Path) -> list[str]:
    """RFC-005 integrity warnings for an ``.llmnb`` file ([] otherwise).

    Raises ``LlmnbIntegrityError`` (a ``ValueError``) on rejection.
    """
    if detect_format(path) != "llmnb":
        return []
    nb = json.loads(path.read_text(encoding="utf-8"))
    return check_rts_integrity(nb.get("metadata", {}).get("rts", {}) or {})


def run(args: argparse.Namespace) -> int:
    try:
        integrity_warnings = _check_integrity(args.path)
        cell_texts = _iter_cell_texts(args.path)
        parser_context = _load_parser_context(args.path)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    for warning in integrity_warnings:
        print(f"warning: {warning}", file=sys.stderr)

    failures: list[tuple[str, str, str]] = []  # (cell_id, k_code, reason)
    advisories: list[tuple[str, str, str]] = []

    for cid, text in cell_texts:
        if not text.strip():
            continue
        try:
            parsed = parse_cell(text, parser_context=parser_context)
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
