"""
llm_client.stubs — deterministic canned responses for executor stub mode.

Per PLAN-S5.0.3 §6.2: stub mode replaces real agent endpoints with
deterministic stubs from this module. The registry maps
``(cell_kind, hash_key) → response_envelope`` and is loaded at executor
boot time.

Each stub key is the SHA-256 (truncated to 16 hex chars) of:
    f"{cell_kind}\\x00{cell_text}\\x00{agent_id_or_empty}"

Test-as-notebook fixtures should be authored such that their (kind, text,
agent_id) tuple resolves to a stub registered here. A miss returns the
generic ``no-op`` response so unmatched cells degrade gracefully.

Determinism contract (PLAN §8.1 acceptance):
- 10 consecutive runs of the same fixture produce byte-identical output.
- No timestamps, no random ids, no environment variables in stub responses.
- Stub responses are static dicts; the executor stamps a deterministic
  ``cell_id`` into each response based on cell ordinal.

Lint contract: stdlib-only.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

__all__ = [
    "stub_key",
    "lookup_stub",
    "DEFAULT_NOOP_RESPONSE",
    "register_stub",
    "load_stub_directory",
]


_STUBS_DIR = Path(__file__).parent


# A no-op response: ack-shaped envelope with no per-cell side effect.
DEFAULT_NOOP_RESPONSE: dict[str, Any] = {
    "type": "operator.action",
    "payload": {
        "kind": "run.complete",
        "status": "ok",
        "outputs": [],
    },
}


def stub_key(cell_kind: str, cell_text: str, agent_id: Optional[str] = None) -> str:
    """Compute the deterministic stub key for a cell.

    Truncated SHA-256 (16 hex chars). The kind, text, and agent_id are
    null-byte-separated to avoid the substring-collision class.
    """
    payload = (
        (cell_kind or "")
        + "\x00"
        + (cell_text or "")
        + "\x00"
        + (agent_id or "")
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# In-memory registry. Populated lazily from llm_client/stubs/*.json on
# first lookup. Tests may register custom stubs via register_stub().
_REGISTRY: dict[str, dict[str, Any]] = {}
_LOADED = False


def register_stub(key: str, response: dict[str, Any]) -> None:
    """Register a stub response under a precomputed ``stub_key``.

    Last-writer-wins; useful for test-time overrides. Tests must clean
    up via ``_REGISTRY.pop(key, None)`` if they register a one-off stub
    (to keep parallel xdist workers isolated).
    """
    _REGISTRY[key] = response


def load_stub_directory(directory: Path | None = None) -> int:
    """Load every ``*.json`` from a directory into the registry.

    Each file MUST be a JSON object with the keys::

        {
          "kind": "<cell_kind>",
          "text": "<cell_text>",
          "agent_id": "<id-or-null>",
          "response": <envelope-dict>
        }

    Returns the count of stubs loaded. Idempotent: re-loading the same
    directory replaces existing entries.
    """
    global _LOADED
    d = directory or _STUBS_DIR
    count = 0
    for path in sorted(d.glob("*.json")):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(obj, dict):
            continue
        kind = obj.get("kind")
        text = obj.get("text")
        if not isinstance(kind, str) or not isinstance(text, str):
            continue
        agent = obj.get("agent_id")
        agent_id = agent if isinstance(agent, str) else None
        response = obj.get("response")
        if not isinstance(response, dict):
            continue
        key = stub_key(kind, text, agent_id)
        _REGISTRY[key] = response
        count += 1
    _LOADED = True
    return count


def lookup_stub(
    cell_kind: str,
    cell_text: str,
    agent_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return the stub response for a cell, or ``DEFAULT_NOOP_RESPONSE``.

    Lazily loads the bundled stub directory on first call.
    """
    global _LOADED
    if not _LOADED:
        load_stub_directory()
    key = stub_key(cell_kind, cell_text, agent_id)
    return _REGISTRY.get(key, DEFAULT_NOOP_RESPONSE)
