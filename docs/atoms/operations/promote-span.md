# Operation: promote-span

**Status**: V1 spec'd (lands with overlay-commit infrastructure)
**Source specs**: [BSP-007 §3.4](../../notebook/BSP-007-overlay-git-semantics.md#34-promote--checkpoint-new-per-kb-target-5-13) (operation), [KB-notebook-target.md §5](../../notebook/KB-notebook-target.md#5-what-we-do-especially-well-split-and-merge) (refactoring calculus), [KB-notebook-target.md §16](../../notebook/KB-notebook-target.md#16-artifact-streaming) (artifact lensing), [PLAN-atom-refactor.md §4 row D7](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [span](../concepts/span.md), [cell](../concepts/cell.md), [cell-kinds](../concepts/cell-kinds.md), [artifact-ref](../concepts/artifact-ref.md), [overlay-commit](../concepts/overlay-commit.md)

## Definition

`promote_span(span_id, cell_kind?, section_id?)` lifts an emitted [span](../concepts/span.md) — typically an artifact range, a `propose_edit`, an `agent_emit` prose block, or a `report_completion` — into a standalone, addressable read-only [cell](../concepts/cell.md). The new cell carries the span as a binding, has no turns of its own, and lands at the end of the target section by default. The underlying [turn](../concepts/turn.md) DAG is unchanged.

## Operation signature

```jsonc
{
  op: "promote_span",
  span_id: "<span uuid>",
  cell_kind: "artifact" | "checkpoint",   // optional; inferred from span type per decision D7
  section_id: "sec_..."                   // optional; defaults to the source span's parent cell's section
}
```

Returns: `new_cell_id` (deterministic from `commit_id` + `span_id`).

## Decision D7 — kind inferred from span type

When `cell_kind` is omitted, the kernel infers it from the span's `name` / `output_kind`:

| Source span | Inferred `cell_kind` |
|---|---|
| `propose_edit` (a diff/patch the agent suggested) | `artifact` |
| `agent_emit` (agent prose) | `artifact` |
| `report_completion` (terminal-status span) | `checkpoint` |
| Tool spans (`tool_use` + `tool_result` together) | `artifact` |

Promoting **half** of a tool call (just `tool_use` or just `tool_result`) is **forbidden** — a tool call is atomic per [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md). Promote the pair as a unit or not at all.

If the operator passes an explicit `cell_kind` that conflicts with the inference (e.g., promoting prose as `checkpoint`), V1 honors the explicit kind but logs a `wire-failure` LogRecord-equivalent warning.

## Invariants / Preconditions

- `span_id` MUST exist on a turn in the current zone.
- The span MUST NOT lie inside a currently-executing cell (KB-target §22.7).
- The new cell is **read-only** with respect to its bound span: the operator cannot edit the span's content directly; they must edit the source via an overlay (BSP-002 §12) or unpromote.
- The new cell has empty `turns[]` and a non-null `bound_span_id`. Its `bound_agent_id` is `null` (the cell does not dispatch).
- Position default: end of `section_id` (matches **decision SD3** for [create-section](create-section.md)).
- For `cell_kind: "checkpoint"`, the same rules as the [pin-exclude-scratch-checkpoint](pin-exclude-scratch-checkpoint.md) checkpoint flag apply (decisions **CK1**, **CK2**).

## What it produces

- A new entry in `metadata.rts.cells[<new_cell_id>]` with `kind` per inference, `bound_span_id: <span_id>`, `section_id: <target>`, `capabilities: []`.
- The source span is unaffected; the original cell still renders the span. The promoted cell is a **lens** on the same span (KB-target §16's "cell becomes a portal").

## V1 vs V2+

- **V1**: one cell per promote; deterministic kind inference; default section placement.
- **V2+**: bulk-promote selections; promote-with-summary affordance (auto-checkpoint a promoted prose span); cross-zone promote.

## See also

- [span](../concepts/span.md) — the unit being lifted.
- [cell](../concepts/cell.md) — the new addressable artifact-cell.
- [cell-kinds](../concepts/cell-kinds.md) — `artifact` and `checkpoint` are the V1 promote targets.
- [artifact-ref](../concepts/artifact-ref.md) — the underlying storage shape.
- [overlay-commit](../concepts/overlay-commit.md) — how the promote is recorded.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — why tool-span half-promote is forbidden.
- [pin-exclude-scratch-checkpoint](pin-exclude-scratch-checkpoint.md) — checkpoint flag rules apply when promoting `report_completion`.
