"""RFC-002 Claude Code provisioning recipe — prototype implementation.

This is the function under test by ``run_smoke.py``. It renders an MCP config
JSON, writes the canonical RFC-002 system prompt, builds the env-var bundle,
and ``Popen``-spawns ``claude`` with what the harness believes are the right
flags for stream-JSON output. Anything the harness had to guess about the
Claude Code CLI is flagged with ``# TODO(operator):`` so the first dry run
catches it.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

# Canonical RFC-002 system prompt, locked at template version 1.0.0. The
# wording derives from DR-0010 (force tool use, suppress text). Editing this
# string is an RFC-002 amendment; do not silently update it in code.
_SYSTEM_PROMPT_V1: str = (
    "All communication with the operator MUST occur through the provided MCP tools.\n"
    "Do not produce free-form text intended for the operator. Reasoning may be\n"
    "expressed in your internal monologue, which is not surfaced.\n"
    "\n"
    "Available tools (call them via MCP):\n"
    "- notify(observation, importance) — fire-and-forget annotation to the operator.\n"
    "  importance MUST be one of: \"trace\", \"info\", \"warn\".\n"
    "- report_completion(summary, artifacts?) — signal that the task is complete.\n"
    "\n"
    "For this task: use notify with importance=\"info\" to greet the operator,\n"
    "then call report_completion.\n"
    "Do NOT emit a textual reply.\n"
    "\n"
    "<!-- system-prompt-template v1.0.0; rfc=RFC-002 -->\n"
)

_MCP_SERVER_NAME: str = "llmkernel-operator-bridge"
_DISABLED_BUILTIN_TOOLS: str = "Bash,WebFetch,WebSearch,Read,Write,TodoWrite"

_HERE = pathlib.Path(__file__).resolve().parent
_STUB_KERNEL = _HERE / "stub_kernel.py"


def _render_mcp_config(
    mcp_config_path: pathlib.Path,
    kernel_log_path: pathlib.Path,
) -> None:
    """Write the MCP config JSON Claude Code reads to learn about the kernel.

    Format follows the de-facto MCP-client config shape: a top-level
    ``mcpServers`` map keyed by server name, each entry naming a stdio
    ``command`` + ``args`` pair plus an inherited ``env`` slice. Claude Code
    spawns the server itself; the harness only declares it.
    """
    config = {
        "mcpServers": {
            _MCP_SERVER_NAME: {
                "command": sys.executable,
                "args": [str(_STUB_KERNEL)],
                "env": {
                    "R2_KERNEL_LOG_FILE": str(kernel_log_path),
                    "PYTHONUNBUFFERED": "1",
                },
            }
        }
    }
    mcp_config_path.parent.mkdir(parents=True, exist_ok=True)
    mcp_config_path.write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf-8"
    )


def _render_system_prompt(system_prompt_path: pathlib.Path) -> None:
    """Write the canonical RFC-002 system prompt verbatim to disk."""
    system_prompt_path.parent.mkdir(parents=True, exist_ok=True)
    system_prompt_path.write_text(_SYSTEM_PROMPT_V1, encoding="utf-8")


def _build_env(
    *,
    zone_id: str,
    agent_id: str,
    mcp_config_path: pathlib.Path,
    system_prompt_path: pathlib.Path,
    llm_endpoint_url: str,
    kernel_log_path: pathlib.Path,
) -> dict[str, str]:
    """Build the env-var bundle RFC-002 prescribes for a Claude Code subprocess.

    Inherits the parent environment (so ``ANTHROPIC_API_KEY`` propagates to the
    proxy via the kernel's pass-through), then layers the RFC-002 keys on top.
    """
    env = dict(os.environ)
    env.update(
        {
            "ANTHROPIC_BASE_URL": llm_endpoint_url,
            "CLAUDE_CODE_MCP_CONFIG": str(mcp_config_path),
            "CLAUDE_CODE_WORKING_DIRECTORY": zone_id,
            "CLAUDE_CODE_SYSTEM_PROMPT_FILE": str(system_prompt_path),
            "CLAUDE_CODE_DISABLED_TOOLS": _DISABLED_BUILTIN_TOOLS,
            "LLMKERNEL_AGENT_ID": agent_id,
            "LLMKERNEL_ZONE_ID": zone_id,
            "R2_KERNEL_LOG_FILE": str(kernel_log_path),
        }
    )
    # ANTHROPIC_API_KEY is inherited from the parent shell unchanged.
    return env


def provision(
    zone_id: str,
    agent_id: str,
    task: str,
    mcp_config_path: pathlib.Path,
    system_prompt_path: pathlib.Path,
    llm_endpoint_url: str,
    kernel_log_path: pathlib.Path,
) -> subprocess.Popen:
    """Spawn a Claude Code subprocess wired to the harness fixtures.

    Renders the MCP config and system prompt to disk, builds the RFC-002
    environment, and ``Popen``-spawns ``claude`` with stdout/stderr captured
    as text. Returns the live process handle; the caller is responsible for
    timing out, terminating, and reaping it.
    """
    _render_mcp_config(mcp_config_path, kernel_log_path)
    _render_system_prompt(system_prompt_path)
    env = _build_env(
        zone_id=zone_id,
        agent_id=agent_id,
        mcp_config_path=mcp_config_path,
        system_prompt_path=system_prompt_path,
        llm_endpoint_url=llm_endpoint_url,
        kernel_log_path=kernel_log_path,
    )

    # TODO(operator): verify these flags against `claude --help` before the
    # first run. The harness's best guess for Claude Code's CLI shape is:
    #   --print                       run headless, no interactive UI
    #   --output-format=stream-json   emit JSON lines instead of rendered prose
    #   --system-prompt <path>        path to the system prompt file
    #   --mcp-config <path>           path to the MCP servers config JSON
    #   <task>                        positional task string (last argument)
    # If any of these are wrong, patch the argv list below and document the
    # deviation in `_ingest/prototypes/r2-prototype.md`.
    argv: list[str] = [
        "claude",
        "--print",
        "--output-format=stream-json",
        "--system-prompt",
        str(system_prompt_path),
        "--mcp-config",
        str(mcp_config_path),
        task,
    ]

    return subprocess.Popen(
        argv,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
