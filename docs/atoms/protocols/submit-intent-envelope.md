# Protocol: submit_intent envelope (BSP-003)

**Status**: `protocol` (V1 shipped)
**Family**: rides RFC-006 Family D as `action_type: "zone_mutate"`
**Direction**: extension → kernel (or kernel-internal); response key is `intent_id` returned over the data plane
**Source specs**: [BSP-003 §3](../../notebook/BSP-003-writer-registry.md#3-the-intent-envelope), [BSP-003 §5](../../notebook/BSP-003-writer-registry.md#5-intent-registry), [BSP-003 §6](../../notebook/BSP-003-writer-registry.md#6-apply-discipline), [BSP-003 §8](../../notebook/BSP-003-writer-registry.md#8-failure-modes-k-class-numbering-continued-from-bsp-002-k30s)
**Related atoms**: [protocols/operator-action](operator-action.md), [contracts/metadata-writer](../contracts/metadata-writer.md), [contracts/intent-dispatcher](../contracts/intent-dispatcher.md), [overlay-commit](../concepts/overlay-commit.md)

## Definition

The **submit_intent envelope** is the BSP-003 wire form for every mutation to `metadata.rts.zone`. All writes serialize through one queue inside the kernel's `MetadataWriter`; this envelope is the only legal way for an external caller (extension, sidebar UI, kernel-internal agents) to reach that queue. The same envelope shape supports CAS (`expected_snapshot_version`) and at-most-once delivery (idempotency on `intent_id`) so V3 multi-kernel coordination can wrap V1 callers without changing the wire.

## Schema

```jsonc
{
  "type": "operator.action",
  "payload": {
    "action_type":               "zone_mutate",
    "intent_kind":               "append_turn",                  // see registry below
    "parameters":                { /* per intent_kind */ },
    "intent_id":                 "01HZX7K3ABCDE...",             // ULID/UUID; idempotency key
    "expected_snapshot_version": 42                              // optional CAS
  }
}
```

`intent_id` (ULID/UUID) is the request key — a re-submission of the same id is a no-op + emits an `already_applied` response. `expected_snapshot_version` is optional; setting it activates the CAS path ("apply only if zone is at version 42; else K41").

## Intent registry (V1)

The complete enumeration of legal `intent_kind` values per [BSP-003 §5](../../notebook/BSP-003-writer-registry.md#5-intent-registry). Adding a kind requires a BSP/RFC amendment.

| `intent_kind`               | Mutates                                              | Atom |
|---|---|---|
| `append_turn`               | `agents.<id>.turns[]`                                | [turn](../concepts/turn.md) |
| `create_agent`              | `agents.<id>`                                        | [spawn-agent](../operations/spawn-agent.md) |
| `move_agent_head`           | `agents.<id>.session.head_turn_id`                   | [revert-agent](../operations/revert-agent.md) |
| `fork_agent`                | `agents.<new_id>`                                    | [branch-agent](../operations/branch-agent.md) |
| `update_agent_session`      | `agents.<id>.session.{status,pid,...}`               | [agent](../concepts/agent.md) |
| `add_overlay`               | `overlays.<id>`                                      | (within-turn overlays) |
| `move_overlay_ref`          | `overlay_refs.<turn_id>`                             | (within-turn overlays) |
| `set_cell_metadata`         | `cells[].metadata.rts.cell.*`                        | [cell](../concepts/cell.md) |
| `update_ordering`           | `ordering[]`                                         | [cell](../concepts/cell.md) |
| `add_blob`                  | `blobs.<hash>`                                       | [blob](../concepts/blob.md) |
| `record_event`              | `event_log[]`                                        | (append-only) |
| `apply_overlay_commit`      | `overlay.commits[]`, `overlay.refs.HEAD`             | [apply-overlay-commit](../operations/apply-overlay-commit.md) |
| `revert_overlay_to_commit`  | `overlay.refs.<ref>`                                 | [revert-overlay-commit](../operations/revert-overlay-commit.md) |
| `create_overlay_ref`        | `overlay.refs.<new_name>`                            | [create-overlay-ref](../operations/create-overlay-ref.md) |
| `record_context_manifest`   | `context_manifests.<manifest_id>`                    | [context-manifest](../concepts/context-manifest.md) |
| `record_run_frame`          | `run_frames.<run_id>`                                | [run-frame](../concepts/run-frame.md) |

Plus three writer-internal kinds wired through the same queue: `apply_layout_edit`, `apply_agent_graph_command`, `acknowledge_drift`.

## Response shape

The writer returns (over the data plane, not Family D):

```jsonc
{
  "applied":           true,
  "already_applied":   false,
  "intent_id":         "01HZX7K3...",
  "snapshot_version":  43,
  "error_code":        null,                    // K40 | K41 | K42 | K43 on failure
  "error_reason":      null,
  "response":          null                     // optional, e.g., for query-style commands
}
```

## Error envelope (K-class, BSP-003 §8)

| Code | Trigger | State change? |
|---|---|---|
| K40 | Unknown `intent_kind` | None |
| K41 | `expected_snapshot_version` mismatch (CAS) | None |
| K42 | Validator rejected (e.g., missing required parameter, target turn not in lineage) | None |
| K43 | Atomic file write failed (disk full, permission) | In-memory state consistent; file stale |

## Schema-version handshake

The envelope rides RFC-006 v2.x; the major-version is encoded in the Comm target name. The intent registry is BSP-003-versioned; new kinds require an amendment. V1 producers MUST NOT mint kinds outside the registry — K40 fires.

## V1 vs V3+

- **V1**: single kernel owns the queue; CAS is opt-in but rarely used (disjoint write paths).
- **V3+**: multiple kernels coordinate through a shell wrapping the V1 envelope (Raft / OT / CRDT). The wire shape does not change — V1 callers do not change.

## See also

- [protocols/operator-action](operator-action.md) — outer envelope this rides inside.
- [contracts/metadata-writer](../contracts/metadata-writer.md) — kernel side that owns the queue and the intent registry.
- [contracts/intent-dispatcher](../contracts/intent-dispatcher.md) — registers per-kind handlers and emits `intent_applied`.
- [overlay-commit](../concepts/overlay-commit.md) — the most-frequent intent payload.
- [apply-overlay-commit](../operations/apply-overlay-commit.md) — `intent_kind: "apply_overlay_commit"` carrier.
