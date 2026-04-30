"""
llm_client.executor — headless notebook executor (PLAN-S5.0.3 §6.2 / §9).

Public API:
    run_notebook(path, *, output, mode, replay_recording, record_to,
                 unattended) -> ExecutionResult

Three execution modes per PLAN §6.2:
    stub    — deterministic canned responses from llm_client.stubs;
              no API keys required; primary tests-as-notebooks mode.
    live    — real kernel boot + LiteLLM/Anthropic-passthrough proxy.
              V1 NOTE: live-mode end-to-end requires the async recv
              path scheduled in S5.0.3d. The V1 implementation here
              boots a real kernel and ships the hydrate envelope but
              defers full agent-spawn drive to S5.0.3d.
    replay  — read a `.replay.jsonl` recording captured from a prior
              live run and reconstruct the ExecutionResult deterministically.

`unattended` flag (PLAN §10 risk #7):
    Default False. If False AND the notebook contains any
    escalate-bearing cells (any cell whose magic resolves to a
    request_approval surface), run_notebook raises
    EscalationRequiresOperatorError before booting. Operators must
    pass unattended=True to acknowledge that all approvals will be
    auto-rejected.

Lint contract: only llm_kernel.wire and llm_kernel.cell_text imports.
"""

from __future__ import annotations

import dataclasses
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

from llm_kernel.wire import WIRE_VERSION  # noqa: F401  (re-exported in result)

from llm_client.notebook import (
    detect_format,
    llmnb_to_magic,
    magic_to_llmnb,
)
from llm_client.stubs import lookup_stub, stub_key


__all__ = [
    "ExecutionResult",
    "EscalationRequiresOperatorError",
    "ReplayMismatchError",
    "run_notebook",
]


# ---------------------------------------------------------------------------
# Data classes + errors
# ---------------------------------------------------------------------------


class EscalationRequiresOperatorError(RuntimeError):
    """Raised when a notebook contains escalate-bearing cells but
    ``unattended=False`` (PLAN §10 risk #7).

    Operator either runs interactively (unsupported in V1 — there is
    no operator-attached executor yet) or passes ``unattended=True``
    to acknowledge that all ``request_approval`` calls auto-reject.
    """


class ReplayMismatchError(RuntimeError):
    """Raised when a replay recording does not match the notebook
    being executed (cell count differs, or a key event in the
    recording references a cell that no longer exists)."""


@dataclass
class ExecutionResult:
    """The result of ``run_notebook(...)``.

    Fields per PLAN §9 interface contract.
    """

    notebook_path: Path
    cells_executed: int
    cells_succeeded: int
    cells_failed: int
    final_state: dict
    errors: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


_ESCALATE_MARKERS = (
    "@@escalate",      # speculative future kind
    "request_approval", # body-level call (heuristic)
)


def _has_escalate(rts_cells: dict[str, dict[str, Any]]) -> bool:
    """Detect escalate-bearing cells (PLAN §10 risk #7).

    Heuristic: any cell whose ``text`` contains an escalate marker.
    The marker set is intentionally conservative — operators can rename
    by adding to ``_ESCALATE_MARKERS``. False-positives (the word
    appearing in prose) are acceptable; ``unattended`` is opt-in so a
    spurious raise is recoverable with one flag.
    """
    for record in rts_cells.values():
        if not isinstance(record, dict):
            continue
        text = record.get("text", "")
        if not isinstance(text, str):
            continue
        lower = text.lower()
        for marker in _ESCALATE_MARKERS:
            if marker in lower:
                return True
    return False


