# Contract: Intent Dispatcher

**Status**: `contract` (V1 shipped — built into `MetadataWriter._dispatch_intent` / `_intent_handler_for`; not a separate module)
**Module**: `vendor/LLMKernel/llm_kernel/metadata_writer.py` lines 824–1130 (`_dispatch_intent`, `_intent_handler_for`, `_BSP003_INTENT_KINDS`)
**Source specs**: [BSP-003 §5](../../notebook/BSP-003-writer-registry.md#5-intent-registry) (registry), [BSP-003 §6](../../notebook/BSP-003-writer-registry.md#6-apply-discipline) (steps 1–9)
**Related atoms**: [protocols/submit-intent-envelope](../protocols/submit-intent-envelope.md), [contracts/metadata-writer](metadata-writer.md), [contracts/overlay-applier](overlay-applier.md)

## Definition

The **intent dispatcher** is the per-`intent_kind` handler registry inside `MetadataWriter`. It maps each [intent envelope](../protocols/submit-intent-envelope.md)'s `intent_kind` to an apply function, drives validation (step 4), mutation (step 5), version bump (step 6), `intent_applied` recording (step 7), and Family F snapshot emission (step 9). In V1 this is **not a separate module** — the dispatcher is a private surface of `MetadataWriter`. A future K-MW refactor MAY extract it; the contract below describes the shape that surface presents today.

## Public method signatures

```python
# Inside MetadataWriter (V1 location):

# BSP-003 §5 enumeration. Adding a kind requires a BSP/RFC amendment.
_BSP003_INTENT_KINDS: FrozenSet[str] = frozenset({
    "append_turn", "create_agent", "move_agent_head", "fork_agent",
    "update_agent_session", "add_overlay", "move_overlay_ref",
    "set_cell_metadata", "update_ordering", "add_blob", "record_event",
    "apply_layout_edit", "apply_agent_graph_command", "acknowledge_drift",
})

# Public (the only mutation entrypoint per BSP-003 §10).
def submit_intent(self, envelope: dict) -> dict: ...   # see metadata-writer atom

# Private dispatcher (caller holds _intent_queue_lock).
def _dispatch_intent(self, envelope: dict) -> dict: ...

# Per-kind handler resolver.
def _intent_handler_for(self, intent_kind: str) -> Callable[[dict], Any]: ...

# Failure result helper.
def _intent_failure(self, intent_id: str, code: str, reason: str) -> dict: ...

# Read-only intent log (intent_applied entries).
def iter_intent_log(self) -> list[dict]: ...

# Spec'd registration surface (NOT yet present; would let external
# slices register their own handlers without amending core):
def register(self, intent_kind: str, handler: Callable[[dict], Any]) -> None: ...
def dispatch(self, envelope: dict) -> dict: ...           # alias for submit_intent
def emit_intent_applied(self, intent_id: str, intent_kind: str, snapshot_version: int) -> None: ...
```

## Invariants

- **FIFO serialization.** All intents pass through `_intent_queue_lock` (a `threading.RLock`); concurrent submissions interleave deterministically.
- **Idempotency-first.** Step 2 of BSP-003 §6 runs before validation; a re-submit returns `already_applied: true` without re-validating.
- **CAS before validation.** Step 3 (`expected_snapshot_version` check) returns K41 before any handler runs.
- **K40 on unknown kind.** `intent_kind not in _BSP003_INTENT_KINDS` returns K40 with no state change.
- **Atomic per-intent.** Validator → mutate → version bump → `intent_applied` log → Family F snapshot. A handler exception triggers K42 with no state change.
- **Snapshot emission MUST NOT break the apply contract.** If `snapshot()` raises, the in-memory state is already updated; the failure is logged but `submit_intent` still returns `applied: true`.
- **Version-bump policy.** `record_event` and `acknowledge_drift` rely on the dispatcher to bump `_snapshot_version`; layout / agent_graph mutators bump themselves and the dispatcher records the post-bumped value.

## K-class error modes (mirrors BSP-003 §8)

| Code | Path | Scenario |
|---|---|---|
| K40 | `intent_kind not in _BSP003_INTENT_KINDS` | Producer ahead of receiver |
| K41 | CAS mismatch | Caller's view stale |
| K42 | Handler raised, or returned a falsy outcome (validator rejected) | Bad parameters |
| K43 | Atomic file write failed (surfaces from `snapshot()`) | Disk problem |

## Callers

- `MetadataWriter.submit_intent` (the public surface) — the only thing that holds `_intent_queue_lock` and calls into `_dispatch_intent`.
- Indirectly: every BSP-003 §5 producer — `AgentSupervisor` (record_run_frame, record_context_manifest, append_turn, update_agent_session), the overlay applier (apply_overlay_commit), the extension via `operator.action: zone_mutate` (drift_acknowledged → acknowledge_drift, etc.).

## Code drift vs spec

- **The five BSP-007 + BSP-008 intent kinds are missing** from `_BSP003_INTENT_KINDS`: `apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`, `record_context_manifest`, `record_run_frame`. They are in BSP-003 §5 (post-Op-5 amendment, 2026-04-28) but the implementation has not caught up — submitting them returns K40.
- **`register(kind, handler)` is not present.** The dispatcher is a closed registry today; external slices cannot add kinds without editing `_BSP003_INTENT_KINDS` and `_intent_handler_for`. The K-OVERLAY slice will need to either extend the registry inline or a `register()` API at landing time.

## See also

- [protocols/submit-intent-envelope](../protocols/submit-intent-envelope.md) — the wire shape this dispatcher consumes.
- [contracts/metadata-writer](metadata-writer.md) — outer contract that owns this dispatcher.
- [contracts/overlay-applier](overlay-applier.md) — will plug into this dispatcher for `apply_overlay_commit`.
- [overlay-commit](../concepts/overlay-commit.md) — the most-frequent intent payload (post-K-OVERLAY landing).
