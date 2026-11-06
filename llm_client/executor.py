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
    auto-rejected: in live mode every ``request_approval`` / ``escalate``
    ``run.start`` the driver drains is answered at once with an
    ``operator.action`` ``approval_response`` (``decision: "deny"``,
    RFC-001's rejection value), recorded under ``approval_responses`` in
    that cell's ``record_to`` line.

Lint contract: only llm_kernel.wire, llm_kernel.text.cell_text and
llm_kernel.notebook.notebook_format imports.
"""

from __future__ import annotations

import dataclasses
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, NamedTuple, Optional

from llm_kernel.wire import WIRE_VERSION  # noqa: F401  (re-exported in result)
from llm_kernel.notebook.notebook_format import check_rts_integrity
from llm_kernel.text.cell_text import (  # PLAN-S5.5 Phase 4 — @@section
    ParserContext,
    parse_cell,
    parser_context_from_config,
)

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
    inputs are converted via magic_to_llmnb on load. ``.llmnb`` inputs
    pass the RFC-005 integrity checks (raises ``LlmnbIntegrityError``,
    a ``ValueError``, on F5/F9/F10/F11; F4/F12 are normalized in place).
    """
    fmt = detect_format(path)
    text = path.read_text(encoding="utf-8")
    if fmt == "llmnb":
        notebook = json.loads(text)
        check_rts_integrity(notebook.get("metadata", {}).get("rts", {}) or {})
        return notebook
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
        # A noop cell (``@@break``) records ``sent: null``; a recording that
        # cannot be replayed is not much of a recording either.
        sent = entry.get("sent") or {}
        received = entry.get("received") or {}
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


def _derive_cell_envelope(
    cell_id: str,
    record: dict[str, Any],
    *,
    session_id: str,
    ordinal: int,
    parser_context: Optional[ParserContext] = None,
) -> Optional[dict[str, Any]]:
    """Derive a wire envelope for a cell, or ``None`` for no-op cell-kinds.

    PLAN-S5.0.3.1 §3.B — per-cell envelope mapping (LOCKED).

    Returns ``None`` for ``markdown`` / ``scratch`` / ``native`` / unknown
    cell kinds (no envelope shipped; the cell is recorded as a structural
    no-op success). Returns a Family A ``operator.action`` envelope for
    ``agent`` / ``spawn`` cells per ``protocols/operator-action.md``.
    """
    kind = (record.get("kind") or "").lower()
    text = record.get("text", "") or ""
    agent_id = record.get("bound_agent_id")
    request_id = f"{session_id}:{ordinal}"

    if kind == "spawn":
        # ``@@spawn <id>`` cell — body may carry task description.
        # Extract a coarse ``task`` from the body (first non-empty line),
        # mirroring the extension's cell-magic dispatcher behavior.
        task = ""
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("@@"):
                task = stripped
                break
        return {
            "type": "operator.action",
            "request_id": request_id,
            "payload": {
                "action_type": "agent_spawn",
                "parameters": {
                    "agent_id": agent_id,
                    "task": task,
                    "cell_id": cell_id,
                },
                "originating_cell_id": cell_id,
            },
        }

    if kind == "agent" and agent_id:
        # Strip the leading ``@@agent <id>`` directive line, if present.
        body_lines = text.splitlines()
        if body_lines and body_lines[0].strip().startswith("@@agent"):
            body_lines = body_lines[1:]
        body = "\n".join(body_lines).strip() or text.strip()
        return {
            "type": "operator.action",
            "request_id": request_id,
            "payload": {
                "action_type": "agent_continue",
                "intent_kind": "send_user_turn",
                "parameters": {
                    "agent_id": agent_id,
                    "text": body,
                    "cell_id": cell_id,
                },
                "originating_cell_id": cell_id,
            },
        }

    if kind == "section":
        # PLAN-S5.5 Phase 4 — ``@@section <title> [id:"sec_..."]`` cell.
        # Re-parses the cell text to extract the typed args
        # (``args["title"]`` / ``args["section_id"]``) since the
        # persisted record only carries ``text`` / ``kind``. Ships an
        # ``apply_overlay_commit`` envelope with a ``create_section`` op
        # — the same shape the Phase 2 ``llmnb.section.create`` command
        # produces. Section is created EMPTY; population is a separate
        # operator gesture (Command Palette or
        # ``move_cells_into_section`` op).
        try:
            parsed = parse_cell(text, parser_context=parser_context)
            title = parsed.args.get("title") or parsed.args.get("section_name")
            section_id = parsed.args.get("section_id")
        except Exception:  # noqa: BLE001 — defensive; degrade to no-op
            return None
        if not isinstance(title, str) or not title.strip():
            # No title → no section. W4-tolerant; the cell is recorded
            # as a structural no-op so the run completes cleanly.
            return None
        if not isinstance(section_id, str) or not section_id:
            section_id = _mint_section_id_from_title(title)
        return {
            "type": "operator.action",
            "request_id": request_id,
            "payload": {
                "action_type": "zone_mutate",
                "intent_kind": "apply_overlay_commit",
                "parameters": {
                    "operations": [{
                        "kind": "create_section",
                        "section_id": section_id,
                        "title": title,
                    }],
                    "message": f"@@section {title}",
                },
                "intent_id": f"sec-cell-{section_id[:12]}-{ordinal}",
                "originating_cell_id": cell_id,
            },
        }

    # markdown, scratch, native, or unknown -> no envelope (W4 tolerant).
    return None


def _mint_section_id_from_title(title: str) -> str:
    """Mint a kernel-safe section_id from an operator-supplied title.

    Mirrors the extension-side ``mintSectionIdFromTitle`` in
    ``extension/src/notebook/commands/section-ops.ts`` so the same
    title produces compatible (though not identical, since uuid tail
    differs) ids whether the operator types ``@@section`` in a
    ``.magic`` file or invokes the Command Palette. Pure helper;
    deterministic-test seam is its caller-controlled input.
    """
    import re as _re
    import uuid as _uuid
    slug = _re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:24]
    tail = _uuid.uuid4().hex[:6]
    return f"sec_{slug + '_' if slug else ''}{tail}"


