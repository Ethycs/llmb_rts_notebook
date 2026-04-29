# Plan: S3.5 — ContextPacker simple-walker

**Status**: ready
**Audience**: an LLM (or operator) picking this up cold. Self-contained.
**Goal**: implement the V1 ContextPacker as a pure, deterministic structural walker that produces a `ContextManifest` per cell run, persisted via the new `record_context_manifest` BSP-003 intent.
**Time budget**: 1 day. Single-agent. Depends on S3 (multi-turn) shipped; blocks S4's cross-agent handoff.

---

## §1. Why this work exists

S3 made multi-turn cells real on the wire, but every turn's context is still "the agent's whole prior session" — there is no per-cell-run derivation of "what context did THIS run see?" Without that, the answers to two Inspect-mode questions are irrecoverable: *"what context did the agent see?"* and *"what changed in the turn DAG?"*

Driver: [KB-notebook-target.md §0.6](KB-notebook-target.md), ratified into the slice ladder via [BSP-005 §6.2](BSP-005-cell-roadmap.md#62-s35--contextpacker-simple-walker-new).

Hard dependencies:
- S3 must have shipped (multi-turn data structure exists).
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) must have shipped (`kind` field readable for `scratch`/`checkpoint` filtering).
- Substrate gap G5 ([PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — `record_context_manifest` intent kind) MUST land first or in parallel.

## §2. Goals and non-goals

### Goals

- A pure-function `ContextPacker.pack(notebook_state, current_cell, current_section) → ContextManifest` exists per [contracts/context-packer](../atoms/contracts/context-packer.md).
- The manifest is persisted via the new `record_context_manifest` intent kind per [protocols/submit-intent-envelope](../atoms/protocols/submit-intent-envelope.md).
- Determinism guarantee: identical inputs ⇒ byte-identical manifest. Required for Inspect-mode replay correctness.
- Tracing: `inclusion_rules_applied[]` and `exclusions_applied[]` are populated correctly so Inspect mode can render "explain why."

### Non-goals

- NO ranking, NO budget overflow, NO summary trust, NO retrieval. V1 is a structural walk only per [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md).
- `total_token_estimate` stays `null` in V1.
- This slice does NOT implement RunFrames — that lives in [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md). The manifest is consumed there but not written there.
- This slice does NOT alter the agent's process invocation — it only computes the manifest before each turn dispatch.

## §3. Concrete work

1. **New module.** Create `vendor/LLMKernel/llm_kernel/context_packer.py` per [contracts/context-packer](../atoms/contracts/context-packer.md). Implements the BSP-008 §3 algorithm verbatim:
   ```
   1. Pinned cells anywhere in the notebook
   2. Previous cells in current section in chronological order
      (or document order if cell has no section)
   3. Current cell's prior sub-turns (only when merges produced sub-turns)
   4. Exclude cells flagged scratch | excluded | obsolete
   5. Dedupe, preserving first-occurrence order
   ```
2. **Pure function discipline.** No I/O, no agent calls, no logging that leaves the process. Returns the manifest dataclass; persistence is the supervisor's responsibility.

3. **Output schema.** Match [concepts/context-manifest](../atoms/concepts/context-manifest.md) exactly. `manifest_id` is a fresh ULID; `total_token_estimate: None` per V1 lock.

4. **Wire into AgentSupervisor.** In `vendor/LLMKernel/llm_kernel/agent_supervisor.py`, before each operator turn dispatch (the V1.1 `send_user_turn` path from S3):
   ```python
   manifest = ContextPacker.pack(notebook_state, current_cell, current_section)
   self._writer.submit_intent({
     "type": "operator.action",
     "payload": {
       "action_type": "zone_mutate",
       "intent_kind": "record_context_manifest",
       "parameters": {"manifest": manifest},
       "intent_id": ulid(),
     }
   })
   ```
   The supervisor reads the resulting `manifest_id` from the response and remembers it for the RunFrame pairing in S6.

5. **MetadataWriter intent handler.** Add `record_context_manifest` to `_BSP003_INTENT_KINDS` and register a handler that persists `manifest` under `metadata.rts.zone.context_manifests[<manifest_id>]`. K42 sub-reason `unknown_turn_ref` if any `turn_ids[]` entry is not in the persisted DAG (this is K103 in BSP-008's numbering — surface it via K42 in the writer's wire response, with `error_reason: "K103: unknown_turn_ref"`).

6. **K-class additions.** Defined in BSP-008 §10:
   - K100 — `current_cell` orphan in `pack(...)`. Surfaced from the packer; supervisor catches and aborts the run.
   - K101 — Section-walk cycle. Packer returns the partial walk up to the cycle; supervisor logs and continues with the partial.
   - K103 — unknown turn ref at write time, returned from the writer.

7. **Hydrate path.** `MetadataWriter.hydrate(snapshot)` round-trips `metadata.rts.zone.context_manifests` unchanged; manifests are append-only.

## §4. Interface contracts

```python
# vendor/LLMKernel/llm_kernel/context_packer.py
@dataclass
class NotebookState:
    cells: dict[str, dict]               # cell_id → metadata
    sections: list[dict]                 # metadata.rts.zone.sections[]
    agents: dict[str, dict]              # agents map with turns[]
    ordering: list[str]                  # document order

def pack(
    notebook_state: NotebookState,
    current_cell: dict,
    current_section: Optional[dict],
) -> ContextManifest:
    ...
```

Wire envelope (rides Family D as `zone_mutate`):

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type": "zone_mutate",
    "intent_kind": "record_context_manifest",
    "parameters": { "manifest": <ContextManifest> },
    "intent_id":   "01HZX7K3..."
  }
}
```

Response shape (per `submit_intent` envelope): standard `applied | already_applied | error_code` keyed by `intent_id`.

The `ContextManifest` shape is locked by [concepts/context-manifest](../atoms/concepts/context-manifest.md) and MUST NOT diverge.

## §5. Test surface

New file `vendor/LLMKernel/tests/test_context_packer.py`:

- `test_pack_includes_pinned_first` — pinned cells appear at head of `turn_ids[]`.
- `test_pack_section_predecessors_chronological` — within a section, predecessors are in document order.
- `test_pack_excludes_scratch_excluded_obsolete` — flagged cells absent; entries appear in `exclusions_applied[]`.
- `test_pack_includes_sub_turns_when_merged` — merged cell exposes prior sub-turns.
- `test_pack_dedupe_preserves_first_occurrence_order` — pinned-then-section duplicates emit once at pinned position.
- `test_pack_is_deterministic` — running pack(...) twice on the same input yields equal manifests modulo `manifest_id` and `created_at`.
- `test_pack_orphan_cell_raises_k100` — current_cell not in overlay → K100.
- `test_pack_section_cycle_returns_partial` — section parent cycle → partial walk + K101 log entry.

In `vendor/LLMKernel/tests/test_metadata_writer.py`:

- `test_record_context_manifest_round_trip` — intent applies, manifest reachable on snapshot.
- `test_record_context_manifest_rejects_unknown_turn_ref` — K42/K103 surfaces.

In `vendor/LLMKernel/tests/test_agent_supervisor.py`:

- `test_supervisor_packs_before_send_user_turn` — `send_user_turn` invokes `ContextPacker.pack(...)` and submits a `record_context_manifest` intent.

Expected count: 8 packer tests + 2 writer tests + 1 supervisor test = 11 new tests.

## §6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `pack(...)` non-determinism (e.g., dict iteration order in Python <3.7 — N/A here) | Explicit list comprehensions, sorted iteration where needed; the determinism test in §5 catches this. |
| Manifest size growth per run (large notebooks) | `total_turn_count` is bounded by the notebook size; V1 emits everything that passes filters per [decisions/v1-contextpacker-walk](../atoms/decisions/v1-contextpacker-walk.md). Budget overflow is V2 work. |
| Supervisor races: manifest committed but agent dies before turn dispatch | Manifests are append-only and have no consumer guarantee; an "orphan" manifest is harmless until the corresponding RunFrame in S6 exists. |
| Section walk cycle (V1 sections are flat — should be impossible) | K101 is defensive; covered by `test_pack_section_cycle_returns_partial`. |

## §7. Atoms touched + Atom Status fields needing update

- [contracts/context-packer.md](../atoms/contracts/context-packer.md) — Status changes from `V1 spec'd ... NOT yet present` to `V1 shipped`. Update Status line and Code drift vs spec section.
- [concepts/context-manifest.md](../atoms/concepts/context-manifest.md) — Status `V1 shipped` already. Verify wording stays accurate.
- [decisions/v1-contextpacker-walk.md](../atoms/decisions/v1-contextpacker-walk.md) — no change; cite from this plan.
- [contracts/metadata-writer.md](../atoms/contracts/metadata-writer.md) — Code drift section: clear the line about `record_context_manifest` missing from `_BSP003_INTENT_KINDS`.
- [contracts/intent-dispatcher.md](../atoms/contracts/intent-dispatcher.md) — Code drift section: same.
- [protocols/submit-intent-envelope.md](../atoms/protocols/submit-intent-envelope.md) — registry table's `record_context_manifest` row's "atom" link now wires to a working implementation.

