# R2-prototype harness

A self-contained smoke test that verifies the [RFC-002](../../../docs/rfcs/)
Claude Code provisioning recipe end-to-end on the operator's machine, before
Track B implements the real LLMKernel-side hardening. The harness wires up the
two minimum-viable RFC-001 tools (`notify` and `report_completion`) through a
stub MCP kernel, forwards model calls through a stub LiteLLM proxy, and asserts
that Claude Code communicates exclusively through structured tool calls.

## Purpose

This harness exists to flush out integration surprises *before* RFC-002 is
locked. If Claude Code's CLI flags or environment-variable contract differ
from RFC-002's specification, the harness exit code will be non-zero and the
operator amends RFC-002 (or the implementation plan) accordingly. The
prototype is intentionally thin — no run-tracker, no LangSmith POST/PATCH,
no extension wiring. It is the paper-telephone topology in cardboard.

## Prerequisites

- `ANTHROPIC_API_KEY` exported in the parent shell. The stub LiteLLM proxy
  forwards to `https://api.anthropic.com/v1/messages` using this key.
- Claude Code CLI installed and on `PATH`. Verify with `claude --version`.
- `pixi install -e kernel` has succeeded for this workspace. The harness's
  Python dependencies (FastAPI, uvicorn, httpx, anthropic, mcp, pydantic)
  are expected to come from the `kernel` pixi feature; if any are missing
  see `requirements.txt` next to this README.

## How to run

From the workspace root:

```bash
pixi run -e kernel python _ingest/prototypes/r2-prototype/run_smoke.py
```

The orchestrator allocates a temp directory at
`_ingest/prototypes/r2-prototype/.run/`, starts the stub LiteLLM proxy on a
free ephemeral port, renders the MCP config + system prompt, spawns Claude
Code with the RFC-002 environment variables set, and watches the agent's
output for tool calls. Total wall-clock budget is 60 seconds.

## What success looks like

The orchestrator prints one line per invariant, then exits 0:

```
PASS: agent emitted at least one notify tool call
PASS: agent stdout contained no free-form prose
PASS: model call routed through stub LiteLLM proxy
PASS: run.start has matching run.complete
```

The trace of RFC-003 envelopes (run.start, run.event per tool call,
run.complete) is also written to `.run/run.trace.jsonl` for inspection.

## What to do if it fails

1. Read the FAIL line(s) and the corresponding entries in `run.log`
   (proxy traffic) and `.run/kernel.log.jsonl` (MCP tool calls).
2. Decide whether the divergence is a spec bug or an implementation bug:
   - If RFC-002's recipe is wrong (e.g. the env-var name is different in
     Claude Code's actual CLI), file an amendment in
     [`../r2-prototype.md`](../r2-prototype.md) under "Recommended RFC-002
     amendments" and update the RFC.
   - If the harness is wrong (e.g. a flag was guessed and `claude --help`
     shows a different one), patch the harness in place and re-run.
3. Re-run `run_smoke.py` until all four invariants pass.
4. Fill in the verification report stub at
   [`../r2-prototype.md`](../r2-prototype.md) and commit it alongside any
   RFC-002 amendments.

## Layout

```
r2-prototype/
  __init__.py                 — package marker + module docstring
  README.md                   — this file
  requirements.txt            — extra deps if `kernel` feature lacks them
  stub_kernel.py              — stub MCP server (notify + report_completion)
  stub_litellm_proxy.py       — FastAPI proxy → api.anthropic.com
  provision_claude_code.py    — RFC-002 provisioning recipe (under test)
  run_smoke.py                — orchestrator + invariant checks
  run.log.gitkeep             — keeps run.log path stable in VCS
```

The harness is best-effort, not a release artifact: every Python file is
under 200 lines, every guessed Claude-Code-CLI behavior is marked
`# TODO(operator):` for verification on first run.
