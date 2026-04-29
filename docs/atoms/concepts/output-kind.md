# Output kind

**Status**: V1 shipped (the OTLP attribute ships and is consumed for filtering/telemetry; lens UI is V2)
**Source specs**: [BSP-002 §13.5.2](../../notebook/BSP-002-conversation-graph.md#1352-otlp-attribute-llmnboutputkind-kb-target-08--v1-tag-v2-lenses), [KB-notebook-target.md §0.8](../../notebook/KB-notebook-target.md#08-typed-outputs--v1-ships-the-tag-v2-ships-lenses), [KB-notebook-target.md §15](../../notebook/KB-notebook-target.md#15-typed-outputs)
**Related atoms**: [span](span.md), [artifact-ref](artifact-ref.md), [cell-kinds](cell-kinds.md)

## Definition

The **output kind** is the typed-output enum carried as the OTLP attribute `llmnb.output.kind` on output [spans](span.md). It tells receivers what KIND of content the span carries (prose, code, diff, decision, etc.) so the V2 lens UI ("show decisions only", "show failed tests") can filter on the tag without heuristic text parsing. V1 ships only the tag — producers SHOULD emit it where the kind is known; V1 consumers MUST tolerate its absence (treat as untyped output). V2 ships the lens UI on top of the tag stream.

## The 12 values

```text
prose          free-form agent output; the default for most agent_emit spans
code           code blocks (typed source — language hint elsewhere)
diff           a diff body (unified or otherwise; not a patch with apply intent)
patch          a patch with apply intent (proposes an edit to a file)
decision       a recorded decision the operator should review/accept/reject
plan           an outline of intended steps before execution
artifact_ref   a reference to an ArtifactRef (the body lives in zone.blobs)
test_result    the structured outcome of a test run
diagnostic     a warning, error, or other diagnostic from the agent or a tool
checkpoint     a summary intended to substitute for an underlying turn range
question       an open question the agent is asking the operator
warning        a non-fatal advisory the operator should see
```

These are the values KB-target §15 enumerated, as ratified verbatim into BSP-002 §13.5.2.

## Wire shape

```jsonc
// span.attributes (OTLP)
{
  "llmnb.run_type":    "agent_emit",
  "llmnb.agent_id":    "alpha",
  "llmnb.cell_id":     "vscode-notebook-cell:.../#def",
  "llmnb.output.kind": "decision"   // one of the 12 values above
}
```

The attribute is **additive** on the wire. RFC-006 §1's "Mandatory attributes per run" is unchanged; this is one more optional situational attribute. Existing consumers that don't read it continue to work.

## Invariants

- **Tag is per-span, not per-turn.** A single agent turn may emit a `plan` span, then several `code` spans, then a `decision` span. Each span carries its own `llmnb.output.kind`.
- **V1 producers SHOULD emit when the kind is known.** Best-effort: a span the kernel can't classify simply omits the attribute.
- **V1 consumers MUST tolerate absence.** Missing → treat as untyped output. The renderer falls back to the default lens.
- **Unknown values are tolerated as untyped.** Receivers seeing `llmnb.output.kind: "<future-value>"` from a forward-version producer MUST treat the span as untyped rather than reject it. The 12-value list is V1-normative, but the field accepts forward-compat values.
- **Drives [promote-span](../operations/promote-span.md).** Decision D7 maps span kinds to target cell-kinds: `propose_edit` → `artifact`; agent prose → `artifact`; `report_completion` → `checkpoint`. The `output.kind` is one of the inputs the promoter uses.
- **Distinct from cell-kind.** The [cell-kinds](cell-kinds.md) enum types the CELL (`agent | markdown | scratch | checkpoint | ...`); `output.kind` types one SPAN within that cell's turn.

## V1 vs V2+

- **V1**: ship the tag on emitted spans; no lens UI. The attribute round-trips through the wire ([RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md)) and is recorded in the immutable span record.
- **V2+**: lens UI filters spans by `llmnb.output.kind` ("show decisions only"); operator-defined custom lenses; new values may be added (the field accepts forward-compat values per the invariant above).

## See also

- [span](span.md) — the carrier of `llmnb.output.kind`.
- [operations/promote-span](../operations/promote-span.md) — uses the kind to infer the new cell's [cell-kind](cell-kinds.md) (decision D7).
- [artifact-ref](artifact-ref.md) — `output.kind: "artifact_ref"` points at one.
- [decisions/v1-output-kind-tag](../decisions/v1-output-kind-tag.md) — V1 ships tag, V2 ships lens.
