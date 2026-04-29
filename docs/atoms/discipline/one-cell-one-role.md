# Discipline: one cell, one role

**Status**: discipline (V1 invariant)
**Source specs**: [KB-notebook-target.md §13.1](../../notebook/KB-notebook-target.md#131-one-cell-one-system-role) (one cell, one system role), [KB-notebook-target.md §22.1](../../notebook/KB-notebook-target.md#221-splitmerge-invariants) (provenance domains), [BSP-002 §13.4](../../notebook/BSP-002-conversation-graph.md#134-tool-calls-live-in-their-parent-turn-kb-target-03) (tool calls in parent turn)
**Related atoms**: [cell](../concepts/cell.md), [cell-kinds](../concepts/cell-kinds.md), [tool-call](../concepts/tool-call.md), [discipline/tool-calls-atomic](tool-calls-atomic.md), [discipline/zachtronics](zachtronics.md)

## The rule

**A cell has one [kind](../concepts/cell-kinds.md), one bound agent, one provenance domain.**

A cell does not multitask. It dispatches to one executor (or none), produces output of one role, and lives in one provenance lineage. Composition happens through neighboring cells, sections, bindings, and notebook order — not by overloading a single cell with many roles.

> A cell has one primary system role. Composition happens through neighboring cells, zones, bindings, and notebook order. (KB-target §13.1)

## The three "ones"

| One... | Concretely |
|---|---|
| **One kind** | `metadata.rts.cells[<id>].kind ∈ { agent | markdown | scratch | checkpoint }` in V1 (BSP-002 §13.2.1). Reserved kinds (tool / artifact / control / native) render inert; they don't dispatch. |
| **One bound agent** | `metadata.rts.cells[<id>].bound_agent_id` is one agent id (or `null` for non-dispatching cells). [merge-cells](../operations/merge-cells.md) refuses cross-agent merges (BSP-002 §13.2.3). |
| **One provenance domain** | All turns in the cell trace to one executor session — same `claude_session_id` lineage, same tool-vs-agent vs native vs markdown family (KB-target §22.1's "provenance domain"). |

## What this rules out

Concrete bad shapes the rule blocks:

- A cell that does `@alpha implement and @beta review in the same body`. Use two cells.
- A cell that mixes operator markdown prose with an agent dispatch (`/spawn` directive). Markdown cells are kind `markdown` with `bound_agent_id: null` per BSP-002 §13.2.2.
- A cell that mixes a checkpoint summary with new agent work. Checkpoint cells (`kind: checkpoint`, `bound_agent_id: null` per decision **D4**) are summaries; agent cells are dispatches.
- A cell that holds tool spans from two different sessions. (Tool spans live in the **parent turn**'s `spans[]` per BSP-002 §13.4 — they inherit the parent's session; this is automatic if cells aren't being hand-edited.)
- A cell that flips kind mid-flight (e.g., agent → checkpoint without going through [pin-exclude-scratch-checkpoint](../operations/pin-exclude-scratch-checkpoint.md)).

## What this rules in

- Each cell renders one decoration: agent badge + provider + status (BSP-002 §6 cell-as-agent-identity).
- [merge-cells](../operations/merge-cells.md) preconditions become enforceable: same kind, same agent, same session.
- [split-cell](../operations/split-cell.md) preconditions stay clean: a split that would create two cells of different roles (e.g., separating a tool result from its agent turn) is forbidden — both halves must remain valid single-role cells.
- The kernel's [discipline/tool-calls-atomic](tool-calls-atomic.md) rule has a clean home: tool calls live inside their parent agent turn's spans, not as orphan cells.

## Where the rule applies

- **[merge-cells](../operations/merge-cells.md) / [split-cell](../operations/split-cell.md)**: structural ops enforce the same-role precondition.
- **[promote-span](../operations/promote-span.md)**: produces a single-role cell (artifact or checkpoint per decision **D7**); never a hybrid.
- **[move-cell](../operations/move-cell.md)**: a cell carries its role across sections; relocation never changes its kind.
- **[continue-turn](../operations/continue-turn.md)**: appends a turn to the cell's bound agent; addressing a different agent forces a new cell.

## V1 vs V2+

- **V1**: hard one-role discipline. The reserved cell kinds (tool / artifact / control / native) render inert.
- **V2+**: lifts some kinds (e.g., `tool` cell for operator-explicit `/run tests` per BSP-002 §13.4.2). The discipline still holds — even tool cells dispatch to **one** registered device, not many.

## Why

Multi-role cells make every other invariant harder to enforce. Merge correctness (KB-target §22.1) depends on knowing the cell's role; ContextPacker filtering (BSP-008 / KB-target §0.6) depends on it; Inspect mode rendering depends on it. One cell, one role keeps the rest of the system enforceable.

It also keeps the operator's mental model honest: reading the notebook means reading a sequence of single-purpose tiles, not decoding combinator expressions.

## See also

- [cell](../concepts/cell.md) — the entity.
- [cell-kinds](../concepts/cell-kinds.md) — the V1 enum.
- [tool-call](../concepts/tool-call.md) — atomic; lives inside parent turn (does not violate the rule).
- [discipline/tool-calls-atomic](tool-calls-atomic.md) — sibling discipline.
- [discipline/zachtronics](zachtronics.md) — same family of "visible, simple roles."
