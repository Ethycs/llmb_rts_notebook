# Decision: V1 ships the output-kind tag; V2 ships lenses

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [KB-notebook-target.md §0.8](../../notebook/KB-notebook-target.md#08-typed-outputs--v1-ships-the-tag-v2-ships-lenses), [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/output-kind](../concepts/output-kind.md), [concepts/span](../concepts/span.md)

## The decision

**V1 ships the `llmnb.output.kind` OTLP attribute. V2 ships the lens UI** that filters spans by it. Per [KB-target §0.8](../../notebook/KB-notebook-target.md#08-typed-outputs--v1-ships-the-tag-v2-ships-lenses) and [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses):

Every output [span](../concepts/span.md) emitted on Family A SHOULD carry:

```
llmnb.output.kind ∈ {
  prose | code | diff | patch | decision | plan | artifact_ref
  | test_result | diagnostic | checkpoint | question | warning
}
```

V1 producers SHOULD emit it; V1 consumers MUST tolerate its absence (treat as untyped output). V2 ships the operator UI ("show decisions only", "show failed tests", "show open questions") that filters on the tag.

## Rationale

1. **The tag is cheap; the lens is expensive.** Tagging a span costs one OTLP attribute write at emission time. Building the lens UI requires per-cell rendering modes, filter chips, persistence of operator-selected views, and undo/redo. The tag alone gets us the data; the UI is iteration.

2. **Capture-without-consume.** Per [Engineering Guide §11.4 silent drops](../../../Engineering_Guide.md#114-silent-drops): if V1 doesn't tag, V2 can't retroactively filter the V1 corpus. Tag everything now; consume later. Replay from `.llmnb` files written under V1 will surface tagged spans to V2's lens immediately.

3. **Wire-additive only.** [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses) confirms: RFC-006 §1's mandatory attributes don't change; this is one new optional attribute. No existing wire consumer breaks.

4. **Per [Engineering Guide §11.3](../../../Engineering_Guide.md#113-premature-abstraction)**: build the lens UI when there's enough V1 corpus to inform what filters operators actually want. Right now we only know the 12-value enum; we don't know if "decision" is the most-clicked filter or if operators want "decision + plan" combos.

## Operational consequences

| Producer side | Behavior |
|---|---|
| Output spans for prose responses | `llmnb.output.kind: "prose"` |
| Output spans containing code blocks | `llmnb.output.kind: "code"` |
| Output spans containing diff/patch text | `llmnb.output.kind: "diff"` or `"patch"` |
| Output spans whose body announces a decision | `llmnb.output.kind: "decision"` |
| Output spans naming a plan | `llmnb.output.kind: "plan"` |
| Tool-result spans surfacing artifact refs | `llmnb.output.kind: "artifact_ref"` |
| Test-result tool spans | `llmnb.output.kind: "test_result"` |
| Diagnostic / log spans | `llmnb.output.kind: "diagnostic"` |
| Operator-authored summary cells emitting checkpoint spans | `llmnb.output.kind: "checkpoint"` |
| Spans phrasing an open question | `llmnb.output.kind: "question"` |
| Spans flagging a risk/warning | `llmnb.output.kind: "warning"` |
| Span where the kind is unknown | MAY omit the attribute |

| Consumer side | Behavior |
|---|---|
| V1 renderer | Tolerates absence (renders untyped). Stores the attribute round-trip-intact in `metadata.rts`. |
| V2 lens UI | Filters spans by attribute value; supports multi-select |
| V2 historical replay | Re-renders V1-written `.llmnb` files under the new lens |

## V1 vs V2+

| | V1 | V2+ |
|---|---|---|
| Wire | Tag SHOULD be emitted | Tag SHOULD be emitted (unchanged) |
| Schema | Optional OTLP attribute | Optional OTLP attribute (unchanged) |
| Operator UI | None — spans render untyped | Lens UI — "show decisions only" etc. |
| Replay | V1 files round-trip with tag intact | V2 lens consumes V1 files seamlessly |
| Consumer requirement | MUST tolerate absence | MUST tolerate absence (unchanged) |

## See also

- [concepts/output-kind](../concepts/output-kind.md) — the concept this constrains, with the 12-value enum.
- [concepts/span](../concepts/span.md) — the OTLP span this attribute attaches to.
- [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses) — the wire amendment.
- [KB-target §15](../../notebook/KB-notebook-target.md#15-typed-outputs) — the lens motivation.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
