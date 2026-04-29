# Operation: continue-turn

**Status**: V1 shipped (canonical `@@agent <id>` cell-magic form, S5.0 commit `336a6c7` / submodule `e6620db`; legacy `@<id>:` retained as column-0 alias; BSP-002 K-AS slice; `send_user_turn` shipped in S3 / submodule commit `3d43efb`)
**Source specs**: [BSP-002 §3](../../notebook/BSP-002-conversation-graph.md#3-cell-directive-grammar) (directive grammar), [BSP-002 §4.2](../../notebook/BSP-002-conversation-graph.md#42-continuation) (continuation lifecycle), [BSP-002 §4.6](../../notebook/BSP-002-conversation-graph.md#46-cross-agent-context-handoff) (cross-agent handoff), [PLAN-S5.0-cell-magic-vocabulary.md §3.3](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#33-cell_magics-registry--vendorllmkernelllm_kernelmagic_registrypy-new-150-loc) (`@@agent` registry entry), [PLAN-S5.0-cell-magic-vocabulary.md §3.9](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#39-legacy-compat--same-parser) (legacy alias)
**Related atoms**: [agent](../concepts/agent.md), [turn](../concepts/turn.md), [magic](../concepts/magic.md), [spawn-agent](spawn-agent.md), [stop-agent](stop-agent.md)

## Definition

A cell whose first non-blank line is `@@agent <agent_id>` (or a plain-prose cell with no `@@<magic>` declaration when at least one agent already exists) appends one operator [turn](../concepts/turn.md) targeting the named [agent](../concepts/agent.md), receives the agent's response as the next turn, and advances the agent's `head_turn_id`. If other agents have contributed turns since this agent's `last_seen_turn_id`, the kernel performs a **cross-agent context handoff** before sending the body.

## Operation signature

Canonical cell-magic form (S5.0):

```
@@agent <agent_id>
<message body — joined verbatim>
```

Plain-prose cell (no `@@<magic>` line; targets the cell's `bound_agent_id` or the most-recent agent in the zone):

```
<message body>
```

Legacy column-0 alias:

```
@<agent_id>: <message body first line>
<continued body lines if any>
```

## Legacy `@<id>:` shorthand

Per [PLAN-S5.0 §3.9](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#39-legacy-compat--same-parser) the legacy single-line shorthand `@alpha: hello world` is rewritten to canonical magic form by `cell_text.rewrite_legacy_directives` *before* parsing. The rewrite is **first-line-only**:

- The first non-blank line must match `^@<id>\s*:\s*<rest>` (anchored at column 0).
- The rewrite produces a two-line head: `@@agent <id>` then `<rest>` (the post-colon body of the first line).
- All subsequent body lines are preserved verbatim under the head; they are not re-scanned for legacy patterns.
- The parser sets `ParsedCell.legacy_alias_used = True` so round-trip emission can preserve the operator's original text on save.

A column-0 `@user@example.com` mid-cell (after a body line) is **not** rewritten — only the first non-blank line is scanned, and the parser classifies unknown line magics in body position as body verbatim.

Kernel envelope:

```jsonc
{
  type: "operator.action",
  payload: {
    action_type: "agent_continue",
    parameters: {
      agent_id: "alpha",
      message: "<body>",
      cell_id: "<cell-uri>"
    }
  }
}
```

## Invariants / Preconditions

- `agent_id` MUST resolve to an existing agent in the zone, else **K20** (`cell_directive_unknown_agent`).
- A plain-text cell with no prior agent in the zone raises **K25** (`cell_directive_no_agent_in_zone`); use [spawn-agent](spawn-agent.md) first.
- The handoff rule (BSP-002 §4.6): for every turn `t` where `t` is after `agent.last_seen_turn_id` on the notebook's mainline, the kernel feeds `t` to the agent's claude session as a synthesized prefix message before sending the new operator `<message>`. The handoff messages are **not separate turns in the DAG** — they are transient context injection. Replay is deterministic.
- If the agent's process is `idle`, the kernel re-spawns it via `claude --resume <claude_session_id>` first. If `exited`, full transcript replay rebuilds the session.
- After commit: agent's `head_turn_id = last_seen_turn_id =` the new response turn id.
- Handoff messages are NOT text-tagged (BSP-002 §6 Issue 3 resolution). The cell-as-agent-identity decoration is the attribution surface.
- Re-running a cell produces a NEW turn (new `id`); the previous turn stays in the DAG but is no longer this cell's `cell_id` target.

## V1 vs V2+

- **V1**: linear continuation; same `claude_session_id` across many turns; handoff via stdin replay.
- **V2+**: branch-aware continuation UX (rendering side-branches inline), plus partial-handoff strategies when `missed_turn_count` would exceed budget.

## See also

- [spawn-agent](spawn-agent.md) — how the agent first comes into existence.
- [stop-agent](stop-agent.md) — clean shutdown; the next continue-turn auto-resumes.
- [revert-agent](revert-agent.md) — moves head backward; subsequent continues build from the new head.
- [agent](../concepts/agent.md) — the ref this operation advances.
- [turn](../concepts/turn.md) — the unit produced.
