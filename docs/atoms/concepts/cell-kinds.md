# Cell kinds

**Status**: V1 shipped (4 kinds active, 4 reserved; markdown=no-badge and promoted-suffix render rules now enforced on the X-EXT side, S1 / commit `26ac581`)
**Source specs**: [BSP-002 §13.2](../../notebook/BSP-002-conversation-graph.md#132-cell-kinds-typed-enum-kb-target-04), [KB-notebook-target.md §0.4](../../notebook/KB-notebook-target.md#04-cell-kinds-typed-in-v1), [KB-notebook-target.md §13.1](../../notebook/KB-notebook-target.md) (the eight-kind taxonomy)
**Related atoms**: [cell](cell.md), [tool-call](tool-call.md), [artifact-ref](artifact-ref.md)

## Definition

The **cell-kinds enum** is the typed `kind` field on every cell, fixed at write time and enforced from V1 so that downstream rules (merge correctness, ContextPacker filtering, render dispatch) can branch structurally instead of guessing from cell content. Eight kinds exist in the spec; V1 ships four; four are reserved for V2+ but their slot exists in the enum from day one.

## Schema

Stored at `metadata.rts.cells[<cell_id>].kind`. Required field.

```jsonc
"cells": {
  "vscode-notebook-cell:.../#abc": {
    "kind": "agent",          // one of the eight values below
    "bound_agent_id": "alpha",
    "section_id": "sec_01HZX...",
    "capabilities": []
  }
}
```

## The eight kinds

| Value | V1 status | Role | Constraints |
|---|---|---|---|
| `agent` | **Shipped** | Dispatches a turn to one registered agent executor. Default for any cell carrying `/spawn`, `@<agent>`, or plain text continuing the most-recent agent. | `bound_agent_id` required. |
| `markdown` | **Shipped** | Operator prose / notes; no agent, no execution. (= comment cell M1 from [BSP-005](../../notebook/BSP-005-cell-roadmap.md).) | `bound_agent_id` MUST be absent or null. |
| `scratch` | **Shipped** | Temporary operator workspace. Excluded from default ContextPacker output. | `bound_agent_id` SHOULD be null. May be promoted to another kind by overlay commit. |
| `checkpoint` | **Shipped** | Summarizes a contiguous range or section. Substitutes its summary for underlying turns when included in agent context. | SHOULD carry `summary_text` + `covers_cell_ids[]`. Operator-authored only in V1; AI-summarized → V2 ([KB-target §22.6](../../notebook/KB-notebook-target.md#226-checkpoint-trust-model)). |
| `tool` | **Reserved** | Operator-explicit tool invocation outside an agent's reasoning (future `/run tests` directive). | V1 directive parser does NOT recognize this kind. Agent-internal tool calls live in the parent turn — see [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md). |
| `artifact` | **Reserved** | Displays / lenses a single [ArtifactRef](artifact-ref.md) range. | V2+ — depends on streaming materializer ([KB-target §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming)). |
| `control` | **Reserved** | Notebook-level control directives as first-class cells (`/branch`, `/revert`, `/stop`). | V1 routes these through agent cells; reserved slot for V2+. |
| `native` | **Reserved** | Low-level instruction/runtime directive (`%notebook.inspect`, `%notebook.rebind`). | V2+ only. |

## Invariants

- **`kind` is required for V1 producers.** Pre-Issue-2 cells with no `kind` field default to `kind: "agent"` at load; the [MetadataWriter](../../notebook/BSP-002-conversation-graph.md#9-implementation-slices) writes the resolved value back on the next snapshot.
- **Reserved kinds are forward-compat markers.** V1 consumers receiving `tool | artifact | control | native` MUST preserve the cell verbatim, render inert (kind label visible), and dispatch nothing.
- **Unknown values are rejected.** Anything outside the eight values above triggers a `wire-failure` LogRecord ([RFC-006 §"Failure modes" W4](../../rfcs/RFC-006-kernel-extension-wire-format.md)).
- **`kind` enforces merge correctness.** [merge-cells](../operations/merge-cells.md) requires `c_a.kind == c_b.kind`. The typed enum is what makes this rule structural rather than heuristic.
- **Per-kind slot rules**: `markdown` MUST NOT carry `bound_agent_id`; `scratch` SHOULD have `bound_agent_id: null`; `checkpoint` SHOULD have `bound_agent_id: null` (operator-authored, V1).

## V1 vs V2+

- **V1**: ships `agent | markdown | scratch | checkpoint`. The other four kinds are reserved enum values only.
- **V2+**: activates `tool` (operator-explicit tool invocation), `artifact` (streaming materializer lens), `control` (first-class control cells), `native` (notebook-level runtime directives).

## See also

- [cell](cell.md) — the carrier of the kind field.
- [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md) — why agent-internal tool calls don't get their own cell.
- [operations/merge-cells](../operations/merge-cells.md) — uses `kind` as a precondition.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — pairs with this for the V1 cell taxonomy lock.
