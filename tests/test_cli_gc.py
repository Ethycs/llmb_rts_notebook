"""
tests/test_cli_gc.py — `llmnb gc` (RFC-005 §"Blob garbage collection") and
the RFC-005 integrity checks `llmnb validate` applies to .llmnb files.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from llm_client.cli.__main__ import main


def _key(body: str) -> str:
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def _write(tmp_path: Path, blobs: dict, runs: list, edges: list | None = None) -> Path:
    rts = {
        "schema_version": "1.0.0",
        "agents": {"version": 1, "nodes": [{"id": "agent:a", "type": "agent"}], "edges": edges or []},
        "event_log": {"version": 1, "runs": runs},
        "blobs": blobs,
        "cells": {},
    }
    path = tmp_path / "nb.llmnb"
    path.write_text(json.dumps({"metadata": {"rts": rts}, "cells": []}), encoding="utf-8")
    return path


def _run(value: str) -> dict:
    return {"spanId": "8a3c1a2e9d774f0a", "startTimeUnixNano": "1", "endTimeUnixNano": "2",
            "attributes": [{"key": "output.value", "value": {"stringValue": value}}]}


def test_gc_removes_unreferenced_blob(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    kept, dropped = _key("kept"), _key("dropped")
    path = _write(tmp_path, {kept: {"body": "kept"}, dropped: {"body": "dropped"}},
                  [_run(f"$blob:{kept}")])
    assert main(["gc", str(path)]) == 0
    assert f"removed: {dropped}" in capsys.readouterr().out
    blobs = json.loads(path.read_text(encoding="utf-8"))["metadata"]["rts"]["blobs"]
    assert list(blobs) == [kept]


def test_gc_rejects_non_llmnb_input(tmp_path: Path) -> None:
    path = tmp_path / "nb.magic"
    path.write_text("@@scratch\nx\n", encoding="utf-8")
    assert main(["gc", str(path)]) == 2


def test_validate_rejects_dangling_edge(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = _write(tmp_path, {}, [], edges=[{"source": "agent:a", "target": "zone-x", "kind": "in_zone"}])
    assert main(["validate", str(path)]) == 2
    assert "RFC-005 F10" in capsys.readouterr().err


def test_validate_warns_on_missing_blob(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    missing = _key("gone")
    path = _write(tmp_path, {}, [_run(f"$blob:{missing}")])
    assert main(["validate", str(path)]) == 0
    assert f"(blob missing: {missing})" in capsys.readouterr().err
