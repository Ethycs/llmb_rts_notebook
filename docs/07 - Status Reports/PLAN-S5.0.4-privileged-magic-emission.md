# Plan: S5.0.4 — Privileged magic emission + stream promotion

**Status**: queued (scope locked by [discipline/certified-magic-emitter](../04%20-%20Reference/atoms/discipline/certified-magic-emitter.md); implementation not started)
**Audience**: an LLM (or operator) picking this up cold. Self-contained once S5.0/S5.0.1/S5.0.2 are read.
**Goal**: ratify the six surfaces the certified-magic-emitter atom forward-references — the structural channel by which an operator can grant a *specific* agent the right to produce dispatchable magic, plus the stream-promotion recovery path for LLMs that emit magic via stdout instead of invoking the tool. Preserves every clause of the certified-magic-emitter standard: stream stays banned, channel is structural, operator is the certifying intent.
**Time budget**: ~2 days. Single cross-layer agent (kernel + extension + wire schemas + 4 atoms). Depends on S5.0.1 (hash mode + sanitizer + Cell Manager gates) and S5.0.2 (`insert_cells_with_provenance` + `generated_by` provenance) being landed. Both are in.

---

## §1. Why this work exists

S5.0.1 closes the agent-stream attack surface: agents cannot emit dispatchable magic through stdout, regardless of operator trust or model identity. S5.0.2 carves out one legitimate exception — magic code generators run in operator privilege from operator-typed `@@template` / `@@expand` / `@@import` cells.

S5.0.4 carves out the second legitimate exception: **a specific agent, granted explicit operator privilege, can invoke a kernel-side MCP tool that produces a new cell on the operator's behalf**. The agent does not type magic; it invokes `emit_magic_cell(name, args, …)` via JSON-RPC, the kernel handler routes through Cell Manager, the resulting cell carries `generated_by: <agent_id>` provenance. The structural rules of [certified-magic-emitter](../04%20-%20Reference/atoms/discipline/certified-magic-emitter.md) are preserved end-to-end.

The atom that authorizes this slice (`docs/atoms/discipline/certified-magic-emitter.md`) names six surfaces this slice must ship; without them the atom over-promises against shipped reality.

Driver: tighten the structural channel so a coordinator agent (or a future agent-as-generator pattern) can produce cells without the operator hand-typing every one — *without* widening the prompt-injection surface. The recovery path (stream promotion) acknowledges that LLMs will occasionally forget to call the tool and emit magic in their prose; the kernel sanitizes the line as always, but surfaces a one-click promotion for privileged agents.

Hard dependencies:
- S5.0 (cell-magic vocabulary + parser + registry) — shipped, submodule pin `336a6c7`.
- S5.0.1 (hash mode + emission ban + Cell Manager gates + verbatim acceptance) — shipped, atom-pinned in [magic-injection-defense](../04%20-%20Reference/atoms/discipline/magic-injection-defense.md).
- S5.0.2 (`magic_generators.py`, `cell_manager.insert_cells_with_provenance`, `generated_by` schema) — shipped, see [magic-code-generator atom](../04%20-%20Reference/atoms/concepts/magic-code-generator.md).

## §2. Goals and non-goals

### Goals

- **`emit_magic_cell` MCP tool.** Kernel-exposed JSON-RPC tool (per [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md)) accepting `{ name: <magic_name>, args: <kv_dict>, body: <string|null>, position: { after_cell_id: <id> } }`. Handler validates the calling agent's privilege grant, computes the canonical cell text (with `emit_magic_line()` for hash mode), and dispatches through `CellManager.insert_cells_with_provenance` with `generated_by: <agent_id>`. Returns the new `cell_id`.
- **Privilege grant / revoke operator-action intents.**
  - `grant_magic_emit_privilege { agent_id: <id>, zone_id: <id>, scope: { magics: [<name>, …] | "all" } }` — records into `metadata.rts.config.magic_emit_privileges[]`. Idempotent on `(agent_id, zone_id)`.
  - `revoke_magic_emit_privilege { agent_id: <id>, zone_id: <id> }` — removes the entry. Idempotent.
  - Both flow as overlay commits per [discipline/cell-manager-owns-structure](../04%20-%20Reference/atoms/discipline/cell-manager-owns-structure.md) so the grant appears in History mode.
