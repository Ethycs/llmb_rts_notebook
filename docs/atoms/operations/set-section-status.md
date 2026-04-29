# Operation: set-section-status

**Status**: V1 spec'd (lands with BSP-005 S5.5)
**Source specs**: [BSP-007 §3.3](../../notebook/BSP-007-overlay-git-semantics.md#33-section-level-new-per-kb-target-01-kb-target-6) (section-level operations), [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md) (the rule this enforces)
**Related atoms**: [section](../concepts/section.md), [overlay-commit](../concepts/overlay-commit.md), [rename-section](rename-section.md), [delete-section](delete-section.md)

## Definition

`set_section_status(section_id, status)` is the canonical way to transition a [section](../concepts/section.md)'s `status` field. Direct mutation of `metadata.rts.zone.sections[<id>].status` outside this op is rejected by the MetadataWriter — the transition rules below are enforced here so structural ops downstream can trust the field.

The op is recorded as one [overlay commit](../concepts/overlay-commit.md). No [turn](../concepts/turn.md) is touched; no cell moves.

## Operation signature

```jsonc
{
  op: "set_section_status",
  section_id: "sec_...",
  status: "open" | "in_progress" | "complete" | "frozen",
  reason: "operator_unfreeze" | "run_started" | "run_completed" | "operator_signoff" | string  // optional, audit only
}
```

## Transition rules

Per [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md):

| From → To | Allowed | Initiator |
|---|---|---|
| `open` → `complete` | Yes | Operator |
| `complete` → `open` | Yes | Operator |
| `open` → `in_progress` | Yes | Kernel (auto on first run start) OR operator |
| `in_progress` → `open` | Yes | Kernel (auto when last run completes) OR operator |
| `* → frozen` | Yes | **Operator only** — never kernel-auto |
| `frozen → open` | Yes | **Operator only**; requires `reason: "operator_unfreeze"` |
| `frozen → complete` | No | Forbidden — must transit through `open` |
| `frozen → in_progress` | No | Forbidden — frozen sections are write-locked |
| `in_progress → frozen` | No | Forbidden — must transit through `open` (run must complete first) |
| `in_progress → complete` | No | Forbidden — must transit through `open` |

Any forbidden transition → **K95** (`overlay_section_status_blocks` with `section_id`, `from`, `to`, `reason: "invalid_transition"`).

## Invariants / Preconditions

- `section_id` MUST exist; else **K90** with `reason: "unknown_section"`.
- The transition (`current_status` → `status`) MUST be in the table above; else K95.
- For `* → frozen`: the section MUST NOT be `in_progress` at commit time. (The runtime check is at commit-apply time; if a new run started after intent submission but before commit, K95 surfaces with `reason: "run_active_at_commit"`.)
- For `frozen → open`: the operator MUST explicitly initiate (the kernel-auto path is disabled). The intent envelope's `reason` field MUST be `"operator_unfreeze"`.
- The section MUST NOT be currently being mutated by another in-flight commit (CAS protection per BSP-003's snapshot-version mechanism).

## What it produces

- `metadata.rts.zone.sections[<id>].status` updates to the new value.
- An entry in `metadata.rts.event_log[]`: `{type: "section_status_change", section_id, from, to, reason, timestamp}`.
- Open notebook UIs re-render the section header decoration on the next snapshot.
- Downstream operations on member cells re-evaluate their preconditions against the new status (see [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md) gating table).

## Kernel-driven transitions

`open ↔ in_progress` is the only kernel-auto pair in V1. The transition is recorded as a `set_section_status` commit just like the operator-initiated path; the difference is `reason: "run_started"` / `"run_completed"` and the commit's `author` field. This keeps history-mode walks readable: every status change has a single commit type.

## V1 vs V2+

- **V1**: four-value enum, transition table above, K95 on forbidden transitions.
- **V2+**: per-status lens UI; bulk status-set (e.g., "freeze all sections matching pattern"); time-bounded transitions ("freeze section S in 7 days unless touched"); audit-trail UI walking `event_log[]` for status churn.

## See also

- [section](../concepts/section.md) — the entity being updated.
- [decisions/v1-section-status-interruptibility](../decisions/v1-section-status-interruptibility.md) — why status exists in V1 and what each value means.
- [rename-section](rename-section.md) — sibling section-level op (title only).
- [delete-section](delete-section.md) — gated by status (frozen sections can't be deleted).
- [overlay-commit](../concepts/overlay-commit.md) — how the change is recorded.