#: PLAN-S5 §3.6 — control line magics the driver ships as one
#: ``operator.action`` envelope each, wire shapes per
#: ``protocols/operator-action.md``. ``@handoff`` ships nothing: per the
#: magic atom it edits the NEXT cell's ``bound_agent_id``.
_LINE_MAGIC_ACTIONS: dict[str, str] = {
    "branch": "agent_branch",
    "revert": "agent_revert",
    "stop": "agent_stop",
}


def _keyword_args(
    args_str: str, keywords: tuple[str, ...],
) -> tuple[Optional[str], dict[str, str]]:
    """Split ``<first> [<keyword> <value>]...`` into ``(first, {kw: value})``."""
    tokens = args_str.split()
    first = tokens[0] if tokens else None
    found: dict[str, str] = {}
    i = 1
    while i < len(tokens):
        if tokens[i] in keywords and i + 1 < len(tokens):
            found[tokens[i]] = tokens[i + 1]
            i += 2
        else:
            i += 1
    return first, found


def _derive_line_magic_envelopes(
    cell_id: str,
    text: str,
    *,
    session_id: str,
    ordinal: int,
    parser_context: Optional[ParserContext] = None,
) -> tuple[list[dict[str, Any]], Optional[str], Optional[str]]:
    """Map a cell's ``@branch`` / ``@revert`` / ``@stop`` / ``@handoff`` lines.

    Returns ``(envelopes, handoff_agent_id, body)``: one
    ``operator.action`` per branch/revert/stop magic in cell order, the
    ``@handoff`` target (last one wins; ``None`` if absent), and the
    parsed body with the magic lines removed (``None`` when the cell
    carries none of these magics, so callers keep the cell text as-is).

    Grammar (BSP-002 §3): ``@branch <source> [at <turn>] as <new_id>``,
    ``@revert <agent> to <turn>``, ``@stop <agent>``, ``@handoff <id>``.
    Missing arguments are shipped as ``null`` and rejected kernel-side
    (K42).
    """
    try:
        parsed = parse_cell(text, parser_context=parser_context)
    except Exception:  # noqa: BLE001 — unparseable cell: no magics
        return [], None, None
    envelopes: list[dict[str, Any]] = []
    handoff: Optional[str] = None
    seen = False
    for name, args_str in parsed.line_magics:
        if name == "handoff":
            seen = True
            target, _ = _keyword_args(args_str, ())
            if target:
                handoff = target
            continue
        action_type = _LINE_MAGIC_ACTIONS.get(name)
        if action_type is None:
            continue
        seen = True
        params: dict[str, Any]
        if name == "branch":
            source, kw = _keyword_args(args_str, ("at", "as"))
            params = {"source_agent": source, "new_agent_id": kw.get("as")}
            if "at" in kw:
                params["at_turn_id"] = kw["at"]
        elif name == "revert":
            agent, kw = _keyword_args(args_str, ("to",))
            params = {"agent_id": agent, "target_turn_id": kw.get("to")}
        else:
            agent, _ = _keyword_args(args_str, ())
            params = {"agent_id": agent}
        params["cell_id"] = cell_id
        envelopes.append({
            "type": "operator.action",
            "request_id": f"{session_id}:{ordinal}:{len(envelopes)}",
            "payload": {
                "action_type": action_type,
                "parameters": params,
                "originating_cell_id": cell_id,
            },
        })
    return envelopes, handoff, (parsed.body if seen else None)


