# Plan: S4 — Cross-agent context handoff

**Status**: ready (refresh after S5.0/S5.0.1/S5.0.3)
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: thread `last_seen_turn_id` through `AgentHandle` and `send_user_turn`, walk the turn DAG between an agent's last-seen point and the notebook head, and inject missed turns from other agents into the addressed agent's session before the operator's new message reaches it.
**Time budget**: ~0.6 days. `send_user_turn` is already shipped (S3 / submodule commit `3d43efb`); `last_seen_turn_id` and `_missed_turns` are NOT present. The remaining work is the DAG walker, synthesis prefix, hash-strip discipline, and K26 plumbing. Single-agent.

---

## §1. Why this work exists

After S3, an operator can keep a conversation going with one agent. After S3.5, each turn has a deterministic context manifest. But in a notebook with cells targeting alpha, beta, gamma, when the operator sends `@@agent alpha` after beta has produced 3 turns, alpha's claude session has not seen any of beta's output. Currently the operator must manually paste beta's responses into alpha's prompt — an unbearable failure of the multi-agent vision.

S4 fixes this. The kernel walks the turn DAG between `agent.last_seen_turn_id` and the notebook's current head, generates synthesis messages for each missed turn ("Beta replied: …"), strips any hashed-magic syntax from those messages, and injects them into alpha's session over stdin before the operator's `<message>` is sent. After alpha responds, `last_seen_turn_id` advances to the new turn.

Driver: [BSP-002 §4.6](BSP-002-conversation-graph.md). Slice spec: [BSP-005 §"S4"](BSP-005-cell-roadmap.md). Atom: [continue-turn](../atoms/operations/continue-turn.md) §"Invariants / Preconditions" — the handoff rule already specifies the desired semantics.

## §2. Goals and non-goals

### Goals

- `AgentHandle` carries `last_seen_turn_id: str | None` across spawn / resume / handoff.
- `send_user_turn(agent_id, message)` walks `last_seen_turn_id → notebook_head`, synthesizes prefix messages for each missed turn, hash-strips all prefix lines, and injects them before the operator message.
- Handoff messages are NOT separate turns in the DAG (they are transient context injection per [continue-turn](../atoms/operations/continue-turn.md)).
- After a successful turn, `last_seen_turn_id == head_turn_id`.
- Determinism: replay produces equivalent injected context for the same DAG state.
- K26 (`cross_agent_handoff_failed`) registered and plumbed.

### Non-goals

- Partial-handoff strategies (drop oldest, summarize) when `missed_turn_count` exceeds budget. V2+ per [continue-turn](../atoms/operations/continue-turn.md) §"V1 vs V2+".
- Cell rendering of `[handoff]` markers — handoff messages stay invisible per [BSP-002 §6 Issue 3](BSP-002-conversation-graph.md).
- `/branch` or `/revert` — those land in [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md).
- Changes to the `agent_continue` wire format.

## §2.5. V1 vs V2+ — explicit handoff

**V1 ships only automatic-on-`@@agent` handoff.** When the operator addresses an agent with `@@agent <id>` (canonical cell-magic per [PLAN-S5.0](PLAN-S5.0-cell-magic-vocabulary.md), with the cell body as the message) — or with the legacy `@<id>: <body>` column-0 directive (preserved indefinitely; rewrites internally to `@@agent <id>\n<body>` per S5.0 line 176) — the kernel performs the handoff automatically if that agent has missed sibling turns. No operator-authored explicit directive is required or supported.

**V2+ feature: `@handoff <to_id>` line-magic.** When appended to a cell, the kernel records "after this cell completes, the operator's next un-targeted message routes to `<to_id>`." Stack-style: nested `@handoff` builds a degrade-stack; `@handoff` with no arg pops one frame. This is a control-flow side-effect that persists between cells — visible only in the emitting cell's text, not in the destination cell.

**V2+ feature: `@affinity <endpoint_name>`.** Per-cell or per-zone routing config the operator requested during S5.0 design. Deferred.

**Why both are V2+:** the [visible-tile constraint](../atoms/discipline/zachtronics.md) requires that every control-flow change be visible in cell text. A `@handoff` stack crossing cells creates routing state that is invisible in the cells it affects. V2+ does the UI work to surface the stack (e.g., a notebook-header "current route" chip). V1 keeps automatic-on-`@@agent` only, which is stateless per-cell.

## §3. Concrete work

1. **Schema extension on `AgentHandle`.** Add `last_seen_turn_id: Optional[str]` to the dataclass in `vendor/LLMKernel/llm_kernel/agent_supervisor.py`. Default `None` for fresh spawns; populated to the spawn's first response turn id. (`claude_session_id` and resume logic already shipped — `--resume` exists; this slice only adds the additive `last_seen_turn_id` field plus the walker that consumes it.)

2. **Persistence.** Mirror `last_seen_turn_id` into `metadata.rts.zone.agents.<id>.session.last_seen_turn_id` per [agent atom schema](../atoms/concepts/agent.md). The field already exists in the atom schema; this slice wires it via the existing `update_agent_session` intent kind in [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md).