def _load_notebook(path: Path) -> dict:
    """Parse a notebook from disk into a dict (.llmnb shape).

    Format-detection per llm_client.notebook.detect_format. Magic-text
    inputs are converted via magic_to_llmnb on load.
    """
    fmt = detect_format(path)
    text = path.read_text(encoding="utf-8")
    if fmt == "llmnb":
        return json.loads(text)
    if fmt == "ipynb":
        # Convert ipynb to llmnb on load. Imports are warned at the
        # CLI layer; this function is pure (no print).
        from llm_client.notebook import ipynb_to_llmnb
        return ipynb_to_llmnb(json.loads(text))
    if fmt == "magic":
        return magic_to_llmnb(text)
    raise ValueError(f"Unable to detect notebook format for {path}")


def _write_notebook(notebook: dict, target: Path) -> None:
    """Write a notebook dict back to disk in the appropriate format."""
    suffix = target.suffix.lower()
    if suffix == ".magic":
        target.write_text(llmnb_to_magic(notebook), encoding="utf-8")
        return
    # Default: JSON-serialized .llmnb (matches extension/serializer.ts).
    target.write_text(
        json.dumps(notebook, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _stamp_cell_response(
    response: dict[str, Any],
    cell_id: str,
    ordinal: int,
) -> dict[str, Any]:
    """Stamp a deterministic ``cell_id`` and ``ordinal`` into a stub response.

    Returns a deep-ish copy so the registry entry is not mutated.
    """
    out = json.loads(json.dumps(response))
    payload = out.setdefault("payload", {})
    payload["cell_id"] = cell_id
    payload["ordinal"] = ordinal
    return out


# ---------------------------------------------------------------------------
# Stub-mode driver
# ---------------------------------------------------------------------------


def _run_stub_mode(
    notebook: dict,
    *,
    record_to: Optional[Path],
) -> tuple[dict, list[dict], list[dict]]:
    """Execute every cell using the canned-response stub registry.

    Returns ``(updated_notebook, succeeded_envelopes, failed_envelopes)``
    so the caller can populate ExecutionResult.

    Determinism: the stub registry is keyed by ``stub_key(kind, text,
    agent_id)``; identical inputs yield identical envelopes. Cell ids
    are read from the input notebook (operator-authored) and stamped
    into responses; if absent, deterministic ``cell-<n>`` ids are used.
    """
    rts = notebook.get("metadata", {}).get("rts", {})
    cells = rts.get("cells", {}) or {}
    layout = rts.get("layout", {}) or {}

    succeeded: list[dict] = []
    failed: list[dict] = []
    sent_received: list[dict] = []  # for record_to

    # Walk the layout in order so determinism doesn't depend on dict
    # iteration semantics across CPython versions (it's stable in 3.7+
    # but we should not rely on that for byte-identity contracts).
    from llm_client.notebook import _layout_walk_ids
    ordered_ids = _layout_walk_ids(layout.get("tree"))
    for cid in cells:
        if cid not in ordered_ids:
            ordered_ids.append(cid)

    for ordinal, cid in enumerate(ordered_ids):
        record = cells.get(cid)
        if not isinstance(record, dict):
            continue
        text = record.get("text", "") or ""
        kind = record.get("kind") or "agent"
        agent = record.get("bound_agent_id")
        sent = {
            "type": "operator.action",
            "payload": {
                "kind": "run.start",
                "cell_id": cid,
                "ordinal": ordinal,
                "cell_kind": kind,
                "agent_id": agent,
                "stub_key": stub_key(kind, text, agent),
            },
        }
        # Stub lookup. The registry returns DEFAULT_NOOP_RESPONSE when
        # there's no canned hit — which is success-shaped so unmatched
        # cells degrade to a deterministic ack. Tests targeting failure
        # behavior should register an explicit error-shaped stub.
        canned = lookup_stub(kind, text, agent)
        received = _stamp_cell_response(canned, cid, ordinal)

        if record_to is not None:
            sent_received.append({"sent": sent, "received": received})

        # Determine success vs failure from the response payload.
        payload = received.get("payload") or {}
        status = payload.get("status", "ok")
        if status == "ok":
            succeeded.append(received)
            # Persist outputs back into the cell record (drops outputs
            # that can't round-trip through magic-text but preserves
            # them in the JSON snapshot).
            outputs = payload.get("outputs") or []
            if isinstance(outputs, list):
                record["outputs"] = outputs
        else:
            failed.append(received)

    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return notebook, succeeded, failed


# ---------------------------------------------------------------------------
# Replay-mode driver
# ---------------------------------------------------------------------------


def _run_replay_mode(
    notebook: dict,
    *,
    replay_recording: Path,
) -> tuple[dict, list[dict], list[dict]]:
    """Reconstruct ExecutionResult from a `.replay.jsonl` recording.

    Determinism contract (this slice's choice — see report):
    - The recording is the source of truth for cell outputs and status.
    - The recording is matched to the notebook by (cell_id, ordinal)
      pair from the recorded ``sent.payload``. A drift in cell_id or
      ordinal raises ReplayMismatchError.
    - Timestamps + run_ids in the recording are preserved verbatim
      (we record verbatim, replay verbatim) — ipoperator-side wall-clock
      tests must use the recorded timestamps, not the replay-time clock.
    """
    if not replay_recording.exists():
        raise FileNotFoundError(f"replay recording not found: {replay_recording}")

    entries: list[dict[str, Any]] = []
    with replay_recording.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entries.append(json.loads(line))

    rts = notebook.get("metadata", {}).get("rts", {})
    cells = rts.get("cells", {}) or {}
    layout = rts.get("layout", {}) or {}
    from llm_client.notebook import _layout_walk_ids
    ordered_ids = _layout_walk_ids(layout.get("tree"))
    for cid in cells:
        if cid not in ordered_ids:
            ordered_ids.append(cid)

    if len(entries) != len(ordered_ids):
        raise ReplayMismatchError(
            f"replay recording has {len(entries)} entries but notebook has "
            f"{len(ordered_ids)} cells — recording does not match"
        )

    succeeded: list[dict] = []
    failed: list[dict] = []
    for ordinal, (cid, entry) in enumerate(zip(ordered_ids, entries)):
        sent = entry.get("sent", {})
        received = entry.get("received", {})
        sent_payload = sent.get("payload") or {}
        rec_cid = sent_payload.get("cell_id")
        if rec_cid is not None and rec_cid != cid:
            raise ReplayMismatchError(
                f"replay entry {ordinal}: recorded cell_id={rec_cid!r} "
                f"does not match notebook cell_id={cid!r}"
            )
        payload = received.get("payload") or {}
        status = payload.get("status", "ok")
        if status == "ok":
            succeeded.append(received)
            outputs = payload.get("outputs") or []
            if isinstance(outputs, list):
                record = cells.get(cid)
                if isinstance(record, dict):
                    record["outputs"] = outputs
        else:
            failed.append(received)

    return notebook, succeeded, failed


# ---------------------------------------------------------------------------
# Live-mode driver (V1 minimal)
# ---------------------------------------------------------------------------


def _run_live_mode(
    notebook: dict,
    path: Path,
    *,
    record_to: Optional[Path],
    unattended: bool,
) -> tuple[dict, list[dict], list[dict]]:
    """V1 live-mode driver — boots a real kernel + ships hydrate envelope.

    Full operator-action drive (spawn, message, snapshot collection)
    awaits the async recv path in S5.0.3d. V1 raises NotImplementedError
    so a misconfigured CI doesn't silently no-op.
    """
    # Booting the kernel still validates that the operator's environment
    # is set up correctly (LiteLLM proxy starts, ANTHROPIC_API_KEY
    # present), so we still attempt the boot before raising.
    from llm_client import boot_minimal_kernel
    conn = boot_minimal_kernel(proxy="litellm")
    try:
        # Ship the hydrate envelope (Family F mode=hydrate). The
        # dispatcher applies it to the writer; in V1 in-process mode
        # there's no async response queue so we can't observe further
        # snapshots from this driver-end.
        rts = notebook.get("metadata", {}).get("rts", {})
        hydrate_env = {
            "type": "notebook.metadata",
            "payload": {
                "mode": "hydrate",
                "snapshot": rts,
                "trigger": "executor.live",
            },
        }
        conn.send(hydrate_env)
    finally:
        conn.close()

    raise NotImplementedError(
        "Live-mode end-to-end ships in S5.0.3d (TCP transport with "
        "async recv path). Use mode='stub' or mode='replay' for V1."
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_notebook(
    path: Path,
    *,
    output: Optional[Path] = None,
    mode: Literal["stub", "live", "replay"] = "live",
    replay_recording: Optional[Path] = None,
    record_to: Optional[Path] = None,
    unattended: bool = False,
) -> ExecutionResult:
    """Boot a kernel, drive every cell, write outputs back. PLAN-S5.0.3 §9.

    Parameters
    ----------
    path:
        Path to the notebook (auto-detected: .llmnb / .magic / .ipynb).
    output:
        Path to write the result. ``None`` overwrites the input.
    mode:
        ``"stub"`` (deterministic), ``"live"`` (real LiteLLM proxy),
        ``"replay"`` (from a recording).
    replay_recording:
        Path to a ``.replay.jsonl`` file. Required when ``mode="replay"``.
    record_to:
        When set in stub or live modes, write a ``.replay.jsonl``
        recording to this path. Useful for capturing a deterministic
        regression fixture from a one-off live run.
    unattended:
        Default ``False``. When ``False`` and the notebook contains
        escalate-bearing cells, raises EscalationRequiresOperatorError
        before booting. ``True`` proceeds with auto-rejected escalates.

    Returns
    -------
    ExecutionResult
        Counts + final state + per-cell errors.

    Raises
    ------
    EscalationRequiresOperatorError
        Notebook has an escalate cell and ``unattended=False``.
    FileNotFoundError
        ``mode="replay"`` and the recording is missing.
    NotImplementedError
        ``mode="live"`` (V1 — full drive ships in S5.0.3d).
    """
    path = Path(path)
    notebook = _load_notebook(path)

    rts = notebook.get("metadata", {}).get("rts", {}) or {}
    cells = rts.get("cells") or {}
    if not isinstance(cells, dict):
        cells = {}

    # Escalate-cell guard (PLAN §10 risk #7).
    if not unattended and _has_escalate(cells):
        raise EscalationRequiresOperatorError(
            "Notebook contains escalate-bearing cells. Pass "
            "unattended=True to auto-reject all approvals (or run "
            "interactively, currently unsupported in V1)."
        )

    if mode == "stub":
        notebook, succeeded, failed = _run_stub_mode(
            notebook, record_to=record_to,
        )
    elif mode == "replay":
        if replay_recording is None:
            raise ValueError("mode='replay' requires replay_recording=...")
        notebook, succeeded, failed = _run_replay_mode(
            notebook, replay_recording=replay_recording,
        )
    elif mode == "live":
        notebook, succeeded, failed = _run_live_mode(
            notebook, path, record_to=record_to, unattended=unattended,
        )
    else:
        raise ValueError(f"unknown mode: {mode!r}")

    # Write back.
    target = output if output is not None else path
    _write_notebook(notebook, Path(target))

    final_rts = notebook.get("metadata", {}).get("rts", {}) or {}
    cells_count = len(cells)

    errors_list: list[dict] = []
    for env in failed:
        payload = env.get("payload") or {}
        errors_list.append({
            "cell_id": payload.get("cell_id"),
            "k_code": payload.get("k_code"),
            "message": payload.get("message") or payload.get("error"),
        })

    return ExecutionResult(
        notebook_path=Path(target),
        cells_executed=cells_count,
        cells_succeeded=len(succeeded),
        cells_failed=len(failed),
        final_state=final_rts,
        errors=errors_list,
    )
