# RFC-002 — Claude Code provisioning procedure

## Status

Draft. Date: 2026-04-26. Version: 1.0.0. Canonical system-prompt-template version: `v1.0.0`.

This RFC is the layer-3 normative specification for spawning Claude Code agents into the paper-telephone topology. It MUST be accepted, and the [R2-prototype harness](../../_ingest/prototypes/r2-prototype.md) MUST report PASS for every invariant, before any code in `llmkernel/agent_supervisor.py` (Track B4) is merged. Conforming kernels honor this version; deviations require an RFC update or a documented amendment from the prototype run.

## Context

[DR-0010](../decisions/0010-force-tool-use-suppress-text.md) suppresses the agent's free-form text channel by system prompt; [DR-0012](../decisions/0012-llmkernel-sole-kernel.md) hardcodes LLMKernel as the only kernel; [DR-0015](../decisions/0015-kernel-extension-bidirectional-mcp.md) makes the kernel the trust boundary, the audit boundary, and the modification boundary for everything an agent does. Provisioning is the seam where these three commitments compose: the kernel writes the agent's MCP config, sets the agent's API base, renders the agent's system prompt, restricts the agent's built-in tools, and supervises the agent's lifecycle. Get any one of these wrong and the agent escapes the kernel's mediation surface.

Provisioning is also the riskiest unknown surfaced in [chapter 08](../dev-guide/08-blockers-mediator-standards.md). Documented behavior of `ANTHROPIC_BASE_URL`, of the MCP-config search path, and of the system-prompt enforcement under instruction-tuned models is the central integration risk for V1. The R2-prototype harness exists to convert "documented" into "observed"; this RFC records what the recipe MUST be in advance, so deviations the prototype finds are diffs against a written contract rather than improvisation.

The threat model the procedure defends against:

- The agent emits free-form text the operator surface cannot render structurally.
- The agent makes a model call that bypasses the kernel's LiteLLM proxy (no log, no audit).
- The agent uses a built-in tool (Bash, WebFetch, Write) that bypasses the kernel's proxied-tool layer (no log, no policy).
- The agent's API key is exposed to the agent process and could be exfiltrated.
- The agent process crashes silently and the operator receives no signal.

Each is addressed by a specific clause below.

## Specification

### Required environment variables

The kernel's agent supervisor MUST set the variables below before invoking `claude`. Variables marked **kernel-issued** are computed per spawn and never read by the agent host shell. Variables marked **passthrough** are inherited from the kernel's own environment unchanged.

| Variable | Set by | Read by | Value | Notes |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | passthrough | LiteLLM proxy in kernel; **NOT** by Claude Code directly | upstream Anthropic key | The kernel SHOULD strip this from the child env once an ephemeral token (below) is supported by Claude Code. V1 passes it through; V1.5 issues an HMAC bearer. |
| `ANTHROPIC_BASE_URL` | kernel-issued | Claude Code | `http://127.0.0.1:<litellm-port>/v1` | THE override that routes every model call through the kernel. MUST be a loopback address; MUST be reachable by the time `claude` starts. |
| `CLAUDE_CODE_MCP_CONFIG` | kernel-issued | Claude Code | absolute path to per-spawn JSON | See "MCP config JSON layout" below. The file MUST exist and be parseable before `claude` starts. |
| `CLAUDE_CODE_WORKING_DIRECTORY` | kernel-issued | Claude Code | absolute path inside the zone | Equal to the agent's `subprocess.Popen` `cwd`. The kernel MUST create the directory if it does not exist. |
| `CLAUDE_CODE_SYSTEM_PROMPT_FILE` | kernel-issued | Claude Code | absolute path | Rendered from the canonical template; one file per spawn. |
| `CLAUDE_CODE_ALLOWED_TOOLS` | kernel-issued | Claude Code | comma-separated list | Whitelist; see "Allowed-tools restriction policy". |
| `CLAUDE_CODE_DISABLED_TOOLS` | kernel-issued | Claude Code | comma-separated list | Blacklist; redundant safety with `ALLOWED_TOOLS`. |
| `LLMKERNEL_AGENT_ID` | kernel-issued | telemetry, RFC-003 envelopes | UUID v4 | Stable for the spawn's lifetime; written into every run record's `metadata.agent_id`. |
| `LLMKERNEL_ZONE_ID` | kernel-issued | telemetry, layout-tree updates | string | Identifies the zone the agent is bound to. |
| `LLMKERNEL_RUN_TRACE_ID` | kernel-issued | run-tracker | UUID v4 | Root trace id. RFC-003 `run.start.payload.trace_id` MUST equal this until the agent emits a child trace. |