def _run_live_mode(
    notebook: dict,
    path: Path,
    *,
    record_to: Optional[Path],
    unattended: bool,
    cell_timeout: float = 60.0,
    quiescence_window: float = 2.0,
    total_timeout: float = 600.0,
    connection: Optional[Any] = None,
) -> tuple[dict, list[dict], list[dict]]:
    """V1 live-mode driver — per-cell ship-then-drain with quiescence.

    PLAN-S5.0.3.1 §3 (LOCKED). Boots a kernel via TCP-on-loopback by
    default (Ambiguity 2 resolution: in-process recv has no event queue;
    TCP loopback is the minimum-LoC path that keeps the lint boundary
    intact). Tests inject a pre-built ``connection`` to bypass the boot.

    Completion criterion (Ambiguity 1 resolution): the kernel does NOT
    currently emit ``runtime_status: idle`` in Family F snapshots
    (verified against ``vendor/LLMKernel/llm_kernel/agent_supervisor.py``
    and ``metadata_writer.py`` — the only ``runtime_status`` references
    are read-only resume gates). Live-mode therefore uses **quiescence-
    only** completion: a cell is done when either a correlated
    ``run.complete`` arrives, OR ``quiescence_window`` of empty recv
    ticks elapses, OR ``cell_timeout`` is exceeded.

    Quiescence means *the cell* went quiet, not *the socket*. The kernel
    also emits traffic on a clock that has nothing to do with the cell in
    flight -- ``heartbeat.kernel`` every 5 s (RFC-006 §7, mandatory) and
    ``notebook.metadata`` ``trigger: "timer"`` autosave snapshots -- and
    none of that may extend the window, or any window >= the heartbeat
    period can never elapse and every cell runs to ``cell_timeout``.
    Every envelope is therefore classified by
    :func:`_classify_live_envelope` *before* the quiescence clock is
    touched: only envelopes attributable to the cell (correlated reply,
    K-class for this cell, Family A ``run.*``, snapshots whose record for
    this cell changed, other cell-addressed envelopes) reset it.
    Clock-driven envelopes are still consumed: snapshots still replace
    ``working_rts`` and everything drained is written to the recording
    (``drained[]`` with timestamps + ``completion_reason`` per cell) so a
    timeout is explainable after the fact.
    """
    # Lazy import to keep the lint surface narrow for unit tests that
    # never reach the boot path.
    if connection is None:
        # TCP-on-loopback path. Spin up `python -m llm_kernel serve`
        # as a subprocess with `--proxy none` and connect via the
        # already-shipped TCP transport. This keeps the driver/kernel
        # lint boundary intact (no llm_kernel internals imported) and
        # mirrors tests/test_tcp_transport.py.
        conn = _boot_tcp_loopback_kernel()
        owns_connection = True
    else:
        conn = connection
        owns_connection = False

    sent_received: list[dict] = []
    succeeded: list[dict] = []
    failed: list[dict] = []
    interrupted = False
    # Keepalive bookkeeping (RFC-006 §7 heartbeat.kernel): learn the cadence
    # from the kernel itself, never from a constant on our side.
    hb_last: Optional[float] = None
    hb_gaps: list[float] = []
    kernel_lost = False
    # PLAN-S5.0.3 §10 risk #7: approval requests already auto-rejected.
    answered_approvals: set[str] = set()

    try:
        # Initial Family F hydrate — same as V1's prior shape.
        rts = notebook.get("metadata", {}).get("rts", {}) or {}
        hydrate_env = {
            "type": "notebook.metadata",
            "payload": {
                "mode": "hydrate",
                "snapshot": rts,
                "trigger": "executor.live",
            },
        }
        try:
            conn.send(hydrate_env)
        except Exception as exc:  # noqa: BLE001 — surface as transport-lost
            return _live_transport_lost(
                notebook, sent_received, str(exc), record_to,
            )

        cells = rts.get("cells", {}) or {}
        layout = rts.get("layout", {}) or {}
        from llm_client.notebook import _layout_walk_ids
        ordered_ids = _layout_walk_ids(layout.get("tree"))
        for cid in cells:
            if cid not in ordered_ids:
                ordered_ids.append(cid)

        working_rts: dict[str, Any] = rts
        session_id = getattr(conn, "session_id", "live") or "live"
        run_deadline = time.monotonic() + total_timeout
        # ``@handoff <id>`` re-binds the next cell (magic atom).
        pending_handoff: Optional[str] = None
        handoff_bindings: dict[str, str] = {}

        for ordinal, cid in enumerate(ordered_ids):
            if time.monotonic() > run_deadline:
                # Total run timeout exceeded — fail-fast remaining cells.
                failed.append(_synthetic_k_envelope(
                    cid, "K_CELL_TIMEOUT",
                    f"total run timeout ({total_timeout}s) exceeded",
                ))
                continue

            record = cells.get(cid)
            if not isinstance(record, dict):
                continue

            parser_context = parser_context_from_config(rts.get("config"))
            kind = (record.get("kind") or "").lower()
            if pending_handoff is not None:
                # The previous cell's ``@handoff`` binds this cell; only
                # agent cells carry a binding.
                if kind == "agent":
                    record = {**record, "bound_agent_id": pending_handoff}
                    handoff_bindings[cid] = pending_handoff
                pending_handoff = None
            magic_envelopes, pending_handoff, magic_body = (
                _derive_line_magic_envelopes(
                    cid, record.get("text", "") or "",
                    session_id=session_id, ordinal=ordinal,
                    parser_context=parser_context,
                )
            )
            if magic_body is not None and kind == "agent":
                # Control magic lines are not prose for the agent; a cell
                # holding only magics sends no agent_continue.
                record = {**record, "text": magic_body}
            if magic_body is not None and kind == "agent" and not magic_body.strip():
                envelope = None
            else:
                envelope = _derive_cell_envelope(
                    cid, record, session_id=session_id, ordinal=ordinal,
                    parser_context=parser_context,
                )
            if envelope is None and not magic_envelopes:
                # No-op cell-kind (markdown / scratch / native / unknown).
                # Counted as succeeded with empty outputs to match stub-
                # mode's degrade-to-noop behavior.
                synth = {
                    "type": "operator.action",
                    "payload": {
                        "kind": "run.complete",
                        "status": "ok",
                        "cell_id": cid,
                        "ordinal": ordinal,
                        "outputs": [],
                    },
                }
                succeeded.append(synth)
                if record_to is not None:
                    sent_received.append(_live_record_entry(
                        cell_id=cid, sent=None, received=synth,
                        completion_reason="noop",
                    ))
                continue

            # Ship the envelope(s): one per control line magic in cell
            # order, then the cell's own (PLAN-S5 §3.6). The last one
            # keys the drain below.
            outgoing = magic_envelopes + ([envelope] if envelope is not None else [])
            envelope = outgoing[-1]
            try:
                for out in outgoing:
                    conn.send(out)
            except Exception as exc:  # noqa: BLE001
                failed.append(_synthetic_k_envelope(
                    cid, "K_TRANSPORT_LOST", str(exc),
                ))
                if record_to is not None:
                    sent_received.append(_live_record_entry(
                        cell_id=cid, sent=envelope, received=failed[-1],
                        completion_reason="transport_lost",
                    ))
                # Fail-fast remaining cells with the same code.
                for remaining in ordered_ids[ordinal + 1:]:
                    failed.append(_synthetic_k_envelope(
                        remaining, "K_TRANSPORT_LOST", "connection closed",
                    ))
                break

            # Per-cell ship-then-drain loop.
            cell_deadline = time.monotonic() + cell_timeout
            cell_started = time.monotonic()
            sent_at = _utc_now_iso()
            quiescence_start: Optional[float] = None
            cell_completed = False
            completion_reason = "cell_timeout"
            received_for_cell: Optional[dict] = None
            drained: list[dict] = []
            approval_responses: list[dict] = []
            window_extensions = 0

            while time.monotonic() < cell_deadline:
                try:
                    reply = conn.recv(timeout=0.1)
                except KeyboardInterrupt:
                    interrupted = True
                    completion_reason = "interrupted"
                    break
                except Exception as exc:  # noqa: BLE001
                    failed.append(_synthetic_k_envelope(
                        cid, "K_TRANSPORT_LOST", str(exc),
                    ))
                    received_for_cell = failed[-1]
                    cell_completed = True
                    completion_reason = "transport_lost"
                    break

                if not reply:
                    silence = _heartbeat_silence(hb_last, hb_gaps)
                    if silence is not None:
                        quiet_for, cadence = silence
                        received_for_cell = _synthetic_k_envelope(
                            cid, "K_KERNEL_LOST",
                            f"kernel heartbeat silent for {quiet_for:.1f}s "
                            f"(observed cadence {cadence:.1f}s, RFC-006 §7); "
                            "kernel presumed gone",
                        )
                        failed.append(received_for_cell)
                        cell_completed = True
                        completion_reason = "heartbeat_lost"
                        kernel_lost = True
                        break
                    if quiescence_start is None:
                        quiescence_start = time.monotonic()
                    elif time.monotonic() - quiescence_start >= quiescence_window:
                        # Quiescence-only completion (Ambiguity 1).
                        cell_completed = True
                        completion_reason = "quiescence"
                        break
                    continue

                # Got an envelope. Classify it BEFORE touching the
                # quiescence clock: heartbeats and timer snapshots are
                # emitted on the kernel's clock, not because of this
                # cell, and must not keep the window open.
                verdict = _classify_live_envelope(
                    reply,
                    cell_id=cid,
                    request_id=envelope["request_id"],
                    working_rts=working_rts,
                )
                payload = reply.get("payload") or {}
                if not isinstance(payload, dict):
                    payload = {}

                if verdict.message_type == "notebook.metadata":
                    snap = payload.get("snapshot")
                    if isinstance(snap, dict):
                        # PLAN §3.C: replace working state, no patch mode.
                        # Applied for every snapshot, timer-driven or not.
                        working_rts = snap

                if verdict.kind == "heartbeat":
                    now = time.monotonic()
                    if hb_last is not None:
                        hb_gaps.append(now - hb_last)
                        del hb_gaps[:-8]
                    hb_last = now

                if unattended:
                    rejection = _approval_rejection(
                        reply, cell_id=cid, answered=answered_approvals,
                    )
                    if rejection is not None:
                        try:
                            conn.send(rejection)
                            approval_responses.append(rejection)
                        except Exception:  # noqa: BLE001 — next recv reports it
                            pass

                if verdict.extends_window:
                    quiescence_start = None
                    window_extensions += 1

                if verdict.kind == "correlated_reply":
                    # Correlated by request_id: clean per-cell completion.
                    received_for_cell = reply
                    if payload.get("k_code"):
                        failed.append(reply)
                    else:
                        succeeded.append(reply)
                    cell_completed = True
                    completion_reason = "correlated_reply"
                    break

                if verdict.kind == "k_code":
                    # K-class envelope keyed on cell_id (no correlation_id).
                    received_for_cell = reply
                    failed.append(reply)
                    cell_completed = True
                    completion_reason = "k_code"
                    break

                # Uncorrelated traffic: keep it in the recording so a
                # timeout can be explained from the record alone.
                drained.append(_drained_record(reply, verdict))

            if interrupted:
                if record_to is not None:
                    sent_received.append(_live_record_entry(
                        cell_id=cid, sent=envelope, received=received_for_cell,
                        completion_reason=completion_reason, sent_at=sent_at,
                        started=cell_started, drained=drained,
                        window_extensions=window_extensions,
                        approval_responses=approval_responses,
                    ))
                break

            if not cell_completed:
                # Cell-timeout exceeded.
                fail_env = _synthetic_k_envelope(
                    cid, "K_CELL_TIMEOUT",
                    f"cell exceeded {cell_timeout}s budget",
                )
                failed.append(fail_env)
                received_for_cell = fail_env
            elif received_for_cell is None:
                # Quiescence path — synthesize a success record so
                # record_to has something to log; uses working_rts
                # outputs for the cell if present.
                cell_outputs: list[Any] = []
                cell_record = working_rts.get("cells", {}).get(cid)
                if isinstance(cell_record, dict):
                    co = cell_record.get("outputs") or []
                    if isinstance(co, list):
                        cell_outputs = co
                received_for_cell = {
                    "type": "operator.action",
                    "payload": {
                        "kind": "run.complete",
                        "status": "ok",
                        "cell_id": cid,
                        "ordinal": ordinal,
                        "outputs": cell_outputs,
                    },
                }
                succeeded.append(received_for_cell)

            if record_to is not None:
                entry = _live_record_entry(
                    cell_id=cid, sent=envelope, received=received_for_cell,
                    completion_reason=completion_reason, sent_at=sent_at,
                    started=cell_started, drained=drained,
                    window_extensions=window_extensions,
                    approval_responses=approval_responses,
                )
                if magic_envelopes:
                    entry["sent_line_magics"] = magic_envelopes
                sent_received.append(entry)

            if kernel_lost:
                # Same fail-fast as a closed transport: do not spend a
                # budget per remaining cell on a kernel that stopped beating.
                for remaining in ordered_ids[ordinal + 1:]:
                    lost_env = _synthetic_k_envelope(
                        remaining, "K_KERNEL_LOST", "kernel heartbeat lost earlier in this run",
                    )
                    failed.append(lost_env)
                    if record_to is not None:
                        sent_received.append(_live_record_entry(
                            cell_id=remaining, sent=None, received=lost_env,
                            completion_reason="heartbeat_lost",
                        ))
                break

        # Trailing drain for `end_of_run` snapshot (pointless once the
        # kernel has stopped beating).
        if not interrupted and not kernel_lost:
            tail_deadline = time.monotonic() + quiescence_window
            while time.monotonic() < tail_deadline:
                try:
                    reply = conn.recv(timeout=0.1)
                except Exception:  # noqa: BLE001
                    break
                if not reply:
                    continue
                if unattended:
                    rejection = _approval_rejection(
                        reply, cell_id=None, answered=answered_approvals,
                    )
                    if rejection is not None:
                        try:
                            conn.send(rejection)
                        except Exception:  # noqa: BLE001
                            break
                        if sent_received:
                            sent_received[-1].setdefault(
                                "approval_responses", [],
                            ).append(rejection)
                msg_type = (
                    reply.get("message_type")
                    or reply.get("type", "")
                )
                if msg_type == "notebook.metadata":
                    snap = (reply.get("payload") or {}).get("snapshot")
                    if isinstance(snap, dict):
                        working_rts = snap

        # Mirror per-cell outputs from working_rts back into the notebook.
        nb_cells = notebook.get("metadata", {}).get("rts", {}).get("cells", {})
        if isinstance(nb_cells, dict):
            for cid, working_record in (working_rts.get("cells") or {}).items():
                if not isinstance(working_record, dict):
                    continue
                nb_record = nb_cells.get(cid)
                if not isinstance(nb_record, dict):
                    continue
                outputs = working_record.get("outputs")
                if isinstance(outputs, list):
                    nb_record["outputs"] = outputs

        # ``@handoff`` re-bindings are driver-side edits; the kernel's
        # snapshots do not carry them, so apply them to the final state.
        final_cells = working_rts.get("cells")
        if isinstance(final_cells, dict):
            for hcid, agent in handoff_bindings.items():
                final_record = final_cells.get(hcid)
                if isinstance(final_record, dict):
                    final_record["bound_agent_id"] = agent

        # Update the notebook's metadata.rts to the final working state
        # (mirrors stub mode's behavior of treating the result as the
        # source of truth for the on-disk file).
        notebook.setdefault("metadata", {})["rts"] = working_rts

    finally:
        if owns_connection:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

    if interrupted:
        raise KeyboardInterrupt()

    return notebook, succeeded, failed


