# Contract: AgentSupervisor

**Status**: `contract` (V1 shipped — `spawn`, `respawn_from_config`, `terminate_all` present in code; `send_user_turn`, `fork`, restart-window are V1 spec'd / partially implemented)
**Module**: `vendor/LLMKernel/llm_kernel/agent_supervisor.py` — `class AgentSupervisor` and `class AgentHandle`
**Source specs**: [BSP-002 §4](../../notebook/BSP-002-conversation-graph.md#4-persistent-agent-lifecycle), [BSP-002 §9](../../notebook/BSP-002-conversation-graph.md#9-implementation-slices) (K-AS slice), [RFC-002 §"Process lifecycle"](../../rfcs/RFC-002-claude-code-provisioning.md), [RFC-006 §8](../../rfcs/RFC-006-kernel-extension-wire-format.md#8--family-f-notebook-metadata-bidirectional-in-v202) (post-hydrate respawn)
**Related atoms**: [agent](../concepts/agent.md), [operations/spawn-agent](../operations/spawn-agent.md), [contracts/metadata-writer](metadata-writer.md), [protocols/family-d-event-log](../protocols/family-d-event-log.md)

## Definition

The `AgentSupervisor` owns every [agent](../concepts/agent.md) subprocess for one kernel: spawn, runtime supervision (silence watchdog, crash restart, prose-flood detection), idle resume (`--resume`), branch (`/branch`), revert via SIGTERM + new session, idle exit, post-hydrate respawn from `config.recoverable.agents[]`. It is the K-AS slice in BSP-002 §9. The supervisor wires every agent to the run-tracker (B2) and the custom-message dispatcher (B3); spawned agents inherit `LLMKERNEL_RUN_TRACE_ID` so MCP tool runs share a trace.

## Public method signatures

```python
class AgentSupervisor:
    def __init__(
        self,
        run_tracker: RunTracker,
        dispatcher: CustomMessageDispatcher,
        litellm_endpoint_url: str,
        kernel_python: str = sys.executable,
        agent_silence_threshold_seconds: float = ...,
        silence_watchdog_granularity_seconds: float = ...,
    ) -> None: ...

    # BSP-002 §4.1 — fresh spawn (idempotent if alive).
    def spawn(
        self, zone_id: str, agent_id: str, task: str, work_dir: Path,
        api_key: Optional[str] = None, model: Optional[str] = None,
        use_bare: bool = False, set_base_url: Optional[bool] = None,
    ) -> AgentHandle: ...

    # RFC-006 §8 v2.0.2 — post-hydrate respawn from config.recoverable.agents[].
    def respawn_from_config(
        self, config_recoverable_agents: list[dict],
    ) -> dict[str, str]: ...   # {agent_id: "spawned" | "skipped" | "failed"}

    # Live-handle accessor.
    def get(self, agent_id: str) -> Optional[AgentHandle]: ...

    # BSP-002 §4.3 — clean shutdown (kernel-wide).
    def terminate_all(self, grace_seconds: float = 10.0) -> None: ...
```

Spec'd but not yet present (BSP-002 §9 K-AS / V2 work):

```python
    def send_user_turn(self, agent_id: str, message: str) -> AgentHandle: ...        # BSP-002 §4.2
    def fork(self, source_agent: str, at_turn_id: Optional[str], new_agent_id: str) -> AgentHandle: ...   # §4.4
    def stop(self, agent_id: str) -> None: ...                                       # §4.3 explicit stop
```

## Invariants

- **Idempotency on `spawn(agent_id=...)` for live agents.** A `/spawn` for an agent_id whose process is still alive returns the existing handle instead of double-spawning. BSP-002 §4.2 treats successive cells as continuations.
- **Provider sticky on the agent.** `provider` is fixed at spawn; `/spawn beta provider:<other>` creates a separate agent (BSP-002 §10 Q5).
- **`claude_session_id` is kernel-owned.** Assigned at spawn (`uuid4()`), passed via `--session-id`. Persists on the `AgentHandle`. BSP-002 §5.
- **Pre-spawn validation (RFC-002).** API key, LLM endpoint reachable, MCP config + system-prompt rendered to 0o600 files, template version validated. Failures raise `PreSpawnValidationError` and emit a synthetic `report_problem`.
- **Per-agent isolation in `respawn_from_config`.** One bad entry MUST NOT block the rest; each spawn is wrapped in its own try-block. Returned status is `"spawned"` | `"skipped"` (already alive) | `"failed"`.
- **Silence watchdog.** Agents that emit no stdout for `agent_silence_threshold_seconds` get SIGTERM; the regular crash-restart machinery picks up the resulting exit. RFC-002 §"Failure modes" Hang row.
- **`PYTHONPATH` is absolutized before passing to the MCP server subprocess** (the agent's `cwd=work_dir`, so relative entries would resolve wrong). See [anti-patterns/path-propagation](../anti-patterns/path-propagation.md).

## K-class error modes (BSP-002 §7)

| Code | Trigger |
|---|---|
| K20 | `@<agent_id>` references unknown agent (live-supervisor lookup miss) |
| K21 | `/branch` source has no head turn |
| K22 | `/revert` target turn not in agent's ancestry |
| K23 | Persistent agent process died unexpectedly mid-turn |
| K24 | `--resume <session_id>` failed |
| K25 | Plain-text cell with no prior agent in the zone |
| K26 | Cross-agent handoff failed |
| K27 | Unknown `provider:<name>` |

## Locking / threading

- `_lock: threading.RLock` — reentrant; protects `_agents` dict. Acquired on the data path; downstream loggers route through `OtlpDataPlaneHandler` → `SocketWriter` (an RLock) so this lock MUST also be reentrant. Engineering Guide §11.7.
- Each agent has reader threads for stdout/stderr (`_read_stdout`, `_read_stderr`) plus a watchdog thread (`_watchdog`).

## Callers

- `vendor/LLMKernel/llm_kernel/_kernel_hooks.py` — constructs the supervisor at kernel startup.
- `vendor/LLMKernel/llm_kernel/custom_messages.py` — `agent_spawn` action_type handler dispatches to `spawn(...)`; `notebook.metadata mode:hydrate` post-hydrate handler calls `respawn_from_config(...)`.
- [contracts/metadata-writer](metadata-writer.md) — receives `update_agent_session` intents reflecting supervisor-observed status changes.

## Code drift vs spec

- **`spawn(...)` does not yet accept the operator's `task` per cell.** It accepts the initial task; mid-turn continuations (`@<agent>: <message>`) are not yet implemented as `send_user_turn` (BSP-002 §4.2 spec'd but missing). The K-AS slice in BSP-002 §9 ratifies the data model now and notes the V1.0/V1.1 boundary.
- **`fork(at_turn_id, ...)` and explicit `stop(agent_id)` are not present.** BSP-002 §4.4 / §4.3 are spec'd; the K-AS slice flagged them as may-slip-to-V2. Today an idle agent only resumes via the silence watchdog → exit → `--resume` path on the next cell.
- **`respawn_from_config` requires a synthetic `task` key inside each entry** (RFC-005's recoverable schema does not carry `task`). The spec acknowledges this as an open issue queued for RFC-005 v2.

## See also

- [agent](../concepts/agent.md) — the data model the supervisor materializes.
- [operations/spawn-agent](../operations/spawn-agent.md) — operator-facing op that triggers `spawn(...)`.
- [contracts/metadata-writer](metadata-writer.md) — receives session-state updates as intents.
- [protocols/family-d-event-log](../protocols/family-d-event-log.md) — the wire that delivers `agent_spawn` action_types.
- [decisions/no-rebind-popen](../decisions/no-rebind-popen.md) — `respawn_from_config` does not rebind to existing PIDs.