The kernel MUST NOT pass any other environment variable through unredacted. In particular: shell-history variables (`HISTFILE`), CI secrets, and the operator's own `OPENAI_API_KEY`/`HUGGINGFACE_TOKEN`/etc. MUST be removed from the child env before exec.

### MCP config JSON layout

The kernel writes one MCP-config JSON file per spawn at `CLAUDE_CODE_MCP_CONFIG`. The file MUST be a UTF-8 JSON document with the following structure:

```json
{
  "mcpServers": {
    "llmkernel-operator-bridge": {
      "transport": "stdio",
      "command": "python",
      "args": ["-m", "llm_kernel.mcp_server", "--agent-id", "<LLMKERNEL_AGENT_ID>", "--zone-id", "<LLMKERNEL_ZONE_ID>"],
      "env": {
        "LLMKERNEL_RUN_TRACE_ID": "<LLMKERNEL_RUN_TRACE_ID>"
      },
      "allowedTools": [
        "ask", "clarify", "propose", "request_approval",
        "report_progress", "report_completion", "report_problem",
        "present", "notify", "escalate",
        "read_file", "write_file", "run_command"
      ]
    }
  }
}
```

Constraints:

- Exactly one entry under `mcpServers`. The name `llmkernel-operator-bridge` is a stable identifier; renaming it is a BREAKING change to RFC-002.
- `transport` MUST be `"stdio"` for V1. SSE and HTTP transports are deferred to V2 (port allocation, auth handshake, and client-reconnect semantics are out of scope here).
- `command` MUST be `"python"` (or an absolute path resolving to the same Python the kernel runs in) and `args[0:2]` MUST be `["-m", "llm_kernel.mcp_server"]` so the agent spawns its MCP server using the kernel's own code. Co-located code prevents version skew.
- `allowedTools` MUST exactly equal the thirteen-tool catalog from RFC-001, in the order shown. The kernel MUST validate the list before write; an MCP config presenting a tool not in RFC-001 is an RFC-002 violation.
- `env` MUST be a strict subset of the variables in the previous section. The kernel MUST NOT inject `ANTHROPIC_API_KEY` here.

The file MUST be readable only by the kernel-process owner (POSIX `0o600`; Windows ACL: kernel user only). Path placement: under the per-spawn temp directory `<work>/.run/<agent-id>/mcp-config.json`, never in a shared location.

### API base URL configuration

The kernel MUST stand up a LiteLLM proxy on a loopback ephemeral port before exec. The procedure:

