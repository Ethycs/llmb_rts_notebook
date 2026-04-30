"""
llm_client.notebook — format converters per PLAN-S5.0.3 §6.3.

Public API:
    detect_format(path) -> Literal["llmnb", "magic", "ipynb", "unknown"]
    llmnb_to_magic(llmnb) -> str
    magic_to_llmnb(magic_text, *, base_metadata=None) -> dict
    ipynb_to_llmnb(ipynb) -> dict

Lint contract: only llm_kernel.wire and llm_kernel.cell_text imports allowed
under llm_client/. The cell_text module is pure (stdlib-only, no I/O) and
its public functions ``split_at_breaks`` / ``parse_cell`` are explicitly
documented as the canonical splitter+parser per BSP-005 S5.0; reusing them
here avoids duplicating ~530 LoC of parsing logic and the silent-drift
hazard that duplication would create. The lint boundary is updated in
tests/test_lint_boundary.py to allow this extra public symbol.

Conversion rules (PLAN-S5.0.3 §6.3):
    llmnb ↔ magic    — round-trip identical for cells without outputs
                       (outputs are dropped; magic text is operator-edit form).
    ipynb → llmnb    — one-way; code cells → @@scratch, markdown → @@markdown,
                       outputs dropped, kernelspec dropped.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

# Lint-allowed: cell_text is the pure parser (BSP-005 S5.0); see header.
from llm_kernel.cell_text import split_at_breaks, parse_cell  # type: ignore[import-not-found]


__all__ = [
    "detect_format",
    "llmnb_to_magic",
    "magic_to_llmnb",
    "ipynb_to_llmnb",
]


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------


def detect_format(
    path: Path,
) -> Literal["llmnb", "magic", "ipynb", "unknown"]:
    """Detect the on-disk notebook format from extension + first-line probe.

    Resolution:
    - ``.llmnb`` extension → ``"llmnb"``.
    - ``.ipynb`` extension → ``"ipynb"``.
    - ``.magic`` or ``.txt`` extension → ``"magic"``.
    - Any other extension or no extension: probe contents:
        - First non-blank line starting with ``@@`` or ``@`` → ``"magic"``.
        - JSON-shaped (first non-blank char is ``{``) with a top-level
          ``"cells"`` key → ``"llmnb"`` if ``metadata.rts`` present,
          else ``"ipynb"``.
        - Otherwise ``"unknown"``.
    """
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".llmnb":
        return "llmnb"
    if ext == ".ipynb":
        return "ipynb"
    if ext in (".magic", ".txt"):
        return "magic"
    # Probe.
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "unknown"
    stripped = text.lstrip()
    if not stripped:
        return "unknown"
    first = stripped.splitlines()[0] if stripped else ""
    if first.startswith("@@") or (
        first.startswith("@") and not first.startswith("@@")
    ):
        # Bare line magic at file head also counts as magic-form.
        return "magic"
    if stripped[0] == "{":
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            return "unknown"
        if isinstance(obj, dict) and "cells" in obj:
            md = obj.get("metadata") or {}
            if isinstance(md, dict) and "rts" in md:
                return "llmnb"
            return "ipynb"
    return "unknown"


# ---------------------------------------------------------------------------
# llmnb ↔ magic
# ---------------------------------------------------------------------------


def _rts_namespace(llmnb: dict) -> dict:
    """Return ``metadata.rts`` from a parsed .llmnb dict (or empty dict)."""
    md = llmnb.get("metadata") or {}
    if not isinstance(md, dict):
        return {}
    rts = md.get("rts") or {}
    return rts if isinstance(rts, dict) else {}


def _layout_walk_ids(layout_tree: Any) -> list[str]:
    """Walk ``layout.tree`` collecting cell ids in document order.

    Returns ids in the order they appear in a depth-first walk of
    ``children`` arrays. Mirrors MetadataWriter.get_cell_layout_order
    semantics (PLAN-S5.0.2 §3) but pure-functional on the snapshot dict.
    """
    if not isinstance(layout_tree, dict):
        return []
    ordered: list[str] = []
    seen: set[str] = set()
    stack: list[Any] = [layout_tree]
    while stack:
        node = stack.pop(0)
        if isinstance(node, dict):
            nid = node.get("id")
            if isinstance(nid, str) and nid not in seen:
                # Only include cell-shaped ids (skip the root "tree" node).
                if node.get("kind") != "tree":
                    ordered.append(nid)
                    seen.add(nid)
            children = node.get("children")
            if isinstance(children, list):
                stack = list(children) + stack
    return ordered


def llmnb_to_magic(llmnb: dict) -> str:
    """Convert a parsed .llmnb dict to operator-edit magic text.

    Rules (PLAN §6.3):
    - Walk ``metadata.rts.cells`` in ``metadata.rts.layout.tree`` order.
    - Cells unreferenced from the layout follow in dict-insertion order.
    - Each cell's ``text`` is emitted verbatim (it already includes the
      ``@@<kind>`` declaration when set; ``magic_to_llmnb`` round-trip
      preserves whatever the operator typed).
    - Cells are separated by a single ``@@break\\n`` line (one cell per
      magic-text segment per PLAN-S5.0 §3.1).
    - Outputs are dropped (magic-text is operator-edit form, not a
      snapshot).

    Parameters
    ----------
    llmnb:
        A parsed .llmnb dict (the JSON object loaded from disk; not the
        bytes). MUST be ipynb-conformant per RFC-005.

    Returns
    -------
    str
        The magic-text representation. Trailing newline is preserved
        only if all cells together produced one; the splitter's contract
        is "drops trailing whitespace-only cells", so a final ``\\n`` is
        included for readability.
    """
    rts = _rts_namespace(llmnb)
    cells_dict = rts.get("cells") or {}
    if not isinstance(cells_dict, dict):
        cells_dict = {}
    layout = rts.get("layout") or {}
    layout_tree = layout.get("tree") if isinstance(layout, dict) else None

    ordered_ids = _layout_walk_ids(layout_tree)
    seen = set(ordered_ids)
    for cid in cells_dict:
        if cid not in seen:
            ordered_ids.append(cid)
            seen.add(cid)

    parts: list[str] = []
    for cid in ordered_ids:
        rec = cells_dict.get(cid)
        if not isinstance(rec, dict):
            continue
        text = rec.get("text", "")
        if not isinstance(text, str):
            continue
        # Drop empty / whitespace-only cells (mirrors split_at_breaks).
        if not text.strip():
            continue
        parts.append(text.rstrip("\n"))

    if not parts:
        return ""
    return "\n@@break\n".join(parts) + "\n"


def magic_to_llmnb(
    magic_text: str,
    *,
    base_metadata: dict | None = None,
) -> dict:
    """Convert magic-text to a parsed .llmnb dict (a JSON object).

    Splits at ``@@break`` per PLAN-S5.0 §3.1, then for each fragment runs
    ``parse_cell`` to derive ``kind`` for the cell record. Builds a fresh
    ``metadata.rts`` namespace with ``cells`` keyed by deterministic ids
    (``cell-0``, ``cell-1``, …) and a flat ``layout.tree`` containing all
    cells in order.

    Parameters
    ----------
    magic_text:
        Operator-edit magic text. May contain any number of ``@@break``
        separators; whitespace-only fragments are dropped.
    base_metadata:
        Optional starting ``metadata.rts`` to merge cells/layout into.
        Useful when round-tripping (preserves config, agent_graph). When
        ``None``, a minimal ``rts`` namespace is constructed.

    Returns
    -------
    dict
        An ipynb-conformant dict ``{cells, metadata, nbformat, nbformat_minor}``.
        ``metadata.rts.cells`` carries the per-cell ``{text, outputs,
        bound_agent_id, kind}`` records; ``metadata.rts.layout.tree``
        carries the layout walk.

    Round-trip property
    -------------------
    ``llmnb_to_magic(magic_to_llmnb(t)) == t`` (modulo a final newline)
    for any ``t`` whose cells are non-empty. Outputs cannot round-trip
    through magic-text (magic-text doesn't carry them).
    """
    fragments = split_at_breaks(magic_text or "")

    cells_dict: dict[str, dict[str, Any]] = {}
    layout_children: list[dict[str, Any]] = []
    for idx, text in enumerate(fragments):
        cell_id = f"cell-{idx}"
        try:
            parsed = parse_cell(text)
            kind = parsed.kind
            bound_agent_id = parsed.args.get("agent_id") if isinstance(parsed.args, dict) else None
        except Exception:  # noqa: BLE001 — defensive; converter must not crash
            kind = "agent"
            bound_agent_id = None
        record: dict[str, Any] = {
            "text": text,
            "outputs": [],
            "kind": kind,
        }
        if bound_agent_id and kind in ("agent", "spawn"):
            record["bound_agent_id"] = bound_agent_id
        cells_dict[cell_id] = record
        layout_children.append({"id": cell_id, "kind": "cell"})

    if base_metadata is not None and isinstance(base_metadata, dict):
        rts: dict[str, Any] = json.loads(json.dumps(base_metadata))  # deep copy
    else:
        rts = {
            "schema_version": "1.0.0",
            "schema_uri": "https://llmnb.dev/schemas/rts/v1",
            "session_id": "00000000-0000-0000-0000-000000000000",
            "created_at": "1970-01-01T00:00:00Z",
            "snapshot_version": 0,
            "agents": {"nodes": [], "edges": []},
            "config": {},
            "event_log": [],
            "blobs": {},
            "drift_log": [],
        }
    rts["cells"] = cells_dict
    rts["layout"] = {"tree": {"id": "root", "kind": "tree", "children": layout_children}}

    return {
        "cells": [
            {
                "cell_type": (
                    "markdown" if cells_dict[cid].get("kind") == "markdown" else "code"
                ),
                "source": cells_dict[cid]["text"],
                "metadata": {"rts": {"cell": {"kind": cells_dict[cid]["kind"]}}},
                "outputs": [],
                "execution_count": None,
            }
            for cid in cells_dict
        ],
        "metadata": {"rts": rts},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


# ---------------------------------------------------------------------------
# ipynb → llmnb (one-way)
# ---------------------------------------------------------------------------


def ipynb_to_llmnb(ipynb: dict) -> dict:
    """One-way Jupyter ipynb → .llmnb conversion (PLAN §6.3, §10 risk #5).

    Mapping:
    - ``cell_type == "code"``  → ``@@scratch`` cell (V1 — no agent binding).
    - ``cell_type == "markdown"`` → ``@@markdown`` cell.
    - ``cell_type == "raw"``  → ``@@scratch`` (treated as code-shaped).
    - Outputs are dropped.
    - ``kernelspec`` is NOT preserved (drivers don't run Python; they
      ship envelopes — V2+ may revisit per PLAN §10 risk #5).

    A WARNING summary of dropped data is the caller's responsibility
    (see llm_client/cli/convert.py); this function is pure.

    Parameters
    ----------
    ipynb:
        A parsed Jupyter notebook dict (``{cells, metadata, ...}``).

    Returns
    -------
    dict
        An ipynb-conformant .llmnb dict with ``metadata.rts`` populated.
    """
    cells_in = ipynb.get("cells") or []
    if not isinstance(cells_in, list):
        cells_in = []

    # Build magic-text by walking the cells in their notebook-document order.
    fragments: list[str] = []
    for c in cells_in:
        if not isinstance(c, dict):
            continue
        ctype = c.get("cell_type")
        source = c.get("source", "")
        if isinstance(source, list):
            source = "".join(source)
        if not isinstance(source, str):
            source = str(source)
        source = source.rstrip("\n")
        if ctype == "markdown":
            fragments.append(f"@@markdown\n{source}" if source else "@@markdown")
        elif ctype in ("code", "raw"):
            fragments.append(f"@@scratch\n{source}" if source else "@@scratch")
        else:
            # Unknown cell type — preserve as scratch with a comment.
            fragments.append(f"@@scratch\n{source}" if source else "@@scratch")

    magic_text = "\n@@break\n".join(fragments)
    return magic_to_llmnb(magic_text)