- **Schema slot.** `metadata.rts.config.magic_emit_privileges[]` shape:
  ```jsonc
  [{ agent_id: <id>, zone_id: <id>, granted_at: <iso8601>, scope: { magics: [...] | "all" } }]
  ```
  Pin alongside the existing `magic_code_generators[]` / `magic_pin_fingerprint` slots in `metadata_writer.py`.
- **`promote_stream_magic` operator-action intent.** `{ cell_id: <id>, line: <verbatim_string> }` — synthesizes an `emit_magic_cell` call on the operator's behalf using the agent_id bound to the source cell. Sets `promoted_from_stream: true` on the resulting cell's provenance record.
- **`promoted_from_stream: bool` provenance flag.** Extends the `generated_by` / `generated_at` schema introduced by S5.0.2; default `false`. When `true`, the renderer chip reads "Promoted from stream emission" rather than "Generated by `<agent_id>`".
- **K-class additions.**
  - **K3K** `unprivileged_agent_magic_emit` — agent invoked `emit_magic_cell` without a privilege entry covering its `(agent_id, zone_id)` for the requested magic name; tool call rejects.
  - **K3L** `privileged_agent_stream_magic` — informational marker emitted when Layer-1 contamination detector flags a magic-shaped line in the stdout of an agent that *does* hold a privilege grant. Triggers the promotion chip; the line is still sanitized.