# ---------------------------------------------------------------------------
# Live-mode envelope classification (quiescence is per-cell, not per-socket)
# ---------------------------------------------------------------------------

#: Family E liveness pings (RFC-006 §7): emitted every 5 s by the kernel
#: regardless of what any cell is doing. Never evidence of cell progress.
_LIVE_HEARTBEAT_TYPES: frozenset[str] = frozenset({
    "heartbeat.kernel", "heartbeat.extension",
})
#: Family A run lifecycle: only ever emitted because something ran.
_LIVE_RUN_LIFECYCLE_TYPES: frozenset[str] = frozenset({
    "run.start", "run.event", "run.complete",
})
#: Family F snapshot triggers that fire on a clock (RFC-005 §"Snapshot
#: triggers": the autosave timer) rather than because of a cell.
_LIVE_CLOCK_SNAPSHOT_TRIGGERS: frozenset[str] = frozenset({"timer"})


class _LiveVerdict(NamedTuple):
    """Classification of one envelope drained while a cell is in flight."""

    #: ``correlated_reply`` | ``k_code`` | ``run_lifecycle`` | ``snapshot``
    #: | ``timer_snapshot`` | ``heartbeat`` | ``cell_attributed`` |
    #: ``unrelated``
    kind: str
    #: Whether the envelope counts as activity *for this cell* and may
    #: therefore reset the quiescence clock.
    extends_window: bool
    message_type: str
    detail: dict[str, Any]


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _payload_cell_id(payload: dict[str, Any]) -> Optional[str]:
    """Best-effort cell attribution for uncorrelated envelopes."""
    for key in ("cell_id", "originating_cell_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    params = payload.get("parameters")
    if isinstance(params, dict):
        value = params.get("cell_id")
        if isinstance(value, str) and value:
            return value
    return None


def _classify_live_envelope(
    reply: dict[str, Any],
    *,
    cell_id: str,
    request_id: str,
    working_rts: dict[str, Any],
) -> _LiveVerdict:
    """Decide whether ``reply`` is attributable to ``cell_id``.

    The quiescence window measures how long *the cell* has been quiet,
    so only envelopes that exist because of the cell may extend it:

    * a reply correlated to our ``request_id`` (completes the cell);
    * a K-class envelope addressed to this ``cell_id`` (completes it);
    * Family A ``run.*`` lifecycle (something is executing);
    * a Family F snapshot whose ``cells[cell_id]`` record differs from
      the working state (the cell's outputs/status moved) -- unless the
      snapshot was emitted by the autosave *timer*;
    * any other envelope explicitly addressed to this cell.

    ``heartbeat.kernel`` (RFC-006 §7, every 5 s, mandatory) and
    ``trigger: "timer"`` snapshots are emitted on the kernel's clock and
    never extend the window; a window >= the heartbeat period would
    otherwise be impossible to satisfy.
    """
    msg_type = reply.get("message_type") or reply.get("type", "") or ""
    payload = reply.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}

    reply_corr = (
        reply.get("correlation_id")
        or reply.get("request_id")
        or payload.get("correlation_id")
        or payload.get("request_id")
    )
    if reply_corr == request_id:
        return _LiveVerdict("correlated_reply", True, msg_type, {})

    if payload.get("k_code") and payload.get("cell_id") == cell_id:
        return _LiveVerdict("k_code", True, msg_type, {})

    if msg_type in _LIVE_HEARTBEAT_TYPES:
        return _LiveVerdict(
            "heartbeat", False, msg_type,
            {"kernel_state": payload.get("kernel_state")},
        )

    if msg_type in _LIVE_RUN_LIFECYCLE_TYPES:
        return _LiveVerdict("run_lifecycle", True, msg_type, {})

    if msg_type == "notebook.metadata":
        trigger = payload.get("trigger")
        detail: dict[str, Any] = {
            "mode": payload.get("mode"),
            "trigger": trigger,
            "snapshot_version": payload.get("snapshot_version"),
        }
        if trigger in _LIVE_CLOCK_SNAPSHOT_TRIGGERS:
            return _LiveVerdict("timer_snapshot", False, msg_type, detail)
        snap = payload.get("snapshot")
        if not isinstance(snap, dict):
            # mode=patch or malformed: nothing we can attribute.
            return _LiveVerdict("snapshot", False, msg_type, detail)
        new_cells = snap.get("cells")
        old_cells = working_rts.get("cells") if isinstance(working_rts, dict) else None
        new_rec = new_cells.get(cell_id) if isinstance(new_cells, dict) else None
        old_rec = old_cells.get(cell_id) if isinstance(old_cells, dict) else None
        changed = new_rec != old_rec
        detail["cell_changed"] = changed
        return _LiveVerdict("snapshot", changed, msg_type, detail)

    attributed = _payload_cell_id(payload) == cell_id
    return _LiveVerdict(
        "cell_attributed" if attributed else "unrelated",
        attributed, msg_type, {},
    )


