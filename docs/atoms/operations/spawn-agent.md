# Operation: spawn-agent

**Status**: V1 shipped (canonical `@@spawn` cell-magic form, S5.0 commit `336a6c7` / submodule `e6620db`; legacy `/spawn` retained as column-0 alias; BSP-002 K-AS slice; resume path wired via S2 / submodule commit `7e65d9b`)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.1](../../notebook/BSP-002-conversation-graph.md#41-spawn) (spawn lifecycle), [BSP-002 §2.2](../../notebook/BSP-002-conversation-graph.md#22-agent) (agent ref schema), [PLAN-S5.0-cell-magic-vocabulary.md §3.3](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#33-cell_magics-registry--vendorllmkernelllm_kernelmagic_registrypy-new-150-loc) (`@@spawn` registry entry), [PLAN-S5.0-cell-magic-vocabulary.md §3.9](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#39-legacy-compat--same-parser) (legacy alias)
**Related atoms**: [agent](../concepts/agent.md), [turn](../concepts/turn.md), [zone](../concepts/zone.md), [magic](../concepts/magic.md), [continue-turn](continue-turn.md), [stop-agent](stop-agent.md)

## Definition

`@@spawn <agent_id> [endpoint:<name>] [provider:<name>] task:"<initial task>"` is the cell magic that creates a new [agent](../concepts/agent.md) ref inside the current [zone](../concepts/zone.md) and starts the chosen provider's process (default `claude-code`). The first [turn](../concepts/turn.md) for the spawning cell is the operator turn carrying the task; the agent's first response is the next turn. The agent process stays alive after the response — it is not a one-shot like the legacy V0 model.

## Operation signature

Canonical cell-magic form (S5.0):

```
@@spawn <agent_id> [endpoint:<name>] [provider:<name>] task:"<initial task>"
(optional body — extends task)
```

Legacy column-0 alias (still recognized):

```
/spawn <agent_id> [provider:<name>] task:"<initial task>"
```

The legacy form is rewritten to the canonical magic form by `cell_text.rewrite_legacy_directives` *before* parse, per [PLAN-S5.0 §3.9](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#39-legacy-compat--same-parser); the `ParsedCell.legacy_alias_used` flag is set so round-trip emission can preserve the operator's original text on save.

Kernel-side action envelope (per BSP-002 §9):

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_continue",   // spawn is a sub-form
    intent_kind: "spawn_agent",
    parameters: {
      agent_id: "alpha",
      provider: "claude-code",       // sticky on agent (BSP-002 §10 Q5)
      task: "<initial body>",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `agent_id` MUST be unique within the zone. Re-spawning an existing id is not allowed; use [continue-turn](continue-turn.md) instead.
- `provider` is **sticky on the agent** (BSP-002 §10 Q5). The spawn-time provider is fixed for that agent's lifetime; switching providers means a fresh `/spawn` of a different agent.
- The new agent's claude session is initialized with the **zone's full turn prefix** as context — every prior turn in the notebook is replayed into the new session before the task runs. This is the shared-notebook axiom in BSP-002 §1.
- On success: a new entry under `metadata.rts.zone.agents.<id>.session` with `runtime_status: "alive"`, fresh `claude_session_id` (new UUID), and `head_turn_id` pointing at the spawn cell's first emitted turn.
- The cell's `bound_agent_id` is set to the new `agent_id` (BSP-002 §6 cell-as-agent-identity).
- An unknown `provider:<name>` raises **K27** (`cell_directive_unknown_provider`); V1 supports `claude-code` only.

## V1 vs V2+

- **V1**: provider is `claude-code`. Process spawned with `claude --session-id=<new-uuid> --output-format=stream-json --input-format=stream-json --replay-user-messages [--bare] [--model …]`. Stays alive across turns.
- **V2+**: additional providers (`gpt-cli`, `gemini`, `ollama`); spawn-time capability declarations (per [decisions/capabilities-deferred-v2](../decisions/capabilities-deferred-v2.md)).

## See also

- [continue-turn](continue-turn.md) — the immediate next op once an agent exists.
- [stop-agent](stop-agent.md) — clean shutdown that leaves the agent resumable.
- [branch-agent](branch-agent.md) — fork an existing agent into a new id.
- [agent](../concepts/agent.md) — the entity being created.
- [zone](../concepts/zone.md) — the scope all agents live in.
- [discipline/cell-manager-owns-structure](../discipline/cell-manager-owns-structure.md) — spawn binds the cell to an agent through Cell Manager.