- **Extension surface (UI).**
  - Promotion chip on the cell contamination badge — only renders when `cells[<source>].contamination_log` contains an entry whose agent_id has an active grant. One-click → emits `promote_stream_magic` intent.
  - "Grant magic-emit privilege" cell-toolbar action on agent cells (with confirmation modal listing the cell's `agent_id`). Pairs with a "Revoke" toolbar action when a grant already exists.
  - Privilege-status chip on the notebook header next to the `🔒 hash mode` chip — shows count of active grants; click → list view with revoke buttons.

### Non-goals

- Per-magic permission gradations beyond `magics: [<names>]` / `"all"`. V2+ may add `magics_excluded:` for negative scopes.
- Cross-notebook privilege transfer (a grant in notebook A does not authorize the same `agent_id` in notebook B). Privilege records are notebook-local by design.
- Auto-granting privilege via heuristics (model identity, vendor, repeated stream emissions). Privilege is always operator-action.
- Replacing the stream sanitizer for privileged agents — Layer-2 emission ban applies unchanged; the promotion chip is additive, not exemptive.
- Multi-operator privilege grants (V3+; pairs with multi-operator pin support).
- Generator-handler privilege composition (a generator that runs the privileged tool on the operator's behalf). The generator path is already operator-rooted; this slice is the *agent-rooted* path.

---

## §3. Concrete work

Numbered sub-sections per the project's PLAN doc convention. Each subsection names a file with target LoC and the function signatures.

### §3.1 MCP tool handler — `vendor/LLMKernel/llm_kernel/magic_emit_tool.py` (NEW, ~120 LoC)

```python
def emit_magic_cell(
    *,
    agent_id: str,
    zone_id: str,
    name: str,
    args: dict[str, str],
    body: str | None,
    position: dict,
) -> dict:
    """Privileged-agent entry point.

    1. Look up privilege grant in metadata.rts.config.magic_emit_privileges[].
       Reject K3K if no covering entry.
    2. Compose canonical cell text via emit_magic_line() (handles hash mode).
    3. Dispatch through cell_manager.insert_cells_with_provenance(...)
       with generated_by=<agent_id>, promoted_from_stream=False.
    4. Return { cell_id: <new_id> }.
    """
```

Wire registration in `wire/tools.py`: add `EmitMagicCellRequest` / `EmitMagicCellResponse` schemas; register `emit_magic_cell` as a kernel-native tool per [RFC-001](../05%20-%20Standards/rfcs/RFC-001-mcp-tool-taxonomy.md).

### §3.2 Privilege store — `vendor/LLMKernel/llm_kernel/metadata_writer.py` (modest)

Add `MetadataWriter.grant_magic_emit_privilege` / `revoke_magic_emit_privilege` per the §2 schema. Idempotent. Re-uses the existing intent-registry path. Hand `magic_emit_privileges[]` lookups out via `cell_view`-style read accessors.

### §3.3 Promote-stream intent — `vendor/LLMKernel/llm_kernel/intent_handlers/promote_stream_magic.py` (NEW, ~80 LoC)

Synthesizes an `emit_magic_cell` call internally; the difference vs. agent-driven invocation is that the operator-action provides clause 1 of certified-magic-emitter (operator-rooted intent) and stamps `promoted_from_stream: true`. Source agent_id is recovered from the source cell's `bound_agent_id`.

### §3.4 K-class registration — `vendor/LLMKernel/llm_kernel/wire/tools.py` (modest)

K3K and K3L per §2 goals. Wire-tool catalogue.

### §3.5 Extension UI — `extension/src/notebook/*` (modest)

- Promotion-chip component on the cell contamination badge (`extension/src/notebook/cell-badge.ts`).
- "Grant / Revoke magic-emit privilege" toolbar actions (`extension/src/notebook/cell-toolbar.ts`).
- Privilege-status header chip + list view (`extension/src/notebook/header-chips.ts`).

### §3.6 Atom updates

- Update [discipline/certified-magic-emitter](../04%20-%20Reference/atoms/discipline/certified-magic-emitter.md) Status field — flip the V2+ row for privileged-agent emission from "queued" to "V1 shipped" once this slice lands. Update the K3K / K3L references to match the registered codes.
- Extend [concepts/magic-code-generator](../04%20-%20Reference/atoms/concepts/magic-code-generator.md) schema-additions block with `promoted_from_stream: bool` slot.
- Note the cross-reference in [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) — `emit_magic_cell` joins the native-tools list.

---

## §4. Interface contracts

The cross-layer signatures other slices code against:

```python
# vendor/LLMKernel/llm_kernel/magic_emit_tool.py
def emit_magic_cell(*, agent_id, zone_id, name, args, body, position) -> dict: ...

# vendor/LLMKernel/llm_kernel/metadata_writer.py
def grant_magic_emit_privilege(self, *, agent_id, zone_id, scope) -> None: ...
def revoke_magic_emit_privilege(self, *, agent_id, zone_id) -> None: ...
def get_magic_emit_privileges(self, *, agent_id=None, zone_id=None) -> list[dict]: ...

# Wire envelope additions (operator-action intents)
"grant_magic_emit_privilege"   # { agent_id, zone_id, scope }
"revoke_magic_emit_privilege"  # { agent_id, zone_id }
"promote_stream_magic"         # { cell_id, line }
```

---

## §5. Test surface

`vendor/LLMKernel/tests/test_magic_emit_privilege.py` (NEW): privilege grant + revoke roundtrip; `emit_magic_cell` rejects K3K without grant; `emit_magic_cell` succeeds with grant and stamps `generated_by`; cross-zone grant doesn't transfer; cross-notebook grant doesn't transfer; idempotent grant; idempotent revoke.

`vendor/LLMKernel/tests/test_promote_stream_magic.py` (NEW): privileged agent stream-emits `@@spawn beta`; Layer-1 detector fires K3L; promotion intent synthesizes `emit_magic_cell`; result cell carries `promoted_from_stream: true`; unprivileged agent stream-emits → no K3L, no promotion chip.

`extension/test/contract/magic-emit-privilege.test.ts` (NEW): grant button emits operator-action; revoke button emits operator-action; promotion chip only renders for privileged source cells; chip emits `promote_stream_magic`.

Target: kernel **+18** tests, extension contract **+5** tests.

---

## §6. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operator over-grants privilege ("trust this agent for everything") and forgets | Medium | Privilege list is visible on header chip; grant requires confirmation modal that quotes the agent's bound cell |
| Agent learns to deliberately emit magic via stream to trigger the promotion chip | Low (operator must still click) | Promotion chip requires explicit operator click — agent cannot force dispatch. Operator-facing UX phrasing makes the act of promoting an explicit decision |
| `emit_magic_cell` tool exposed to unprivileged agents via accidental schema export | Medium | Tool registration is per-agent (supervisor exposes only when grant exists); RFC-001 schema export gates by privilege |
| Grant survives revoke due to race with in-flight tool call | Low | Tool-call validation reads the live privilege table at dispatch time; revoke is observed immediately by subsequent calls |
| Grant in cell metadata mutates without overlay commit | Low | Grant flows through operator-action → overlay applier → cell manager (clause 2 of certified-magic-emitter); no direct writer mutation |

---

## §7. Atoms touched + Status updates after ship

**Created** (none — atom layer already covers this surface area):
- `docs/atoms/discipline/certified-magic-emitter.md` already exists and ratifies the structural rules.

**Updated** (Status flips on ship):
- [discipline/certified-magic-emitter](../04%20-%20Reference/atoms/discipline/certified-magic-emitter.md) — V2+ table row for "Privileged agent via MCP tool" flips to V1 shipped; K3K / K3L reference resolves
- [concepts/magic-code-generator](../04%20-%20Reference/atoms/concepts/magic-code-generator.md) — schema-additions block extended with `promoted_from_stream`
- [protocols/mcp-tool-call](../04%20-%20Reference/atoms/protocols/mcp-tool-call.md) — `emit_magic_cell` added to native-tools list

---

## §8. Cross-references

- [discipline/certified-magic-emitter](../04%20-%20Reference/atoms/discipline/certified-magic-emitter.md) — the standard this slice ratifies
- [discipline/magic-injection-defense](../04%20-%20Reference/atoms/discipline/magic-injection-defense.md) — the dual; Layer-1/Layer-2/Layer-3 defenses this slice composes with
- [concepts/magic-code-generator](../04%20-%20Reference/atoms/concepts/magic-code-generator.md) — the operator-rooted exception this slice's agent-rooted exception parallels
- [PLAN-S5.0.1](PLAN-S5.0.1-cell-magic-injection-defense.md) — emission ban + Cell Manager gates this slice builds on
- [PLAN-S5.0.2](PLAN-S5.0.2-magic-code-generators.md) — `insert_cells_with_provenance` + `generated_by` schema this slice extends

---

## §9. Definition of done

1. `emit_magic_cell` MCP tool registered in `wire/tools.py` and dispatched in `magic_emit_tool.py`. K3K rejects unprivileged calls.
2. Privilege grant/revoke operator-actions land in `metadata_writer.py`; the registry serializes through `metadata.rts.config.magic_emit_privileges[]`.
3. `promote_stream_magic` intent synthesizes `emit_magic_cell` calls and stamps `promoted_from_stream: true`.
4. Layer-1 detector emits K3L when a privileged agent stream-emits a magic-shaped line.
5. Extension renders the promotion chip on privileged-agent contamination badges; renders grant/revoke toolbar actions; renders privilege-status header chip.
6. Kernel pytest **+18** passing; extension contract **+5** passing.
7. Certified-magic-emitter atom Status updated to reflect ship; K3K/K3L reference resolves; `promoted_from_stream` slot referenced from `magic-code-generator` atom.
