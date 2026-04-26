"""R2-prototype smoke-test orchestrator.

Resets the run dir, starts the stub LiteLLM proxy, spawns Claude Code via
``provision_claude_code.provision``, watches agent stdout for tool calls,
emits RFC-003 envelopes, and validates four invariants. Exits 0 on full
PASS, 1 otherwise.
"""

from __future__ import annotations

import json, os, pathlib, shutil, subprocess, sys, time, uuid  # noqa: E401
from datetime import datetime, timezone
from typing import Any

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))  # so `python run_smoke.py` finds the sibling.

import provision_claude_code  # noqa: E402

_TASK = "Use the notify tool to greet the operator. Then call report_completion."
_ZONE_ID = "r2-prototype-zone"
_AGENT_ID = "r2-prototype-alpha"
_OVERALL_TIMEOUT_S = 60.0
_RFC_VERSION = "1.0.0"

_RUN_DIR = _HERE / ".run"
_RUN_LOG = _HERE / "run.log"  # written by stub_litellm_proxy
_TRACE_PATH = _RUN_DIR / "run.trace.jsonl"
_KERNEL_LOG_PATH = _RUN_DIR / "kernel.log.jsonl"
_MCP_CONFIG_PATH = _RUN_DIR / "mcp_config.json"
_SYSTEM_PROMPT_PATH = _RUN_DIR / "system_prompt.txt"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _emit(message_type: str, cid: str, payload: dict[str, Any], trace_fh: Any) -> None:
    """Write an RFC-003 universal envelope to stdout and the trace file."""
    line = json.dumps({"message_type": message_type, "direction": "kernel→extension",
                       "correlation_id": cid, "timestamp": _now(),
                       "rfc_version": _RFC_VERSION, "payload": payload}, ensure_ascii=False)
    print(line, flush=True)
    trace_fh.write(line + "\n")
    trace_fh.flush()


def _try_parse_json(line: str) -> dict[str, Any] | None:
    """Return the parsed JSON object, or None if the line is not a JSON object."""
    line = line.strip()
    if not line or not (line.startswith("{") and line.endswith("}")):
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    """Read a JSONL file as a list of dicts, skipping unparseable lines."""
    if not path.exists():
        return []
    return [p for p in (_try_parse_json(ln) for ln in
                        path.read_text(encoding="utf-8").splitlines()) if p is not None]


def _reset_run_dir() -> None:
    """Wipe `.run/` + the proxy's `run.log` so each run starts clean."""
    if _RUN_DIR.exists():
        shutil.rmtree(_RUN_DIR)
    _RUN_DIR.mkdir(parents=True, exist_ok=True)
    _RUN_LOG.unlink(missing_ok=True)


def _start_proxy() -> tuple[subprocess.Popen, str]:
    """Spawn the stub LiteLLM proxy and read its bound URL from stdout."""
    proxy = subprocess.Popen(
        [sys.executable, str(_HERE / "stub_litellm_proxy.py")],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, env=dict(os.environ),
    )
    assert proxy.stdout is not None
    url = proxy.stdout.readline().strip()
    if not url.startswith("http://"):
        proxy.terminate()
        raise RuntimeError(f"proxy did not announce a URL on stdout (got {url!r})")
    return proxy, url


def _drive_agent(
    agent: subprocess.Popen, cid: str, trace_fh: Any,
) -> tuple[bool, list[str], bool]:
    """Stream agent stdout; emit envelopes; return (saw_completion, plain, started)."""
    started = saw_completion = False
    plain: list[str] = []
    deadline = time.monotonic() + _OVERALL_TIMEOUT_S
    assert agent.stdout is not None
    while time.monotonic() < deadline:
        line = agent.stdout.readline()
        if line == "" and agent.poll() is not None:
            break
        if line == "":
            continue
        parsed = _try_parse_json(line)
        if parsed is None:
            plain.append(line.rstrip("\n"))
            continue
        if not started:
            _emit("run.start", cid, {
                "id": cid, "trace_id": cid, "parent_run_id": None,
                "name": "r2-prototype-task", "run_type": "agent",
                "start_time": _now(), "inputs": {"task": _TASK},
                "tags": [f"agent:{_AGENT_ID}", f"zone:{_ZONE_ID}"],
                "metadata": {"agent_id": _AGENT_ID, "zone_id": _ZONE_ID},
            }, trace_fh)
            started = True
        _emit("run.event", cid, {"run_id": cid, "event_type": "tool_call",
                                 "data": parsed, "timestamp": _now()}, trace_fh)
        # report_completion can surface under multiple stream-json shapes;
        # match the raw text broadly rather than guessing the structure.
        if "report_completion" in line:
            saw_completion = True
            break
    if started:
        _emit("run.complete", cid, {
            "run_id": cid, "end_time": _now(),
            "outputs": {"saw_completion": saw_completion}, "error": None,
            "status": "success" if saw_completion else "timeout",
        }, trace_fh)
    return saw_completion, plain, started


def _terminate(proc: subprocess.Popen | None) -> None:
    """Best-effort terminate-then-kill of a child process."""
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def _invariants(
    kernel_calls: list[dict[str, Any]], plain: list[str],
    proxy_n: int, started: bool, saw_completion: bool,
) -> list[tuple[bool, str, str]]:
    """Compute (passed, name, detail) for each of the four invariants."""
    notify_n = sum(1 for c in kernel_calls if c.get("tool") == "notify")
    plain_detail = (f"{len(plain)} plain-text line(s); first: {plain[0]!r}"
                    if plain else "all stdout lines parsed as JSON-RPC / stream-json records")
    return [
        (notify_n >= 1, "agent emitted at least one notify tool call",
         f"observed {notify_n} notify call(s) in kernel.log.jsonl"),
        (not plain, "agent stdout contained no free-form prose", plain_detail),
        (proxy_n >= 1, "model call routed through stub LiteLLM proxy",
         f"{proxy_n} entry(ies) in run.log"),
        (started and saw_completion, "run.start has matching run.complete",
         f"started={started}, saw_completion={saw_completion}"),
    ]


def main() -> int:
    """Run the harness end-to-end and return a process exit code."""
    _reset_run_dir()
    cid = str(uuid.uuid4())
    proxy, proxy_url = _start_proxy()
    agent: subprocess.Popen | None = None
    saw_completion = started = False
    plain: list[str] = []
    try:
        with _TRACE_PATH.open("w", encoding="utf-8") as trace_fh:
            agent = provision_claude_code.provision(
                zone_id=_ZONE_ID, agent_id=_AGENT_ID, task=_TASK,
                mcp_config_path=_MCP_CONFIG_PATH, system_prompt_path=_SYSTEM_PROMPT_PATH,
                llm_endpoint_url=proxy_url, kernel_log_path=_KERNEL_LOG_PATH,
            )
            saw_completion, plain, started = _drive_agent(agent, cid, trace_fh)
    finally:
        _terminate(agent)
        _terminate(proxy)
    proxy_n = (sum(1 for ln in _RUN_LOG.read_text(encoding="utf-8").splitlines() if ln.strip())
               if _RUN_LOG.exists() else 0)
    all_pass = True
    for passed, name, detail in _invariants(
        _read_jsonl(_KERNEL_LOG_PATH), plain, proxy_n, started, saw_completion,
    ):
        print(f"{'PASS' if passed else 'FAIL'}: {name} — {detail}")
        all_pass = all_pass and passed
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
