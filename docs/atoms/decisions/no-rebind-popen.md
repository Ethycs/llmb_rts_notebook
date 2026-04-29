# Decision: respawn_from_config does not rebind to live PIDs

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [BSP-002 §4 (idle exit + resume)](../../notebook/BSP-002-conversation-graph.md#43-idle-exit), [BSP-002 §2.2 (agent ref schema)](../../notebook/BSP-002-conversation-graph.md#22-agent), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/agent](../concepts/agent.md), [operations/spawn-agent](../operations/spawn-agent.md), [operations/continue-turn](../operations/continue-turn.md)

## The decision

**`AgentSupervisor.respawn_from_config` re-spawns claude-code processes from `claude_session_id` via `--resume`. It NEVER rebinds to a live PID.** Per [BSP-002 §4](../../notebook/BSP-002-conversation-graph.md#43-idle-exit) and the agent schema in [BSP-002 §2.2](../../notebook/BSP-002-conversation-graph.md#22-agent):

- Agent state stored on close: `claude_session_id` (durable), `runtime_status: idle | exited` (durable), `pid` (volatile — no longer trusted).
- On reopen: extension ships `notebook.metadata mode:"hydrate"` with `metadata.rts.config.recoverable.agents[]`; kernel calls `AgentSupervisor.respawn_from_config(snapshot.config.recoverable.agents[])`; supervisor re-spawns each agent with `claude --resume <claude_session_id>`.
- The `pid` field on the agent ref refers to the previous process; on reopen it is replaced by the new PID. The kernel does NOT attempt to attach to or signal the old PID.

PIDs are volatile across kernel restarts. Sessions are durable.

## Rationale

1. **PIDs don't survive kernel restart.** When the operator closes the notebook, the kernel exits, claude exits, the OS reaps both. The PID number may be reused by an unrelated process by the time the notebook reopens. Attempting to signal or attach to a stored PID is undefined behavior at best, dangerous at worst (signal a stranger's process).

2. **Sessions DO survive.** claude-code stores its conversation state under its session UUID independently of the process. `--resume <session_id>` re-attaches a new process to the same conversation. This is what makes idle agents (BSP-002 §4.3) survive an idle-timeout exit and a notebook reopen alike.

3. **`runtime_status: idle` vs `exited` is the durability signal.** Per [BSP-002 §4.3](../../notebook/BSP-002-conversation-graph.md#43-idle-exit): `idle` means clean shutdown, conversation resumable via `--resume`; `exited` means the process exited unrecoverably and the conversation must be rebuilt from turn replay. The kernel reads this status, not the PID, to decide the resume path.

4. **K24 covers the resume-failed case.** Per [BSP-002 §7](../../notebook/BSP-002-conversation-graph.md#7-failure-modes-k-class-numbering-continued-from-bsp-001-k11k13): `--resume <session_id>` may fail if claude's local cache expired the session. The kernel then falls back to full transcript replay (Case B mechanics from §4.4). Operator action is none — the fallback is automatic.

5. **Per [Engineering Guide §6 recoverable vs volatile](../../../Engineering_Guide.md#6-recoverable-vs-volatile-state)**: PID is the canonical example of volatile state. RFC-005 §"`metadata.rts.config`" structurally splits `config.recoverable.agents[]` (durable session info) from `config.volatile.agents[]` (PIDs, current statuses). `respawn_from_config` reads the recoverable side ONLY.

## Operational consequences

| Reopen sub-step | Behavior |
|---|---|
| Extension ships hydrate envelope | `metadata.rts.config.recoverable.agents[]` carries `claude_session_id`, `runtime_status`, `model` per agent |
| Kernel calls `AgentSupervisor.respawn_from_config` | Reads the recoverable agents list |
| For each `runtime_status: "idle"` agent | Spawn `claude --resume <claude_session_id>`. Replace `pid` in metadata with the new PID. |
| For each `runtime_status: "exited"` agent | Do NOT respawn yet. Leave the agent in `exited` state. Next `@<agent>:` will trigger full transcript replay (Case B from BSP-002 §4.4). |
| For each `runtime_status: "alive"` agent in the snapshot | Treat as `idle` — the snapshot was taken before clean shutdown but the process is gone. Resume the same way. |
| If `--resume` fails | Fall back to full transcript replay; emit K24 marker; assign a new `claude_session_id` |
| The old PID in the snapshot | Discarded. Never signaled. Never `os.kill`'d. Never attached to. |

## V1 vs V2+

- **V1**: as above. Single-operator, single-machine. PIDs are local to one process tree.
- **V2+**: same shape; multi-operator scenarios still rely on `claude_session_id` as the durable handle. The PID concept becomes even less meaningful when the agent might run in a different process tree (e.g., remote kernel).
- **V3+**: fleet kernels may have agents spawned on different hosts. PIDs are obviously irrelevant cross-host; only sessions are.

## See also

- [concepts/agent](../concepts/agent.md) — the agent ref schema (`claude_session_id`, `runtime_status`, `pid`).
- [operations/spawn-agent](../operations/spawn-agent.md) — initial spawn vs resume.
- [operations/continue-turn](../operations/continue-turn.md) — `@<agent>:` triggers respawn if idle/exited.
- [BSP-002 §4](../../notebook/BSP-002-conversation-graph.md#4-persistent-agent-lifecycle) — idle-exit + resume mechanics.
- [BSP-002 §7](../../notebook/BSP-002-conversation-graph.md#7-failure-modes-k-class-numbering-continued-from-bsp-001-k11k13) — K23, K24 failure modes.
- [Engineering Guide §6](../../../Engineering_Guide.md#6-recoverable-vs-volatile-state) — recoverable vs volatile state principle.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