## §8. Cross-references (sibling PLANs)

- [PLAN-v1-roadmap.md §5 row 4](PLAN-v1-roadmap.md) — first ship-ready criterion this slice flips.
- [PLAN-S0.5-cell-kinds.md](PLAN-S0.5-cell-kinds.md) — `kind` field this consumes for `scratch`/`checkpoint` filtering.
- [PLAN-S4-cross-agent-handoff.md](PLAN-S4-cross-agent-handoff.md) — handoff replay uses the manifest output.
- [PLAN-S6-cell-binding-runframes.md](PLAN-S6-cell-binding-runframes.md) — RunFrame's `context_manifest_id` points at this slice's output.
- [PLAN-substrate-gap-closure.md](PLAN-substrate-gap-closure.md) — gap G5 (`record_context_manifest` intent kind) lands here as part of the slice.
- [PLAN-S5.5-sections.md](PLAN-S5.5-sections.md) — section ordering is what `current_section` reflects.

## §9. Definition of done

- [ ] All 11 new tests pass.
- [ ] Existing kernel test suite stays green; no determinism regression in unrelated paths.
- [ ] End-to-end smoke: spawn alpha → 3 turns → snapshot the notebook file → confirm `metadata.rts.zone.context_manifests` has 3 entries with non-empty `turn_ids[]` and the inclusion trace matches the V1 walk.
- [ ] Inspect-mode dry-run: programmatically resolve a `manifest_id` from a RunFrame (placeholder until S6) and confirm the `inclusion_rules_applied[]` rendering matches the cells the run could see.
- [ ] [contracts/context-packer.md](../atoms/contracts/context-packer.md) Status flipped to `V1 shipped`.
- [ ] BSP-005 §6.2 changelog updated with the slice's commit SHA.
- [ ] This plan flips to `**Status**: shipped (commit <SHA>)`.
