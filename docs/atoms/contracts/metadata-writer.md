# Contract: MetadataWriter

**Status**: `contract` (V1 shipped — all listed methods present in code)
**Module**: `vendor/LLMKernel/llm_kernel/metadata_writer.py` — `class MetadataWriter`
**Source specs**: [BSP-003 §2](../../notebook/BSP-003-writer-registry.md#2-the-single-canonical-writer) (single canonical writer), [BSP-003 §6](../../notebook/BSP-003-writer-registry.md#6-apply-discipline) (apply discipline), [RFC-005 §"Persistence strategy"](../../rfcs/RFC-005-llmnb-file-format.md#persistence-strategy-who-writes-the-file), [RFC-006 §8](../../rfcs/RFC-006-kernel-extension-wire-format.md#8--family-f-notebook-metadata-bidirectional-in-v202)
**Related atoms**: [protocols/submit-intent-envelope](../protocols/submit-intent-envelope.md), [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md), [contracts/intent-dispatcher](intent-dispatcher.md), [contracts/drift-detector](drift-detector.md)

## Definition

The `MetadataWriter` is the **single canonical writer** of `metadata.rts.zone` per BSP-003 §2. All mutations serialize through one FIFO queue; reads remain unrestricted. The writer owns the [intent registry](../protocols/submit-intent-envelope.md), runs an autosave timer, emits Family F snapshots, and provides the hydrate path for file-open reload.

## Public method signatures

```python
class MetadataWriter:
    def __init__(
        self,
        dispatcher: Optional[CustomMessageDispatcher] = None,
        run_tracker: Optional[RunTracker] = None,
        session_id: Optional[str] = None,
        blob_threshold_bytes: int = DEFAULT_BLOB_THRESHOLD_BYTES,
        autosave_interval_sec: float = DEFAULT_AUTOSAVE_INTERVAL_SEC,
        event_log_queue_cap: int = DEFAULT_EVENT_LOG_QUEUE_CAP,
        workspace_root: Optional[Path] = None,
    ) -> None: ...

    # BSP-003 §3 — public mutation entrypoint.
    def submit_intent(self, envelope: dict) -> dict: ...

    # RFC-006 §8 v2.0.2 — file-open hydrate path.
    def hydrate(self, snapshot: dict) -> None: ...

    # RFC-005 drift acknowledgment.
    def acknowledge_drift(self, field_path: str, detected_at: str) -> bool: ...

    # Family B writer (apply_layout_edit dispatched via submit_intent too).
    def apply_layout_edit(self, operation: str, parameters: dict) -> int: ...

    # Family C writer.
    def apply_agent_graph_command(self, command: str, parameters: dict) -> dict: ...

    # Snapshot triggers (RFC-005 §"Snapshot triggers").
    def snapshot(self, trigger: str = "save") -> dict: ...
    def start(self) -> None: ...
    def stop(self, *, emit_final: bool = True) -> None: ...

    # Direct mutators (preserved from K-MW slice; new code SHOULD route via submit_intent).
    def update_layout(self, tree: dict) -> None: ...
    def update_agents(self, nodes, edges) -> None: ...
    def update_config(self, recoverable: dict, volatile: dict) -> None: ...
    def record_run(self, span: dict) -> None: ...
```

## Invariants

- **Single canonical writer.** All `metadata.rts.zone` mutations serialize through `submit_intent`'s FIFO `_intent_queue_lock`. BSP-003 §2.
- **Idempotency on `intent_id`.** A re-submission with the same `intent_id` is a no-op + returns `already_applied: true`. BSP-003 §6 step 2.
- **Optional CAS.** When `expected_snapshot_version` is set, mismatch returns K41 with no state change. BSP-003 §6 step 3.
- **Atomic apply.** Validator → mutate in-memory → bump `snapshot_version` → record `intent_applied` → emit Family F snapshot. Steps 4–9 of BSP-003 §6.
- **`hydrate(snapshot)` is idempotent.** Hydrating with the same snapshot twice leaves the writer in the same observable state. RFC-006 §"Hydrate request/response semantics".
- **`hydrate` resets the idempotency set.** A previously-applied `intent_id` appears unseen after hydrate; cross-session de-duplication is V3 work.
- **`snapshot_version` is monotonic** and persists across restarts via the hydrated value + 1.
- **`schema_version` major mismatch on hydrate raises `ValueError`** (the file is incompatible; operator must resolve).
- **`reject_secrets` runs before any config write.** Forbidden fields raise `SecretRejected` (RFC-005 §F2) before the write commits.

## K-class error modes

| Code | Trigger | Returned by |
|---|---|---|
| K40 | Unknown `intent_kind` (not in `_BSP003_INTENT_KINDS`) | `submit_intent` |
| K41 | CAS mismatch (`expected_snapshot_version` ≠ current) | `submit_intent` |
| K42 | Validator rejected (e.g., missing required field, malformed envelope, target turn unknown) | `submit_intent` |
| K43 | Atomic file write failed (disk full, permissions) | `snapshot` (in-memory state stays consistent) |

## Locking / threading

- `_lock: threading.RLock` — reentrant; protects the snapshot dicts.
- `_intent_queue_lock: threading.RLock` — FIFO gate for `submit_intent`.
- The RLock-on-logging anti-pattern (Engineering Guide §11.7) is enforced — log calls happen OUTSIDE the lock per [anti-patterns/rlock-logging](../anti-patterns/rlock-logging.md).
- `start()` runs the 30-second autosave timer thread; `stop(emit_final=True)` flushes a final snapshot on clean shutdown.

## Callers

- `vendor/LLMKernel/llm_kernel/_kernel_hooks.py` (`attach_kernel_subsystems`) — wires the writer to dispatcher + run-tracker.
- `vendor/LLMKernel/llm_kernel/agent_supervisor.py` — submits `record_run_frame` and `record_context_manifest` intents per BSP-008.
- `vendor/LLMKernel/llm_kernel/custom_messages.py` — receives `notebook.metadata mode:hydrate` envelopes and calls `hydrate(...)` then forwards drift events / respawn calls to siblings.
- Sibling contracts: [intent-dispatcher](intent-dispatcher.md) (this is the registry surface), [drift-detector](drift-detector.md) (called during hydrate), [agent-supervisor](agent-supervisor.md) (post-hydrate respawn).

## Code drift vs spec

Implementation is largely conformant. Notable: the BSP-007 K-OVERLAY slice intent kinds (`apply_overlay_commit`, `revert_overlay_to_commit`, `create_overlay_ref`) and the BSP-008 K-CTXR kinds (`record_context_manifest`, `record_run_frame`) are **NOT yet present** in `_BSP003_INTENT_KINDS` (lines 747–768). They are spec'd in BSP-003 §5 (post-Op-5 amendment) but implementation has not caught up — submitting them today returns K40.

## See also

- [protocols/submit-intent-envelope](../protocols/submit-intent-envelope.md) — the wire shape `submit_intent` consumes.
- [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md) — the Family F snapshots `snapshot()` emits.
- [contracts/intent-dispatcher](intent-dispatcher.md) — the per-kind handler registry inside `MetadataWriter`.
- [contracts/drift-detector](drift-detector.md) — invoked from the hydrate path.
- [discipline/save-is-git-style](../discipline/save-is-git-style.md) — overlay commits route through this writer.