3. **Turn-DAG walker.** New private helper `AgentSupervisor._missed_turns(agent_id, head_turn_id) → list[Turn]`:
   - Read `metadata.rts.zone.agents.<*>.turns[]` for ALL agents in the zone (cross-agent walk).
   - Construct the chain from `head_turn_id` backward via `parent_id` until `agent.last_seen_turn_id` is reached.
   - Filter to turns NOT authored by `agent_id` (handoff candidates).
   - Return chronologically ordered (root → head). Max-depth guard raises K26 with `reason: "cycle_detected"` defensively.

4. **Synthesis prefix.** New private helper `_synthesize_handoff_prefix(turns) → list[str]`:
   - One JSON-line per missed turn in `claude` stream-json input format: `{"type":"user","message":{"role":"user","content":"<role> <agent_id> said: <body>"}}`.
   - Exact wording pinned in code for determinism; test asserts exact string.

5. **Hash-strip in synthesis prefix.** Per [S5.0.1 §3.4](PLAN-S5.0.1-cell-magic-injection-defense.md): before writing ANY prefix line to an agent's stdin, run every synthesized content string through `magic_hash.strip_hashes_from_text(...)`. Agents MUST NOT observe `@@<hash>:<name>` patterns — they cannot compute valid HMACs (pin is not in their context), and echoing them verbatim would re-trigger the emission-ban escape on the output path. Strip happens in `_synthesize_handoff_prefix` before the caller writes lines.

6. **`send_user_turn` delta** (`send_user_turn` already shipped in S3 per [contracts/agent-supervisor](../atoms/contracts/agent-supervisor.md); this extends it):
   ```python
   def send_user_turn(self, agent_id: str, message: str) -> AgentHandle:
       handle = self._agents[agent_id]                 # K20 if missing
       head = self._notebook_head_turn_id()
       missed = self._missed_turns(agent_id, head)
       prefix_lines = self._synthesize_handoff_prefix(missed)
       # prefix_lines already hash-stripped (§3 step 5)
       for line in prefix_lines:
           handle.stdin.write(line + "\n")
       handle.stdin.write(json.dumps({...operator message...}) + "\n")
       handle.stdin.flush()
       handle.last_seen_turn_id = head
       self._writer.submit_intent({...update_agent_session...})
       return handle
   ```

7. **Hydrate path.** On notebook reopen, `MetadataWriter.hydrate(snapshot)` restores `last_seen_turn_id` per agent. Agents whose `last_seen_turn_id` lags the snapshot head simply trigger a handoff on the next `@@agent` cell — no migration needed.

8. **K26 plumbing.** K26 (`cross_agent_handoff_failed`) is not yet registered in `_rfc_schemas.py` or `wire/tools.py`. This slice registers it. The supervisor catches exceptions during prefix write; agent is left in an indeterminate session state. Surfaced as a `report_problem` synthetic span on the cell. Existing K20, K23, K24 propagate unchanged.

## §4. Interface contracts

`AgentSupervisor` — existing `send_user_turn` signature is unchanged; the method's internal behavior grows the handoff-prefix logic:

```python
def send_user_turn(self, agent_id: str, message: str, cell_id: Optional[str] = None) -> AgentHandle:
    """Append one operator turn after replaying missed turns from siblings.
    Returns the same AgentHandle (lifecycle preserved). Raises K20/K23/K24/K26.
    """
```

Wire envelope (already shipped in S3 per [protocols/operator-action](../atoms/protocols/operator-action.md)):

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type": "agent_continue",
    "parameters": { "agent_id": "alpha", "message": "<body>", "cell_id": "<cell-uri>" }
  }
}
```

**No wire change for S4.** The handoff is purely kernel-side enrichment of the existing `agent_continue` semantics. Drivers — including `llm_client.executor` introduced in S5.0.3 — consume the same Family-A `agent_continue` envelope; the handoff prefix is invisible on the wire. See §"Driver invariance" below.

The `update_agent_session` intent grows a `last_seen_turn_id` field:

```jsonc
{
  "intent_kind": "update_agent_session",
  "parameters": {
    "agent_id": "alpha",
    "head_turn_id": "t_...",
    "last_seen_turn_id": "t_..."
  }
}
```

### Driver invariance

S5.0.3's `llm_client` driver consumes the same `agent_continue` operator-action envelope (Family A). The handoff mechanic is purely kernel-side enrichment of the existing wire: the driver ships an `agent_continue` envelope; the kernel decides — based on `last_seen_turn_id` — whether to prepend synthesized prefix turns before the user message reaches the agent process. Drivers (VS Code extension, `llmnb execute` CLI, future Rust/Go clients) need no changes for S4. The §4 wire envelope description is correct against the post-S5.0.3 wire surface.

## §5. Test surface

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_send_user_turn_no_missed_turns` — single agent, no handoff prefix, message goes straight through.
- `test_send_user_turn_with_one_missed_sibling_turn` — two agents, beta produced 1 turn; `@@agent alpha` injects 1 prefix line then operator message.
- `test_send_user_turn_with_three_missed_sibling_turns` — chronological order preserved; exact prefix strings asserted.
- `test_send_user_turn_unknown_agent_raises_k20` — supervisor lookup miss.
- `test_send_user_turn_dead_agent_resumes_first` — idle agent → resume → handoff → message.
- `test_send_user_turn_advances_last_seen_turn_id` — after success, `last_seen_turn_id == head_turn_id`.
- `test_send_user_turn_handoff_failure_raises_k26` — stdin write fails mid-handoff.
- `test_send_user_turn_persists_last_seen_via_writer` — `update_agent_session` intent submitted with new field.
- `test_send_user_turn_strips_hashes_in_handoff_prefix` — sibling turn body contains `@@<hash>:spawn`; prefix delivered to agent contains `@@spawn` (plain, non-dispatchable form); emission ban not triggered.

