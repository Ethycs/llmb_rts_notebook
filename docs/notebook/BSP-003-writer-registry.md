# BSP-003: Zone Writer Registry and Append Discipline

**Status**: Issue 1 — Draft, 2026-04-27
**Related**: BSP-002 (conversation graph), RFC-005 (file format), RFC-006 (wire format)
**Defers to V3/V4**: multi-kernel coordination, multi-operator conflict resolution, CRDT/OT machinery

## 1. Scope

This BSP fixes the write-side discipline for `metadata.rts.zone` — who is allowed to mutate it, how those mutations are expressed on the wire, and how the writer guarantees the file stays valid under concurrent agent emissions and operator edits.

**V1 reality (scope of this BSP):**
- One kernel process per notebook
- One extension instance attached to one notebook
- One operator
- Multiple agents emitting concurrently within the one kernel

**Out of scope (V3/V4):**
- Multiple kernels writing to the same notebook (collaborative editing)
- Multiple operators on different machines
- Cross-kernel conflict resolution (CRDT, OT, lock service)

The V1 design preserves the **intent envelope pattern** (§4) so V3/V4 can plug in coordination without changing the wire schema or the data model.

## 2. The single canonical writer

Within one kernel, exactly one component holds write authority over `metadata.rts.zone`: the kernel's `MetadataWriter` (RFC-005). All other components — agent emissions, operator edits via the extension, sidebar UI mutations — submit *intents* and let the writer apply them.

This is not "the kernel does everything." It's: **all writes serialize through one queue.** Reads remain unrestricted (anyone can subscribe to snapshots; anyone can read the file).

Why a single writer in V1:
- No file-level locking needed (single process owns the file handle)
- No CAS or version-vector machinery needed (single thread of writes)
- Atomic file writes via `tmp + rename` (POSIX guarantees + Windows replacement semantics)
- The writer can batch intents, debounce saves, and emit consistent snapshots
- Any race that does emerge is a bug in the queue discipline, not in distributed semantics

## 3. The intent envelope

All mutations to `metadata.rts.zone` are expressed as **intents** — typed RFC-006 envelopes carrying the requested change. The writer dispatches each intent through a registry (§5) to the appropriate apply function.

Envelope shape (RFC-006 §6 amendment, additive):

```json
{
  "type": "operator.action",
  "payload": {
    "action_type": "zone_mutate",
    "intent_kind": "<see §5>",
    "parameters": { ... per intent kind ... },
    "intent_id": "01HZX7K3...",
    "expected_snapshot_version": 42
  }
}
```

`intent_id` (ULID/UUID) is the request key — used for idempotency (re-submitting the same `intent_id` is a no-op if already applied) and for correlation (the writer emits an `intent_applied` event referencing it).

`expected_snapshot_version` is **optional in V1** — set if the caller wants CAS semantics ("apply only if the zone is still at version 42; otherwise reject"). Most V1 callers omit it because writes are on disjoint paths and last-writer-wins is fine. Setting it activates the CAS path that V3/V4 will exercise heavily.

## 4. Why intents, not direct writes

Direct writes would let the extension and kernel both call `MetadataWriter.append_turn(...)` from different threads or processes. That's a race. Intents serialize through the writer's queue and:

1. **Preserve append-only invariants automatically.** The intent kinds in §5 are the *only* legal mutations; the writer enforces them. No caller can sneak in a turn-edit that violates BSP-002 §2's immutability.
2. **Make replay deterministic.** The intent log is the source of truth; the file state is the materialization. Replaying intents from any starting snapshot produces the same final state.
3. **Forward-compat with V3/V4.** When multiple kernels eventually write to one notebook, the intent stream is what gets coordinated (Raft, CRDT op-log, etc.). V1 just runs the local case; V3 wraps it. The wire shape doesn't change.
4. **Auditable.** Every mutation has an envelope on the wire. RFC-007 tape captures it. Replay-from-tape works.

## 5. Intent registry

The complete enumeration of allowed mutations. Each is an `intent_kind`; each maps to an apply function on `MetadataWriter`. Adding a new intent kind requires a BSP/RFC amendment (no ad-hoc kinds).

| `intent_kind` | Submitted by | Mutates | Notes |
|---|---|---|---|
| `append_turn` | kernel (agent emit) OR extension (operator input) | `agents.<id>.turns[]` | Append-only; turn is immutable thereafter |
| `create_agent` | kernel (`/spawn`) | `agents.<id>` | Creates new agent record + first turn atomically |
| `move_agent_head` | kernel (turn committed) OR extension (`/revert`) | `agents.<id>.session.head_turn_id` | CAS-friendly; the most contested write |
| `fork_agent` | kernel (`/branch`) | `agents.<new_id>` | Creates new agent referencing source's transcript prefix |
| `update_agent_session` | kernel | `agents.<id>.session.{runtime_status,pid,claude_session_id,last_seen_turn_id}` | Routine state updates from the supervisor |
| `add_overlay` | extension (operator) | `overlays.<id>` | Append-only |
| `move_overlay_ref` | extension (operator) | `overlay_refs.<turn_id>` | Mutable head; like agent head |
| `set_cell_metadata` | extension | `cells[].metadata.rts.cell.*` | Render-time cache (BSP-002 §6) |
| `update_ordering` | extension (drag-cell-to-reorder) | `ordering[]` | Renumbers without touching turn DAG |
| `add_blob` | kernel (tool emit) OR extension (overlay replacement) | `blobs.<hash>` | Content-addressed; idempotent on hash |
| `record_event` | any (writer-side log) | `event_log[]` | Append-only; ref-moves, handoffs, intent applications |

Submitting an intent for an unknown `intent_kind` raises K40 (see §8).

## 6. Apply discipline

Inside the writer:

1. **Receive intent.** Parsed envelope arrives at `MetadataWriter.submit_intent(envelope)`.
2. **Idempotency check.** If `intent_id` already in the applied-set, no-op + emit `intent_applied` (already-applied flag set).
3. **CAS check.** If `expected_snapshot_version` is set and != current, reject with K41.
4. **Validate.** Run the intent-kind's validator (e.g., `append_turn` checks the parent_id exists; `move_agent_head` checks the target turn_id is in the agent's lineage).
5. **Apply.** Mutate the in-memory zone state.
6. **Bump snapshot_version.** Monotonic.
7. **Record.** Append `intent_applied` to `event_log` with `intent_id`, `intent_kind`, new `snapshot_version`.
8. **Schedule durable write.** Debounced (~500ms) atomic file write (tmp + rename); urgent intents (`record_event`) flush sooner.
9. **Emit snapshot.** RFC-006 Family F `notebook.metadata` envelope to subscribers (extension, sidebar). Carries new `snapshot_version`.

The writer's queue is FIFO per zone (V1: one zone per kernel, so just FIFO). Multi-zone V2 makes the FIFO per-zone.

## 7. Concurrency in V1

V1 has two real concurrency concerns inside one kernel:

1. **Multiple agents emitting at the same time.** Both spawn-supervisor and tool-emit threads call `MetadataWriter.submit_intent(append_turn, ...)` concurrently. The writer's queue serializes them. Result: turns interleave by arrival order; both are persisted; no loss.
2. **Operator edits while an agent emits.** Extension submits `add_overlay` while kernel submits `append_turn`. Disjoint JSON paths (`overlays.*` vs `agents.*.turns[]`); no real conflict. Last-writer-wins on each path; both succeed.

The CAS path (§3 `expected_snapshot_version`) is available but not used by V1 callers. It exists so that:
- V3 multi-kernel coordination has the primitive ready
- V2+ operator UX can opt in to "fail my edit if the zone changed underneath" for sensitive operations (e.g., a long overlay edit that would be hard to redo)

## 8. Failure modes (K-class numbering, continued from BSP-002 K30s)

| Code | Symptom | Marker | Operator action |
|---|---|---|---|
| K40 | Intent submitted with unknown `intent_kind` | `intent_unknown_kind` with `intent_kind` | Likely a version skew between extension and kernel; check kernel and extension versions |
| K41 | CAS rejection (`expected_snapshot_version` mismatch) | `intent_cas_rejected` with `expected`, `actual`, `intent_id` | Caller's view is stale; re-fetch and retry |
| K42 | Intent validator rejected (e.g., `move_agent_head` to a turn not in lineage) | `intent_validation_failed` with `intent_kind`, `reason` | Operator-facing error; surface the reason in UX |
| K43 | Atomic file write failed (disk full, permission, etc.) | `zone_write_failed` with `error`, `path` | Surface to operator; the in-memory state is still consistent but the file is stale |

K40–K42 reject the intent (no state change). K43 keeps the in-memory state and surfaces a degraded-mode warning; the next successful write re-syncs.

## 9. V3/V4 forward-compat notes

The V1 design intentionally avoids:

- **File locking** — single kernel owns the file. V3 needs a lock service or per-file lease (e.g., one `<file>.lock` token coordinated by an external service or the file system's advisory locks).
- **Conflict resolution** — disjoint-path writes don't conflict in V1. V3 needs OT or CRDT; the append-only nature of the data model (turns, overlays, blobs, events) makes both feasible (set-CRDT for collections; LWW-Map for refs with vector clocks).
- **Distributed durability** — single-file atomic rename is enough for one machine. V3 needs replication; the intent log (§6 step 7) is what gets shipped between replicas.

The intent envelope (§3) is the seam. V3 builds:
- A coordination layer that orders intents from multiple kernels (Raft, paxos, etc.)
- A conflict resolver that detects concurrent intents touching the same path
- A merge function for ref intents (LWW + vector clock)

V1 callers and the V1 writer don't change. V3 wraps both in a coordination shell.

## 10. Implementation slice

Single slice for V1, owned by K-MW:

- Add `MetadataWriter.submit_intent(envelope)` as the public mutation entrypoint
- Implement the intent registry (§5) — apply functions per intent_kind
- Idempotency set (`intent_id → snapshot_version`) for replay safety
- Optional CAS check on `expected_snapshot_version`
- FIFO queue (single thread; the existing autosave timer thread handles drainage)
- Atomic write via `tmp + rename` (already in MetadataWriter; verify Windows path)
- New tests: concurrent submit_intent calls, idempotency on duplicate intent_id, CAS rejection, atomic write under simulated crash

X-EXT slice changes: any extension-side write that currently mutates zone state directly is rewritten to submit an intent envelope. (V1 has zero such writes today — the extension only reads; this slice mostly future-proofs for when overlays/cell-metadata writes land per BSP-002 §12.)

## 11. Why this is small in V1

The V1 implementation is ~200 lines in `MetadataWriter` plus the registry table. The discipline (single canonical writer, intent envelopes, append-only invariants) is large; the code is small because:

- One process holds the file → no locking
- Disjoint write paths → no conflict resolution
- Synchronous in-process queue → no consensus
- Append-only data model → no merge logic

The same discipline costs orders of magnitude more in V3 because each of those collapses into harder problems. But the V1 design pays no down payment on V3: the **intent envelope** is the only forward-compat surface, and it's already part of RFC-006.

## Changelog

- **Issue 1, 2026-04-27**: initial draft. Single canonical writer + intent envelope pattern. V1 simplifications enumerated; V3/V4 forward-compat seam pinned. Intent registry §5 covers all BSP-002 mutations. Implementation slice §10 sized for K-MW.
