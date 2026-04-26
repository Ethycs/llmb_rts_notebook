"""Stub MCP kernel for the R2-prototype harness.

A stdio MCP server that registers the two RFC-001 tools the harness exercises
(``notify`` and ``report_completion``) as real handlers, plus the remaining
eleven RFC-001 tool names as stubs that return a structured "not implemented"
error. Every accepted tool call is appended as a JSON line to the path named
by the ``R2_KERNEL_LOG_FILE`` environment variable so the orchestrator can
inspect what Claude Code actually called.

Run by Claude Code itself via the MCP config rendered by
``provision_claude_code.py``; not invoked directly by the operator.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

_RFC_VERSION = "1.0.0"
_KERNEL_LOG_ENV = "R2_KERNEL_LOG_FILE"

# Eleven RFC-001 tools we register as stubs (the harness exercises only the
# two below). Listed verbatim from RFC-001 v1.0.0.
_STUB_TOOL_NAMES: tuple[str, ...] = (
    "ask",
    "clarify",
    "propose",
    "request_approval",
    "report_progress",
    "report_problem",
    "present",
    "escalate",
    "read_file",
    "write_file",
    "run_command",
)

server: FastMCP = FastMCP("llmkernel-operator-bridge")


def _kernel_log_path() -> pathlib.Path | None:
    """Return the path to the kernel-side tool-call log, or None if unset."""
    raw = os.environ.get(_KERNEL_LOG_ENV)
    if not raw:
        return None
    return pathlib.Path(raw)


def _log_call(tool_name: str, arguments: dict[str, Any], run_id: str) -> None:
    """Append a structured record of an accepted tool call to the kernel log.

    Each record is a single JSON line: ``{"ts","tool","arguments","run_id"}``.
    Failures to write are swallowed — the harness orchestrator detects an
    empty log via the invariants check, which is more informative than a
    crash inside the MCP server.
    """
    path = _kernel_log_path()
    if path is None:
        return
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "tool": tool_name,
        "arguments": arguments,
        "run_id": run_id,
        "_rfc_version": _RFC_VERSION,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # pragma: no cover — best-effort logging
        print(f"[stub_kernel] kernel-log write failed: {exc}", file=sys.stderr)


def _ack(run_id: str) -> dict[str, Any]:
    """Build the shared acknowledged/run_id response shape from RFC-001."""
    return {"_rfc_version": _RFC_VERSION, "run_id": run_id, "acknowledged": True}


@server.tool()
def notify(observation: str, importance: str) -> dict[str, Any]:
    """Fire-and-forget annotation to the operator (RFC-001 ``notify``).

    Validates ``importance`` against the RFC-001 enum and logs the call.
    Returns the shared acknowledged/run_id envelope.
    """
    if importance not in {"trace", "info", "warn"}:
        raise ValueError(
            f"invalid importance {importance!r}; expected one of trace|info|warn"
        )
    run_id = str(uuid.uuid4())
    _log_call(
        "notify",
        {"observation": observation, "importance": importance},
        run_id,
    )
    return _ack(run_id)


@server.tool()
def report_completion(
    summary: str,
    artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Final completion signal for a unit of agent work (RFC-001 ``report_completion``).

    The orchestrator watches for this call to know the run is done and to
    emit the closing ``run.complete`` RFC-003 envelope.
    """
    run_id = str(uuid.uuid4())
    _log_call(
        "report_completion",
        {"summary": summary, "artifacts": artifacts or []},
        run_id,
    )
    return _ack(run_id)


def _register_stub(tool_name: str) -> None:
    """Register a tool that always returns the harness's not-implemented error.

    The stubs exist so the agent's tool catalog matches RFC-001's V1 shape;
    if it tries to use one of them the kernel log captures the call and the
    response makes the failure surface immediately rather than as a 32601.
    """

    def _handler(**kwargs: Any) -> dict[str, Any]:
        run_id = str(uuid.uuid4())
        _log_call(tool_name, kwargs, run_id)
        return {
            "_rfc_version": _RFC_VERSION,
            "run_id": run_id,
            "error": "not implemented in r2-prototype harness",
        }

    _handler.__name__ = tool_name
    _handler.__doc__ = (
        f"RFC-001 tool {tool_name!r} — stubbed in the R2-prototype harness."
    )
    server.tool(name=tool_name)(_handler)


for _name in _STUB_TOOL_NAMES:
    _register_stub(_name)


def main() -> None:
    """Run the FastMCP server on stdio. Blocks until stdin closes."""
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