In `vendor/LLMKernel/tests/test_hydrate.py`:

- `test_hydrate_restores_last_seen_turn_id_per_agent`.
- `test_handoff_after_hydrate_replays_correctly`.

Expected count: 9 supervisor tests + 2 hydrate tests = 11 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Missed-turn count grows unbounded in long notebooks | V1 emits all missed turns per [continue-turn V1 vs V2+](../atoms/operations/continue-turn.md); V2 layers a budget. Walker terminates at `last_seen_turn_id`. |
| Synthesis wording drifts between runs | Pin the prefix template literal in code; test asserts exact string. |
| stdin write race with agent's own response stream | Reader is on stdout; stdin writes serialized through `_lock` per [contracts/agent-supervisor §"Locking / threading"](../atoms/contracts/agent-supervisor.md). |
| Cycle in turn DAG | Walker has max-depth guard; exceeding it raises K26 with `reason: "cycle_detected"`. |
| `metadata.rts.zone` head_turn_id stale during fast cell sequence | `_notebook_head_turn_id()` reads writer's in-memory snapshot under `_lock`; FIFO serialization keeps it consistent. |
| Sibling agent's prior turn contains hashed-magic | Mitigated by mandatory `magic_hash.strip_hashes_from_text(...)` invocation in `_synthesize_handoff_prefix`. Agents never observe `@@<hash>:<name>` patterns. |

## §7. Atoms touched + Atom Status fields needing update

- [concepts/agent.md](../atoms/concepts/agent.md) — `last_seen_turn_id` field is already in the schema; this slice actively maintains it.
- [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) — `send_user_turn` already in "Public method signatures" (S3); note that S4 extends its internal semantics.
- [operations/continue-turn.md](../atoms/operations/continue-turn.md) — Status `V1 shipped`; cross-agent handoff invariant is now enforced (was aspirational before S4).
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — `update_agent_session` parameter shape verified consistent with the new field.
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — verify the `update_agent_session` handler accepts `last_seen_turn_id`.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 5](PLAN-v1-roadmap.md) — the ship-ready bullet this flips.
- [PLAN-S3.5-context-packer.md](PLAN-S3.5-context-packer.md) — manifest replay overlap; S4 reuses the deterministic walk for handoff content.
- [PLAN-S5.0-cell-magic-vocabulary.md](PLAN-S5.0-cell-magic-vocabulary.md) — operator surface that triggers `send_user_turn`; `@@agent <id>` canonical form; `@msg <id>: <body>` line-magic shorthand.
- [PLAN-S5.0.1-cell-magic-injection-defense.md §3.4 + §3.10](PLAN-S5.0.1-cell-magic-injection-defense.md) — bidirectional hash-strip discipline that governs prefix synthesis; K3D contaminated-cell freeze.
- [PLAN-S5.0.3-driver-extraction-and-external-runnability.md §9](PLAN-S5.0.3-driver-extraction-and-external-runnability.md) — confirms driver consumes wire only; handoff stays kernel-side.
- [PLAN-S5-branch-revert-stop.md](PLAN-S5-branch-revert-stop.md) — both slices need the turn DAG materialized at `metadata.rts.zone.agents.<id>.turns[]`.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrames record `turn_head_before` / `turn_head_after`; the handoff sets these correctly.

## §9. Definition of done

- [ ] All 11 new tests pass.
- [ ] `AgentHandle.last_seen_turn_id` field present; default `None`.
- [ ] `_missed_turns` walker present and covered by tests.
- [ ] `_synthesize_handoff_prefix` calls `strip_hashes_from_text` on every content string before returning.
- [ ] K26 registered in `_rfc_schemas.py` or `wire/tools.py`.
- [ ] Two-agent end-to-end smoke: spawn alpha + beta, run two turns on beta, then `@@agent alpha` — alpha's response references beta's content, confirming handoff fired.
- [ ] Three-agent stress smoke: 5 turns each on alpha, beta, gamma in alternating order; verify each `last_seen_turn_id` advances correctly across the writer state.
- [ ] Idle-resume + handoff smoke: terminate alpha, send `@@agent alpha` after beta has produced 2 turns; alpha resumes, handoff fires, response correct.
- [ ] [contracts/agent-supervisor.md](../atoms/contracts/agent-supervisor.md) updated to note S4 extends `send_user_turn`.
- [ ] BSP-005 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
