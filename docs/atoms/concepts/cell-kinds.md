# Cell kinds

**Status**: V1 shipped (kind discriminator is the `@@<magic>` cell-magic line at top of cell text, S5.0 commit `336a6c7` / submodule `e6620db`; 4 kinds active, 4 reserved; markdown=no-badge and promoted-suffix render rules now enforced on the X-EXT side, S1 / commit `26ac581`)
**Source specs**: [BSP-002 §13.2](../../notebook/BSP-002-conversation-graph.md#132-cell-kinds-typed-enum-kb-target-04), [BSP-005 §S5.0](../../notebook/BSP-005-cell-roadmap.md), [PLAN-S5.0-cell-magic-vocabulary.md §3.3](../../notebook/PLAN-S5.0-cell-magic-vocabulary.md#33-cell_magics-registry--vendorllmkernelllm_kernelmagic_registrypy-new-150-loc), [KB-notebook-target.md §0.4](../../notebook/KB-notebook-target.md#04-cell-kinds-typed-in-v1), [KB-notebook-target.md §13.1](../../notebook/KB-notebook-target.md) (the eight-kind taxonomy)
**Related atoms**: [cell](cell.md), [magic](magic.md), [operations/parse-cell](../operations/parse-cell.md), [tool-call](tool-call.md), [artifact-ref](artifact-ref.md)

## Definition

The **cell-kinds enum** is the typed kind discriminator on every cell, declared post-S5.0 by the `@@<magic>` cell-magic line at the top of `cells[<id>].text` and enforced at parse time so that downstream rules (merge correctness, ContextPacker filtering, render dispatch) can branch structurally instead of guessing from cell content. Eight kinds exist in the spec; V1 ships four; four are reserved for V2+ but their slot exists in the registry from day one. A plain-prose cell with no `@@<magic>` line defaults to `kind="agent"` bound to the current agent.

## Schema

Per S5.0, the kind is *parse-derived*: the operator declares it via the cell-magic line at the top of `cells[<id>].text`, and the writer's `cell_view(cell_id)` accessor calls [parse-cell](../operations/parse-cell.md) to surface the typed value. The cell-magic-to-kind map (per `magic_registry.CELL_MAGICS`):

| `@@<magic>` line | `kind` |
|---|---|
| `@@agent <id>` | `agent` |
| `@@spawn <id> [args]` | `spawn` (operator-explicit spawn cell; emits an `agent_spawn` envelope on first run) |
| `@@markdown` | `markdown` |
| `@@scratch` | `scratch` |
| `@@checkpoint [covers:[…]]` | `checkpoint` |
| `@@endpoint <name> …` | `endpoint` (declarative endpoint cell) |
| `@@compare endpoints:…` | `compare` (V1.5+ stub) |
| `@@section <name>` | `section` (S5.5 stub) |
| `@@tool` / `@@artifact` / `@@native` | reserved for V2+; round-trip identically |

The `@@break` line is not a kind — it is the cell *separator* consumed by [split-at-breaks](../operations/split-at-breaks.md).

Example canonical text:

```
@@spawn alpha task:"design recipe schema"
@pin

(operator's body text)
```

After parse: `kind="spawn"`, `args={"agent_id": "alpha", "task": "design recipe schema"}`, `flags={"pinned"}`, `body=` everything after the magics.

## The eight kinds

| Value | V1 status | Role | Constraints |
|---|---|---|---|
| `agent` | **Shipped** | Dispatches a turn to one registered agent executor. Default for any cell carrying `@@agent <id>`, plain prose continuing the current binding, or the legacy `@<id>:` shorthand. | `bound_agent_id` required. |
| `markdown` | **Shipped** | Operator prose / notes; no agent, no execution. (= comment cell M1 from [BSP-005](../../notebook/BSP-005-cell-roadmap.md).) | `bound_agent_id` MUST be absent or null. |
| `scratch` | **Shipped** | Temporary operator workspace. Excluded from default ContextPacker output. | `bound_agent_id` SHOULD be null. May be promoted to another kind by overlay commit. |
| `checkpoint` | **Shipped** | Summarizes a contiguous range or section. Substitutes its summary for underlying turns when included in agent context. | SHOULD carry `summary_text` + `covers_cell_ids[]`. Operator-authored only in V1; AI-summarized → V2 ([KB-target §22.6](../../notebook/KB-notebook-target.md#226-checkpoint-trust-model)). |
| `tool` | **Reserved** | Operator-explicit tool invocation outside an agent's reasoning (future `/run tests` directive). | V1 directive parser does NOT recognize this kind. Agent-internal tool calls live in the parent turn — see [discipline/tool-calls-atomic](../discipline/tool-calls-atomic.md). |
| `artifact` | **Reserved** | Displays / lenses a single [ArtifactRef](artifact-ref.md) range. | V2+ — depends on streaming materializer ([KB-target §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming)). |
| `control` | **Reserved** | Notebook-level control directives as first-class cells (`/branch`, `/revert`, `/stop`). | V1 routes these through agent cells; reserved slot for V2+. |
| `native` | **Reserved** | Low-level instruction/runtime directive (`%notebook.inspect`, `%notebook.rebind`). | V2+ only. |

## Invariants

- **`kind` is parse-derived from `text`.** A cell whose text starts with no `@@<cell_magic>` defaults to `kind: "agent"` (with `kind_was_default=True` on the [ParsedCell](../operations/parse-cell.md)). Pre-S5.0 records carrying explicit `kind` fields are migrated by `metadata_writer.migrate_cells_to_canonical_text` on first save after upgrade.
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