def _drained_record(reply: dict[str, Any], verdict: _LiveVerdict) -> dict[str, Any]:
    """Compact, timestamped summary of an uncorrelated drained envelope."""
    entry: dict[str, Any] = {
        "received_at": _utc_now_iso(),
        "message_type": verdict.message_type,
        "timestamp": reply.get("timestamp"),
        "correlation_id": reply.get("correlation_id") or reply.get("request_id"),
        "classification": verdict.kind,
        "extended_window": verdict.extends_window,
    }
    entry.update(verdict.detail)
    return entry


def _live_record_entry(
    *,
    cell_id: str,
    sent: Optional[dict[str, Any]],
    received: Optional[dict[str, Any]],
    completion_reason: str,
    sent_at: Optional[str] = None,
    started: Optional[float] = None,
    drained: Optional[list[dict[str, Any]]] = None,
    window_extensions: int = 0,
    approval_responses: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """One ``.replay.jsonl`` line for a cell.

    ``sent`` / ``received`` keep the original replay contract (one line
    per cell, replay reads only those two keys). The remaining keys make
    the recording explain *why* a cell ended: ``completion_reason`` is
    one of ``correlated_reply | k_code | quiescence | cell_timeout |
    transport_lost | interrupted | noop``; ``drained`` lists every
    uncorrelated envelope consumed while the cell was in flight, with
    the kernel's ``timestamp``, the driver's ``received_at`` and whether
    it extended the quiescence window. ``approval_responses`` (present
    only when non-empty) lists the unattended auto-rejections sent while
    the cell was in flight.
    """
    entry = {
        "sent": sent,
        "received": received,
        "cell_id": cell_id,
        "completion_reason": completion_reason,
        "sent_at": sent_at,
        "completed_at": _utc_now_iso(),
        "elapsed_s": (
            round(time.monotonic() - started, 3) if started is not None else None
        ),
        "window_extensions": window_extensions,
        "drained": list(drained or []),
    }
    if approval_responses:
        entry["approval_responses"] = list(approval_responses)
    return entry


#: RFC-001 tools that block on an operator decision the unattended driver
#: must refuse (PLAN-S5.0.3 §10 risk #7).
_UNATTENDED_REJECT_TOOLS: frozenset[str] = frozenset({"request_approval", "escalate"})
#: RFC-001 ``request_approval`` output enum: ``approve |
#: approve_with_modification | deny | defer``; ``deny`` is the rejection.
_UNATTENDED_DECISION = "deny"


def _approval_rejection(
    reply: dict[str, Any],
    *,
    cell_id: Optional[str],
    answered: set[str],
) -> Optional[dict[str, Any]]:
    """Auto-reject envelope for a ``request_approval`` / ``escalate`` run.

    Matches the Family A ``run.start`` the kernel's MCP server opens for
    the tool call (span ``name`` is the tool name) and answers it with
    the ``operator.action`` ``approval_response`` the kernel resolves:
    ``parameters.request_id`` is the run's ``spanId`` (the key of the
    pending round-trip; ``run_id`` carries the same value per the
    operator-action atom). Each run is answered once.
    """
    msg_type = reply.get("message_type") or reply.get("type", "")
    span = reply.get("payload")
    if msg_type != "run.start" or not isinstance(span, dict):
        return None
    tool = span.get("name")
    if tool not in _UNATTENDED_REJECT_TOOLS:
        for attr in span.get("attributes") or []:
            if isinstance(attr, dict) and attr.get("key") in (
                "tool.name", "llmnb.tool_name", "llmnb.metadata.tool.name",
            ):
                tool = (attr.get("value") or {}).get("stringValue")
                break
    if tool not in _UNATTENDED_REJECT_TOOLS:
        return None
    run_id = span.get("spanId") or reply.get("correlation_id")
    if not isinstance(run_id, str) or not run_id or run_id in answered:
        return None
    answered.add(run_id)
    payload: dict[str, Any] = {
        "action_type": "approval_response",
        "parameters": {
            "request_id": run_id,
            "run_id": run_id,
            "decision": _UNATTENDED_DECISION,
            "operator_note": f"auto-rejected {tool}: unattended run",
        },
    }
    if cell_id is not None:
        payload["originating_cell_id"] = cell_id
    return {"type": "operator.action", "payload": payload}


#: A keepalive that stops for this many observed intervals means the peer
#: is gone (TCP keepalive / HTTP-2 PING semantics). The floor keeps a
#: scheduling hiccup on a fast fake clock from looking like a dead kernel.
HEARTBEAT_LOSS_FACTOR = 3.0
HEARTBEAT_LOSS_FLOOR_S = 0.5


def _heartbeat_silence(
    hb_last: Optional[float], hb_gaps: list[float],
) -> Optional[tuple[float, float]]:
    """Return ``(quiet_for, cadence)`` once the kernel's heartbeats, whose
    cadence we have observed at least twice, have been silent for longer
    than ``HEARTBEAT_LOSS_FACTOR`` intervals; ``None`` otherwise."""
    if hb_last is None or len(hb_gaps) < 2:
        return None
    cadence = sorted(hb_gaps)[len(hb_gaps) // 2]
    quiet_for = time.monotonic() - hb_last
    if quiet_for > max(HEARTBEAT_LOSS_FACTOR * cadence, HEARTBEAT_LOSS_FLOOR_S):
        return quiet_for, cadence
    return None


def _synthetic_k_envelope(
    cell_id: str, k_code: str, message: str,
) -> dict[str, Any]:
    """Build a synthetic K-class failure envelope for the given cell."""
    return {
        "type": "operator.action",
        "payload": {
            "kind": "run.complete",
            "status": "error",
            "cell_id": cell_id,
            "k_code": k_code,
            "message": message,
            "outputs": [],
        },
    }


def _live_transport_lost(
    notebook: dict,
    sent_received: list[dict],
    message: str,
    record_to: Optional[Path],
) -> tuple[dict, list[dict], list[dict]]:
    """Bail-out path: the initial hydrate ship failed."""
    failed = [_synthetic_k_envelope("<hydrate>", "K_TRANSPORT_LOST", message)]
    if record_to is not None:
        record_to.parent.mkdir(parents=True, exist_ok=True)
        with record_to.open("w", encoding="utf-8") as f:
            for entry in sent_received:
                f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    return notebook, [], failed


def _boot_tcp_loopback_kernel():  # noqa: ANN202 — returns a duck-typed conn
    """Spawn ``python -m llm_kernel serve`` on 127.0.0.1:0 and connect.

    Returns a wrapper around the TCP ``KernelConnection`` that also
    cleans up the kernel subprocess on ``.close()``.

    Reuses the pattern from tests/test_tcp_transport.py — kernel-stderr
    is drained by a daemon thread so the pipe never back-pressures the
    serve loop. Auth token is randomly minted (never logged).
    """
    import os
    import re
    import secrets
    import subprocess
    import sys
    import threading
    import queue as _queue

    from llm_client.transport.tcp import connect as tcp_connect

    token = secrets.token_urlsafe(16)
    env = dict(os.environ)
    env["LLMNB_AUTH_TOKEN"] = token
    env.setdefault("PYTHONPATH", os.pathsep.join(sys.path))

    cmd = [
        sys.executable, "-u", "-m", "llm_kernel", "serve",
        "--transport", "tcp",
        "--bind", "127.0.0.1:0",
        "--auth-token-env", "LLMNB_AUTH_TOKEN",
        "--proxy", os.environ.get("LLMNB_LIVE_PROXY", "litellm"),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    listen_q: _queue.Queue[tuple[str, int]] = _queue.Queue(maxsize=1)
    seen_listen = threading.Event()
    listen_re = re.compile(r"listening on ([\d.]+):(\d+)")

    def _drain_stderr() -> None:
        try:
            while True:
                if proc.stderr is None:
                    return
                line = proc.stderr.readline()
                if not line:
                    return
                if not seen_listen.is_set():
                    match = listen_re.search(
                        line.decode("utf-8", errors="replace"),
                    )
                    if match:
                        listen_q.put((match.group(1), int(match.group(2))))
                        seen_listen.set()
        except Exception:
            return

    threading.Thread(target=_drain_stderr, daemon=True).start()

    try:
        host, port = listen_q.get(timeout=30.0)
    except _queue.Empty:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise RuntimeError(
            "kernel never reported a listening port within 30s"
        ) from None

    conn = tcp_connect(bind=f"{host}:{port}", token=token, timeout=10.0)

    # Wrap close() so we also tear down the subprocess.
    original_close = conn.close

    def _wrapped_close() -> None:
        try:
            original_close()
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

    conn.close = _wrapped_close  # type: ignore[method-assign]
    return conn


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
    cell_timeout: float = 60.0,
    quiescence_window: float = 2.0,
    total_timeout: float = 600.0,
    connection: Optional[Any] = None,
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
        before booting. ``True`` proceeds with auto-rejected escalates:
        live mode answers every ``request_approval`` / ``escalate`` run
        with ``approval_response`` ``decision: "deny"``.

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
            notebook, path,
            record_to=record_to,
            unattended=unattended,
            cell_timeout=cell_timeout,
            quiescence_window=quiescence_window,
            total_timeout=total_timeout,
            connection=connection,
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
