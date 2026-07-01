# Agent

**Status**: V1 shipped (the `claude-code` provider; persistent lifecycle; `/spawn`, `@<agent>:`, `/stop` directives; cell-decoration rendering of agent identity is live on the X-EXT side, S1 / commit `26ac581` — `/branch` and `/revert` are V1 spec'd, may slip to V2)
**Source specs**: [BSP-002 §2.2](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#22-agent), [BSP-002 §4](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#4-persistent-agent-lifecycle), [BSP-002 §6](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity) (cell-as-agent-identity), [KB-notebook-target.md §10](../../../03%20-%20Blueprint/KB-notebook-target.md#10-agents-as-executors)
**Related atoms**: [turn](turn.md), [zone](zone.md), [cell](cell.md), [run-frame](run-frame.md)

## Definition

An **agent** is a named, mutable ref pointing into the [turn](turn.md) DAG, plus the runtime state of the underlying executor process (claude-code in V1). Like a git branch ref: `head_turn_id` is mutable; moving it backward IS the revert operation; forking it IS the branch operation. Agents are per-[zone](zone.md) — all agent refs live within one notebook; there is no notion of "agent alpha across notebooks." Agents are **registered semantic executors**, not ambient intelligence: each agent has an id, a provider, a session, a runtime status, and a head pointing at one specific turn in the zone's DAG.

## Schema

The per-agent dict at `metadata.rts.zone.agents.<id>` has two members: `turns[]` (the agent's contributions to the turn DAG; each record carries its own `provider`, `claude_session_id`, `cell_id`, `created_at`) and `session` (the mutable agent ref + runtime state). The agent's `id` is the dict key, not a duplicated field.

```jsonc
// metadata.rts.zone.agents.<id>
{
  "turns": [
    {
      "id":                "t_01HZX7K3...",        // immutable turn id
      "parent_id":         "t_01HZW...",           // null on first turn
      "agent_id":          "alpha",
      "claude_session_id": "9d4f-...",             // session that produced this turn
      "role":              "user" | "assistant",
      "body":              "...",
      "spans":             [],                     // OTLP spans for assistant turns
      "cell_id":           "vscode-notebook-cell:.../#abc",
      "created_at":        "...",
      "provider":          "claude-code"           // V1: only claude-code
    }
  ],
  "session": {
    "head_turn_id":       "t_01HZX7K3...",         // mutable — the git-branch-ref pointer
    "last_seen_turn_id":  "t_01HZX7K3...",         // most recent turn this session has been fed
    "claude_session_id":  "9d4f-...",              // current bound session; changes on /branch or /revert
    "runtime_status":     "alive | idle | exited | terminated",
    "pid":                32856,                   // null when idle/exited/terminated
    "fork_case":          "A" | "B"                // optional; present after /branch
  }
}
```

The `provider` lives on each turn record (so the per-cell badge can render the correct provider for the turn that produced the cell). Cross-agent ergonomics like `work_dir`, `model`, and the spawn `created_at` are out of scope for V1's persisted state — they live in the in-process `AgentSupervisor` registry, not in `metadata.rts`.

`runtime_status`:
- `alive` — process running, accepting turns over stdin.
- `idle` — process exited gracefully; resumable via `claude --resume <claude_session_id>`.
- `exited` — process exited and cannot be resumed; the conversation rebuilds from turn replay if re-engaged.
- `terminated` — process killed (SIGTERM via `/stop` or supervisor lifecycle); like `exited` but distinguishes "operator asked us to quit" from "process died on its own".

**Note on `interrupting`**: the S9-kernel `AgentSupervisor.interrupt(agent_id)` (submodule commit `87cb127`) sends SIGINT to a live process so claude aborts its current generation; the process stays alive for the next turn. The kernel's enum stays at `alive | idle | exited` — `interrupting` is **extension-side optimistic-UI state**: when the X-EXT cell-toolbar interrupt button fires, the badge shows "interrupting…" until the next `alive`-state span confirms the abort completed. The kernel never persists `interrupting` to `metadata.rts.zone.agents.<id>.session.runtime_status`.

**Registry-miss defaults** (pre-S2 hydrate path / agent metadata not yet in the registry):
- `runtime_status` defaults to `"idle"` — the operator-recognisable "ran here, currently quiet" state. Until the S2 hydrate path lands the agent metadata, this is what the cell-decoration badge renders.
- `provider` defaults to `"claude-code"` — V1's only-provider rule (BSP-002 §10 Q5); the badge therefore always names a valid provider even before the registry is populated.

## Invariants

- **`head_turn_id` is mutable; the [turn](turn.md) it points at is immutable.** Moving the head is how revert works. Turns are never deleted.
- **`claude_session_id` is owned by the kernel.** Each agent gets a session at spawn or fork; reverts assign a NEW session at the next continuation. Pre-revert turns keep their original `claude_session_id`; new turns get the new session id. This is why `claude_session_id` lives on the [turn](turn.md), not (only) on the agent.
- **Per-[zone](zone.md).** One agent ref lives in exactly one notebook's `metadata.rts.zone.agents`. Cross-notebook agents do not exist in V1.
- **`last_seen_turn_id` may lag `head_turn_id`.** If another agent contributed turns in the same zone, this agent's session has not seen them; the kernel performs a cross-agent context handoff ([BSP-002 §4.6](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#46-cross-agent-context-handoff)) before the next continuation.
- **Cell-as-agent-identity.** A [cell](cell.md) of `kind: "agent"` carries `bound_agent_id`; the cell renders a decoration showing `agent_id` + `provider` + `runtime_status` ([BSP-002 §6](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#6-cell--turn-binding-and-cell-as-agent-identity)). The notebook itself is the attribution surface — handoff messages are NOT text-tagged because the operator can SEE which cells produced which turns.
- **Idle agents survive notebook close → reopen.** `runtime_status: "idle"` + `claude_session_id` round-trip through `metadata.rts`. Re-engaging spawns `claude --resume <session>`.
- **Provider is sticky** ([BSP-002 §10](../../../03%20-%20Blueprint/BSP-002-conversation-graph.md#10-open-questions) Q5 recommendation). `/spawn beta provider:<other>` creates a separate agent; switching mid-conversation is a footgun.
- **Hydrated agents default to `runtime_status: "idle"`.** When `MetadataWriter.hydrate(...)` restores an agent record on file open, the runtime status is forced to `"idle"` regardless of what was persisted; the supervisor's post-hydrate respawn discipline (see [decisions/no-rebind-popen](../decisions/no-rebind-popen.md)) decides whether to resume the process or leave it dormant. This is why a `.llmnb` saved with `runtime_status: "alive"` still opens cold — the process didn't survive the file close.
- **`provider` defaults to `"claude-code"` when omitted.** V1 supports only `claude-code`; envelope omission on the wire is treated as the default rather than a wire failure. V2+ callers passing an unknown `provider` value get K-class rejection at the supervisor rather than silent coercion.

## V1 vs V2+

- **V1**: providers limited to `claude-code`; persistent lifecycle (spawn → stays alive → accepts turns via stdin → idle exit on timeout or `/stop`); idle resume via `--resume`; `/branch` and `/revert` data-model ratified.
- **V2 (2026-05-20 partial-ship)**: branch-switching UX — the S7 Agents sidebar now renders a "Branches" subnode under any agent that has forked descendants (lineage recovered from `metadata.rts.zone.event_log[*]` `fork_agent` envelopes; see [PLAN-V2-branch-switching-ux](../../../07%20-%20Status%20Reports/PLAN-V2-branch-switching-ux.md)). Clicking a branch row reveals that branch agent's first cell. Additional providers (`gpt-cli`, `gemini`, `ollama`) and richer Inspect-mode session lineage remain queued.

## See also

- [turn](turn.md) — the DAG the agent points into.
- [zone](zone.md) — the per-notebook scope.
- [cell](cell.md) — `bound_agent_id` makes the cell visibly attribute to one agent.
- [run-frame](run-frame.md) — `executor_id` matches `agent.id`.
- [discipline/immutability-vs-mutability](../discipline/immutability-vs-mutability.md) — agent ref mutable, turn DAG immutable.
- [driver](driver.md) — distinct concept: a peer-of-extension client that drives the kernel via wire, not an in-notebook executor.