1. Kernel allocates a free port via `socket.socket().bind(('127.0.0.1', 0))`.
2. Kernel starts the LiteLLM proxy in the same Python process (uvicorn worker, or in-process FastAPI app); proxy MUST be reachable by the time the spawn begins.
3. Kernel sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/v1` in the child env.
4. Proxy validates incoming bearer per "Authentication" below and forwards to the real provider via LiteLLM. Every request and response is logged as a LangSmith `run.event` keyed by `LLMKERNEL_RUN_TRACE_ID` BEFORE the response returns to the agent.

**Authentication.** V1 passes `ANTHROPIC_API_KEY` through and accepts that the agent process sees it. V1.5 SHOULD issue a per-agent HMAC bearer (`HMAC-SHA256(kernel_secret, agent_id || nonce)`) and the LiteLLM proxy SHOULD validate it before forwarding; the upstream Anthropic key never leaves the kernel. RFC-002 v1.0.0 documents the V1 posture; the V1.5 posture lands as v1.1.0 (additive) once the prototype confirms the Claude Code CLI does not break with a non-Anthropic-format bearer.

**Streaming.** Claude Code MUST receive streaming SSE responses from the LiteLLM proxy unchanged from what the upstream provider sends. The proxy MUST NOT collapse, batch, or buffer streams. The proxy MAY tee a copy to the run-tracker for logging.

**Failure handling.** If the LiteLLM proxy is not reachable at spawn time, the kernel MUST refuse to spawn and surface a synthetic `report_problem(severity="error", description="LiteLLM proxy unreachable", ...)` to the operator. See "Failure modes" below.

### Allowed-tools restriction policy

Claude Code ships with a set of built-in tools (Bash, WebFetch, WebSearch, Read, Write, Edit, Glob, Grep, TodoWrite, etc.). V1 disables every built-in tool that performs an action the kernel's proxied-tool layer can mediate, and disables every built-in tool that bypasses the kernel entirely.

`CLAUDE_CODE_DISABLED_TOOLS` MUST contain at least:

- `Bash` — replaced by RFC-001 `run_command` (kernel-mediated, logged, policy-checkable).
- `WebFetch`, `WebSearch` — bypass the kernel's audit layer; not replaced in V1.
- `Read`, `Write` — replaced by RFC-001 `read_file`, `write_file`.
- `Edit` — replaced by RFC-001 `write_file` plus operator-side diff approval via `request_approval`.
- `TodoWrite` — replaced by RFC-001 `report_progress`.

`CLAUDE_CODE_ALLOWED_TOOLS` MUST contain at most:

- `Glob` — read-only filesystem traversal; useful for navigation.
- `Grep` — read-only content search; useful for navigation.

These two are kept because they have no side effects, do not exfiltrate data through a non-MCP channel, and let the agent reduce round-trip latency for purely-navigational reads. The kernel MAY tighten this further (disable both); MUST NOT loosen it (allow `Bash`, `Edit`, etc. would be a BREAKING change).

A fingerprint of the allowed/disabled lists MUST be embedded in `metadata.tool_policy_fingerprint` of the spawn's first run record so post-hoc audits can detect drift.

### System prompt template

The canonical V1 system prompt template, version `v1.0.0`, is reproduced verbatim below. Implementations MUST render this text into `CLAUDE_CODE_SYSTEM_PROMPT_FILE` with no modifications other than substituting the bracketed task block at the marked point. The trailing version comment is part of the template; removing it is a BREAKING change.

```text
You are an autonomous coding agent operating inside the llmb_rts_notebook
operator console. The kernel that hosts you mediates every model call and
every tool call you make.

All communication with the operator MUST occur through the provided MCP
tools. Do not produce free-form text intended for the operator. Reasoning
may be expressed in your internal monologue, which is not surfaced to the
operator. Use it freely; do not summarize for the operator.

Available MCP tools (call them, do not describe them):

- ask(question, context, options?) — operator-targeted free-form question.
- clarify(question, options) — typed clarification with a discrete option set.
- propose(action, rationale, preview?, scope?) — proposed action with rationale.
- request_approval(action, diff_preview, risk_level, alternatives?) — anything
  the operator must approve before you proceed.
- report_progress(status, percent?, blockers?) — status update during work.
- report_completion(summary, artifacts?) — final completion signal.
- report_problem(severity, description, suggested_remediation?) — blocking issue.
- present(artifact, kind, summary) — generated content lifted to the artifacts
  surface.
- notify(observation, importance) — fire-and-forget annotation.
- escalate(reason, severity) — flag operator attention urgently.
- read_file(path, encoding?) — read a file from the workspace.
- write_file(path, content, mode?) — write a file (operator approval required
  for risk_level >= medium; surface a request_approval first if unsure).
