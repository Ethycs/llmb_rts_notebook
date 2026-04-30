"""
tests/test_format_converters.py — PLAN-S5.0.3 §6.3 round-trip + mapping.

Covers:
- detect_format on the four canonical extensions + content probe.
- llmnb ↔ magic round-trip is byte-identical for output-free cells.
- ipynb → llmnb mapping (markdown → @@markdown, code → @@scratch).
- ipynb → llmnb drops outputs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from llm_client.notebook import (
    detect_format,
    ipynb_to_llmnb,
    llmnb_to_magic,
    magic_to_llmnb,
)


FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# detect_format
# ---------------------------------------------------------------------------


def test_detect_format_llmnb_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.llmnb"
    p.write_text('{"cells": []}', encoding="utf-8")
    assert detect_format(p) == "llmnb"


def test_detect_format_ipynb_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.ipynb"
    p.write_text('{"cells": []}', encoding="utf-8")
    assert detect_format(p) == "ipynb"


def test_detect_format_magic_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.magic"
    p.write_text("@@scratch\nprint('hi')", encoding="utf-8")
    assert detect_format(p) == "magic"


def test_detect_format_probe_magic(tmp_path: Path) -> None:
    """No-extension file with magic-shaped first line → magic."""
    p = tmp_path / "noext"
    p.write_text("@@scratch\nbody", encoding="utf-8")
    assert detect_format(p) == "magic"


def test_detect_format_probe_llmnb_with_rts(tmp_path: Path) -> None:
    """JSON with metadata.rts → llmnb (regardless of extension)."""
    p = tmp_path / "noext"
    p.write_text(
        json.dumps({"cells": [], "metadata": {"rts": {}}}),
        encoding="utf-8",
    )
    assert detect_format(p) == "llmnb"


def test_detect_format_probe_ipynb_no_rts(tmp_path: Path) -> None:
    """JSON with cells but no metadata.rts → ipynb."""
    p = tmp_path / "noext"
    p.write_text(
        json.dumps({"cells": [], "metadata": {"kernelspec": {}}}),
        encoding="utf-8",
    )
    assert detect_format(p) == "ipynb"


def test_detect_format_unknown(tmp_path: Path) -> None:
    p = tmp_path / "noext"
    p.write_text("just some prose with no structure", encoding="utf-8")
    assert detect_format(p) == "unknown"


# ---------------------------------------------------------------------------
# llmnb ↔ magic round-trip
# ---------------------------------------------------------------------------


def test_magic_round_trip_byte_identical() -> None:
    """A cell-only magic file round-trips byte-for-byte through llmnb."""
    text = (FIXTURES / "spawn-and-notify.magic").read_text(encoding="utf-8")
    nb = magic_to_llmnb(text)
    out = llmnb_to_magic(nb)
    # The trailing newline policy of llmnb_to_magic is "always include
    # one final \\n". The fixture also ends with a single \\n. Both rstripped
    # of trailing \\n must match exactly.
    assert out.rstrip("\n") == text.rstrip("\n")


def test_magic_to_llmnb_assigns_kind() -> None:
    """magic_to_llmnb tags each cell with its parsed kind in metadata.rts.cells."""
    text = (FIXTURES / "spawn-and-notify.magic").read_text(encoding="utf-8")
    nb = magic_to_llmnb(text)
    cells = nb["metadata"]["rts"]["cells"]
    kinds = [r["kind"] for r in cells.values()]
    assert kinds == ["spawn", "scratch"]


def test_magic_to_llmnb_layout_walk_order() -> None:
    """Layout walks cells in document order."""
    text = "@@scratch\nA\n@@break\n@@scratch\nB\n@@break\n@@scratch\nC"
    nb = magic_to_llmnb(text)
    layout = nb["metadata"]["rts"]["layout"]
    assert layout["tree"]["children"] == [
        {"id": "cell-0", "kind": "cell"},
        {"id": "cell-1", "kind": "cell"},
        {"id": "cell-2", "kind": "cell"},
    ]


def test_llmnb_to_magic_drops_empty_cells() -> None:
    """Whitespace-only cells are dropped (mirrors split_at_breaks)."""
    nb = {
        "metadata": {
            "rts": {
                "cells": {
                    "a": {"text": "@@scratch\nbody1", "kind": "scratch"},
                    "b": {"text": "   \n  \n", "kind": "scratch"},
                    "c": {"text": "@@scratch\nbody3", "kind": "scratch"},
                },
                "layout": {
                    "tree": {
                        "id": "root",
                        "kind": "tree",
                        "children": [
                            {"id": "a"}, {"id": "b"}, {"id": "c"},
                        ],
                    }
                },
            }
        }
    }
    out = llmnb_to_magic(nb)
    assert out.count("@@break") == 1
    assert "body1" in out and "body3" in out


def test_llmnb_to_magic_unreferenced_cells_appended() -> None:
    """Cells not in the layout fall through in dict-insertion order."""
    nb = {
        "metadata": {
            "rts": {
                "cells": {
                    "a": {"text": "@@scratch\nA", "kind": "scratch"},
                    "b": {"text": "@@scratch\nB", "kind": "scratch"},
                },
                "layout": {
                    "tree": {
                        "id": "root",
                        "kind": "tree",
                        "children": [{"id": "a"}],
                    }
                },
            }
        }
    }
    out = llmnb_to_magic(nb)
    assert out.index("A") < out.index("B")


# ---------------------------------------------------------------------------
# ipynb → llmnb (one-way)
# ---------------------------------------------------------------------------


def test_ipynb_to_llmnb_markdown_to_markdown() -> None:
    ipynb = json.loads((FIXTURES / "simple.ipynb").read_text(encoding="utf-8"))
    nb = ipynb_to_llmnb(ipynb)
    cells = list(nb["metadata"]["rts"]["cells"].values())
    assert cells[0]["kind"] == "markdown"
    assert "Sample notebook" in cells[0]["text"]


def test_ipynb_to_llmnb_code_to_scratch() -> None:
    ipynb = json.loads((FIXTURES / "simple.ipynb").read_text(encoding="utf-8"))
    nb = ipynb_to_llmnb(ipynb)
    cells = list(nb["metadata"]["rts"]["cells"].values())
    assert cells[1]["kind"] == "scratch"
    assert "1 + 2" in cells[1]["text"]


def test_ipynb_to_llmnb_drops_outputs() -> None:
    """ipynb output payloads must not survive the conversion."""
    ipynb = json.loads((FIXTURES / "simple.ipynb").read_text(encoding="utf-8"))
    nb = ipynb_to_llmnb(ipynb)
    for cell in nb["metadata"]["rts"]["cells"].values():
        assert cell["outputs"] == []


def test_ipynb_to_llmnb_drops_kernelspec() -> None:
    """kernelspec is intentionally not preserved (PLAN §10 risk #5)."""
    ipynb = json.loads((FIXTURES / "simple.ipynb").read_text(encoding="utf-8"))
    nb = ipynb_to_llmnb(ipynb)
    rts = nb["metadata"]["rts"]
    assert "kernelspec" not in rts


def test_ipynb_to_llmnb_handles_list_source() -> None:
    """ipynb stores source as either str or list[str]; both must work."""
    ipynb = {
        "cells": [
            {"cell_type": "code", "source": ["x = 1\n", "y = 2"], "metadata": {}},
        ],
        "metadata": {},
    }
    nb = ipynb_to_llmnb(ipynb)
    cells = list(nb["metadata"]["rts"]["cells"].values())
    assert "x = 1" in cells[0]["text"]
    assert "y = 2" in cells[0]["text"]