- run_command(command, args?, cwd?, timeout?) — run a shell command.

Tool selection guidance:
- When you would say "should I do X?", call clarify with concrete options.
- When proposing an action, call propose with a rationale.
- When asking for approval to do something already proposed, call
  request_approval with a diff preview when applicable.
- When reporting status during a long task, call report_progress.
- When the task is done, call report_completion.
- Prefer one structured tool call over verbose prose.
- Batch progress reports when possible; do not flood the operator.
- Emit report_completion exactly once at task end.

If you must convey something that does not fit any tool, call notify with
importance="low". Do not produce a free-form text response to the operator.

[TASK_BLOCK]

<!-- system-prompt-template v1.0.0; rfc=RFC-002 -->
```

The substitution `[TASK_BLOCK]` MUST be replaced by the operator's task verbatim, with no surrounding markdown wrapping or summary. The kernel MUST NOT inject additional instructions; behavior steering is done through the tool catalog (RFC-001), not through prompt creep.

### Process lifecycle

The kernel agent supervisor (Track B4) MUST implement the following lifecycle:

1. **Pre-spawn validation.** Verify `ANTHROPIC_API_KEY` is set and non-empty; verify the LiteLLM proxy responds to a `GET /v1/models` health check; verify the per-spawn MCP config validates against the schema in this RFC; verify the rendered system prompt is non-empty. Failure of any check MUST refuse the spawn and surface a synthetic `report_problem`.
2. **Spawn.** `subprocess.Popen` the `claude` CLI with the env above, `cwd=CLAUDE_CODE_WORKING_DIRECTORY`, `stdin=PIPE`, `stdout=PIPE`, `stderr=PIPE`, `text=True`. The recommended argv is below; the prototype harness verifies it empirically.
   ```python
   argv = [
       "claude",
       "--print",
       "--output-format=stream-json",
       "--system-prompt", str(system_prompt_path),
       "--mcp-config", str(mcp_config_path),
       task,
   ]
   ```
   If `claude --help` reports different flag names (likely `--system-prompt-file` or `--append-system-prompt`), the prototype-run amendment lands as RFC-002 v1.0.1 (additive note) or v1.1.0 (renamed flag is breaking against the recommended argv but additive against the function contract).
3. **Stream parsing.** The kernel reads `stdout` line by line. Each line MUST be one of: a Claude stream-json record, an MCP JSON-RPC frame routed through Claude's MCP plumbing, or empty. The kernel MUST emit a Family A span (per RFC-005 / RFC-006) for every classified line:
   - **Tool-use blocks** become tool-typed spans (`llmnb.run_type: "tool"`) routed through MCP.
   - **Stream-json `system` / `result` / `error`** message types become `agent_emit` spans with the corresponding `llmnb.emit_kind` (`system_message` / `result` / `error`).
   - **Reasoning text preceding a tool call** becomes an `agent_emit` span with `llmnb.emit_kind: "reasoning"`.
   - **Free-form prose despite the suppression prompt** (a DR-0010 violation in spirit, but no longer silently dropped) becomes an `agent_emit` span with `llmnb.emit_kind: "prose"`. If prose violations exceed five per minute, the kernel MUST additionally escalate via a synthetic `escalate(reason="repeated DR-0010 violations", severity="medium")` for operator attention.
   - **Lines that fail both parsers** become `agent_emit` spans with `llmnb.emit_kind: "malformed_json"` and `llmnb.parser_diagnostic` set to a short error string.
   This refines DR-0010: structured tool calls remain the *primary* operator-facing channel; raw output is captured and surfaced as `agent_emit` rather than silently logged. Renderers visually de-emphasize `agent_emit` (collapsed by default) so the forced-tool-use UX is preserved while observability is end-to-end.
4. **stderr capture.** Subprocess stderr is captured line by line and emitted as `agent_emit` spans with `llmnb.emit_kind: "stderr"`. The kernel additionally writes stderr to its own log file (indexed by `agent_id`) for debugging. Renderers MAY collapse stderr by default in the UI, but the data MUST reach the operator surface — silent drops are forbidden.
5. **Restart logic.** On agent process exit code != 0:
   - Restart attempt 1: immediate; new spawn with the same task and a fresh agent_id; previous run records remain attributed to the dead agent_id.
   - Restart attempt 2: 5s backoff.
   - Restart attempt 3: 25s backoff.
   - Beyond 3 attempts in 5 minutes: kernel MUST emit `report_problem(severity="error", description="agent process unrestartable", suggested_remediation=...)` and STOP attempting.
6. **Clean shutdown.** SIGTERM, then 10s grace, then SIGKILL. The kernel MUST emit a `run.complete` for every still-open run record before tearing down the agent state. Orphaned runs are an RFC-004 cross-boundary failure.
7. **Resource caps.** RAM cap, CPU-time cap, and wall-clock cap are V2. V1 enforces no caps; the operator is the wall.

### Reference implementation skeleton

```python
import os
import subprocess
import uuid
from pathlib import Path

CANONICAL_SYSTEM_PROMPT_TEMPLATE = """\
... (full template text from "System prompt template" above) ...
"""

DISABLED_TOOLS = "Bash,WebFetch,WebSearch,Read,Write,Edit,TodoWrite"
ALLOWED_TOOLS = "Glob,Grep"


def provision_claude_code(
    zone_id: str,
    agent_id: str,
    task: str,
    work_dir: Path,
    llm_endpoint_url: str,
    api_key: str,
) -> subprocess.Popen:
    """Spawn a Claude Code subprocess wired into the paper-telephone topology.

    Returns a Popen handle with stdout/stderr piped. The caller (kernel
    agent supervisor) is responsible for stream parsing per RFC-002 §
    Process lifecycle.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    mcp_config_path = work_dir / "mcp-config.json"
    system_prompt_path = work_dir / "system-prompt.txt"
    trace_id = str(uuid.uuid4())

    mcp_config_path.write_text(_render_mcp_config(agent_id, zone_id, trace_id))
    system_prompt_path.write_text(
        CANONICAL_SYSTEM_PROMPT_TEMPLATE.replace("[TASK_BLOCK]", task)
    )

    env = {k: v for k, v in os.environ.items() if not _is_secret_var(k)}
    env.update({
        "ANTHROPIC_API_KEY": api_key,
        "ANTHROPIC_BASE_URL": llm_endpoint_url,
        "CLAUDE_CODE_MCP_CONFIG": str(mcp_config_path),
        "CLAUDE_CODE_WORKING_DIRECTORY": str(work_dir),
        "CLAUDE_CODE_SYSTEM_PROMPT_FILE": str(system_prompt_path),
        "CLAUDE_CODE_ALLOWED_TOOLS": ALLOWED_TOOLS,
        "CLAUDE_CODE_DISABLED_TOOLS": DISABLED_TOOLS,
        "LLMKERNEL_AGENT_ID": agent_id,
        "LLMKERNEL_ZONE_ID": zone_id,
        "LLMKERNEL_RUN_TRACE_ID": trace_id,
    })

    argv = [
        "claude", "--print", "--output-format=stream-json",
        "--system-prompt", str(system_prompt_path),
        "--mcp-config", str(mcp_config_path),
        task,
    ]
    return subprocess.Popen(
        argv, env=env, cwd=str(work_dir),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
```

`_render_mcp_config` and `_is_secret_var` are uninteresting; the latter strips `*_TOKEN`, `*_KEY`, `*_PASSWORD`, `*_SECRET`, `OPENAI_*`, `GROQ_*`, etc. before passing env through. The kernel MUST also drop `LANG`/`LC_*`/locale variables that cause encoding mismatches in the subprocess; that hygiene is implementation detail, not RFC-grade.

## Backward-compatibility analysis

The compatibility classes follow [the docket README](README.md). Specific to provisioning:

**Additive** (no version bump beyond a patch increment, e.g. 1.0.0 → 1.0.1):
- New optional environment variables consumed by the kernel but ignored if absent.
- New entries in `CLAUDE_CODE_DISABLED_TOOLS` (V1 starts maximally restrictive; future tightening is additive).
- New optional fields in the MCP config JSON (e.g. `metadata.tool_policy_fingerprint`).
- New sections appended to the system prompt template, marked with `<!-- additive vN.N.N -->` comments.
- New restart-policy parameters that fall back to documented defaults.

**Deprecating** (minor version bump, e.g. 1.0.x → 1.1.0):
- A required environment variable is renamed; both old and new names are honored for one minor version with a deprecation warning logged. The deprecation note in the RFC names the planned removal version.
- The MCP config server name `llmkernel-operator-bridge` MUST NOT be deprecated in v1; it is the stable identifier the prototype harness and the run-tracker key on.
- An entry in `CLAUDE_CODE_ALLOWED_TOOLS` is removed (tightening); old kernels still pass it but the agent stops using it because the system-prompt list no longer mentions it.

**Breaking** (major version bump, e.g. 1.x.x → 2.0.0):
- An environment variable is renamed without a deprecation period.
- The system-prompt-template version is bumped major (semantic change to tool selection guidance).
- The MCP config schema is restructured (`mcpServers` shape changed; transport requirement changed; allowed-tools shape changed).
- The recommended argv for `claude` is changed in a way old supervisors cannot produce.
- The `tool_policy_fingerprint` algorithm changes (auditors lose the ability to compare old to new).

The system prompt template carries its own version (`v1.0.0` in the trailing comment) independent from RFC-002's version. Both follow semver. RFC-002 v1.x.x MAY ship template versions v1.x.x or v1.(x+1).x; bumping the template to v2.0.0 is an RFC-002 major bump as well.

Receivers (the kernel's supervisor) MUST reject MCP configs and system prompts whose version major-version mismatches the supervisor's RFC-002 major version.

## Failure modes

The provisioning failure surface, with required kernel responses:

| Trigger | Symptoms | Recovery | Operator surface | Log signature |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` missing or invalid | Pre-spawn validation fails OR first model call returns 401 | Refuse spawn pre-validation; on 401 mid-run, halt agent and emit `report_problem(severity="error")` | structured error; cell halts | `provisioning.api_key.invalid` |
| MCP server unreachable when Claude Code starts | Claude Code logs MCP connection error to stderr; never emits a tool call | Refuse spawn (the kernel hosts the MCP server; this is a kernel internal failure); emit `report_problem` | structured error | `provisioning.mcp.unreachable` |
| LiteLLM proxy not started before spawn | Spawn races; first model call fails with connection refused | Pre-spawn health-check the proxy; refuse if down | structured error | `provisioning.litellm.unreachable` |
| Agent emits prose despite system prompt | Stdout line that parses as neither stream-json nor MCP JSON-RPC | Emit `agent_emit` span (`llmnb.emit_kind: "prose"`); on flood (>5/min), additionally `escalate` | `agent_emit` cell-output span (visually de-emphasized); escalate above flood threshold | `dr0010.violation`, `dr0010.flood` |
| Agent process crashes (exit != 0) | `wait()` returns non-zero | Restart per lifecycle policy (≤3 attempts); after exhaustion, `report_problem(severity="error")` | structured error after 3rd failure | `agent.crash`, `agent.unrestartable` |
| System-prompt-template version mismatch | Kernel renders v1.0.0; supervisor expects v2.0.0 | Refuse spawn at validation | structured error | `provisioning.template.version_mismatch` |
| Allowed-tools restriction bypass attempt | Agent emits a tool call for a tool not in `mcpServers.*.allowedTools` | Kernel MCP server MUST return JSON-RPC `-32601 method not found`; emit `agent_emit` span (`llmnb.emit_kind: "invalid_tool_use"`); do NOT auto-terminate | `agent_emit` cell-output span | `dr0010.bypass_attempt` |
| Stderr containing prose | Common from `claude` itself | Capture line by line; emit `agent_emit` spans (`llmnb.emit_kind: "stderr"`); also write to kernel debug log | `agent_emit` cell-output spans (collapsed by default) | `agent.stderr` |
| Malformed tool-use JSON | Stdout block looks like a tool-use but parser fails to deserialize | Emit `agent_emit` span (`llmnb.emit_kind: "malformed_json"`) with `llmnb.parser_diagnostic`; do NOT auto-terminate | `agent_emit` cell-output span | `parser.malformed_json` |
| Hang (no stdout, no exit) for >120s | `report_progress` never arrives, agent silent | Send SIGTERM; treat as restart trigger | structured error after restart exhaustion | `agent.hang` |
| Disk full when writing MCP config or system prompt | OSError during file write | Pre-spawn validation fails; refuse spawn; surface `report_problem(severity="error")` | structured error | `provisioning.disk.full` |

V1 fails closed: the kernel halts agent operations and surfaces a structured error; no silent retries beyond the documented restart policy.

## Worked example

The Stage-3 paper-telephone smoke (target: `notify`). The end-to-end sequence MUST hold for V1 ship.

1. Operator opens VS Code on a workspace at `C:\Users\Op\code\demo`. Creates `test.llmnb`. Types into the first cell:
   ```
   /spawn alpha task:"Use the notify tool to greet the operator. Then call report_completion."
   ```
2. The extension's `NotebookController.executeHandler` receives the cell, dispatches to LLMKernel via the standard kernel-protocol `execute_request`. The cell payload includes `agent_id=alpha`, `zone_id=demo`, the task string.
3. The kernel allocates `LLMKERNEL_RUN_TRACE_ID = "8e8a6b27-1d7c-46f2-9116-cb8b5b87f2cd"` and the per-spawn temp dir `<work>/.run/alpha/`.
4. The kernel renders `mcp-config.json` containing the canonical 13-tool catalog under `mcpServers.llmkernel-operator-bridge` with `transport=stdio`, `command=python`, `args=["-m", "llm_kernel.mcp_server", "--agent-id", "alpha", "--zone-id", "demo"]`. POSIX 0o600 / Windows ACL kernel-only.
5. The kernel renders `system-prompt.txt` from the canonical template with `[TASK_BLOCK]` replaced by `Use the notify tool to greet the operator. Then call report_completion.`.
6. The kernel allocates an ephemeral port (e.g. 51742), starts the LiteLLM proxy on `http://127.0.0.1:51742/v1`, health-checks `GET /v1/models` for 200.
7. The kernel `Popen`s `claude --print --output-format=stream-json --system-prompt <path> --mcp-config <path> "Use the notify tool..."` with the env per the table above.
8. Claude Code starts. It loads the MCP config, spawns the kernel's MCP server over stdio (`python -m llm_kernel.mcp_server ...`). It receives the system prompt. It receives the task on argv[].
9. Claude Code makes a model call. The HTTP request goes to `127.0.0.1:51742/v1/messages`. The LiteLLM proxy logs the request as `run.event(event_type=token, ...)` per RFC-003. The proxy forwards to `https://api.anthropic.com/v1/messages` with the real `ANTHROPIC_API_KEY`. Streaming response returns; the proxy tees a copy to the run-tracker.
10. The model returns a function call. Claude Code emits an MCP JSON-RPC frame on stdout: `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"notify","arguments":{"observation":"hello operator","importance":"low"}},"id":1}`. The frame goes to the MCP server (the kernel's stdio child).
11. The kernel's MCP server (Track B1) receives the call, validates against RFC-001's `notify` schema, emits a `run.start` envelope per RFC-003 (correlation_id = run_id; trace_id = `8e8a6b27-...`).
12. The kernel returns the success result to the MCP server, which returns it to Claude Code as `{"jsonrpc":"2.0","result":{"acknowledged":true,"run_id":"<run-id>","_rfc_version":"1.0.0"},"id":1}`.
13. The kernel emits `run.complete` for the notify run. Extension renders the `notify` widget in the cell output via the `application/vnd.rts.run+json` MIME renderer.
14. Claude Code makes another model call (with the notify result added to context). The model returns a function call to `report_completion`. Same flow.
15. After `report_completion`, Claude Code exits 0. The supervisor reaps the process, emits any final `run.complete` envelopes, and tears down the spawn temp dir.
16. The cell is marked complete by the extension when the supervisor reports the agent terminated.

Invariants the prototype harness asserts at the end:

- The kernel-side MCP log contains exactly one accepted `notify` call and one accepted `report_completion` call.
- The LiteLLM proxy log contains at least two model-call entries.
- The agent emitted no prose to stdout (every line parsed as either stream-json or MCP JSON-RPC).
- Every `run.start` has a matching `run.complete` (RFC-004 invariant I1).
- The agent terminated cleanly (exit 0).

## Consumers

This RFC is the contract for:

- LLMKernel agent supervisor (Track B4) — implements `provision_claude_code` and the lifecycle. Lives at `vendor/LLMKernel/llm_kernel/agent_supervisor.py`.
- LLMKernel LiteLLM proxy (Track B5) — stands up the endpoint at `ANTHROPIC_BASE_URL`. Lives at `vendor/LLMKernel/llm_kernel/litellm_proxy.py`.
- LLMKernel MCP server (Track B1) — receives the calls Claude Code emits over the stdio MCP transport. Lives at `vendor/LLMKernel/llm_kernel/mcp_server.py`.
- LLMKernel run-tracker (Track B2) — keys runs by `LLMKERNEL_RUN_TRACE_ID` and `LLMKERNEL_AGENT_ID`. Lives at `vendor/LLMKernel/llm_kernel/run_tracker.py`.
- The R2-prototype harness ([`_ingest/prototypes/r2-prototype/`](../../_ingest/prototypes/r2-prototype/)) — verifies this RFC end-to-end before Track B starts.
- RFC-004 — the failure modes table here is a row-by-row contributor to RFC-004's failure taxonomy.
- The V1 setup documentation — the env-var table is reproduced for human installers.
- Future agent integrations (OpenCode, ACP, others) — derive their own provisioning RFCs from this one's structure; the canonical system-prompt template is the load-bearing piece they MUST adapt or replace.

## Source

- [DR-0010 — force tool use, suppress text](../decisions/0010-force-tool-use-suppress-text.md)
- [DR-0012 — LLMKernel as sole kernel](../decisions/0012-llmkernel-sole-kernel.md)
- [DR-0015 — kernel/extension bidirectional MCP (paper-telephone)](../decisions/0015-kernel-extension-bidirectional-mcp.md)
- [Chapter 06 — VS Code notebook substrate](../dev-guide/06-vscode-notebook-substrate.md) (forced-tool-use enforcement; system-prompt language baseline)
- [Chapter 08 — Blockers, mediator, and standards discipline](../dev-guide/08-blockers-mediator-standards.md) (RFC-002 brief; the recipe sketch)
- [RFC-001 — V1 MCP tool taxonomy](RFC-001-mcp-tool-taxonomy.md) (the tool catalog this RFC's system prompt references)
- [RFC-003 — custom Jupyter message format](RFC-003-custom-message-format.md) (the run lifecycle this RFC's reference implementation emits)
- [RFC-004 — failure-mode analysis](RFC-004-failure-modes.md) (the cross-boundary failure surface this RFC's failure modes contribute to)
