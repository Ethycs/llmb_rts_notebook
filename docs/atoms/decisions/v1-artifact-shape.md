# Decision: V1 ships the ArtifactRef shape; body inline, V2 streams

**Status**: decision (V1 lock-in, 2026-04-28)
**Source specs**: [KB-notebook-target.md §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming), [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256), [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms)
**Related atoms**: [concepts/artifact-ref](../concepts/artifact-ref.md), [concepts/blob](../concepts/blob.md), [decisions/v1-runframe-minimal](v1-runframe-minimal.md)

## The decision

**V1 ships the ArtifactRef shape; bodies are stored inline.** Per [KB-target §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming) and [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256), every artifact entry stored in `metadata.rts.zone.blobs.<sha256>` carries:

```jsonc
ArtifactRef: {
  id: string,                     // sha256 hash
  kind: string,                   // mime type (text/x-python, etc.)
  size: number,                   // size in bytes
  content_hash: string,           // sha256
  body: string                    // V1: inline (utf8 or base64). NEVER null.
}
```

V1 producers MUST populate `body` inline. V1 consumers MUST tolerate `body: null` from forward-version producers (and surface a "materialize via lens" affordance), but V1 producers themselves MUST NOT emit `null`.

V2+ adds `byte_index`, `line_index`, `semantic_index`, `loaded_windows`, `pinned_ranges`, `summaries`, plus the streaming materializer. **V2 is the version that legalizes `body: null`** when the artifact is externalized.

## Rationale

1. **Cell-side ArtifactRef references stay valid across V1→V2.** Per [KB-target §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming): the *shape* doesn't change between versions; only `body: null` becomes legal in V2. Cells that reference an artifact by `id` continue to resolve through the same field path. No migration touching cells is required.

2. **The shape unifies what BSP-002 Issue 1 had as two different things.** Issue 1 §8.2 stored blobs as `{ content, meta }`. Issue 2 amends to add `id, kind, size, content_hash, body` as top-level fields while preserving `meta`. The amendment is purely additive — Issue 1 readers see the new fields and ignore them; Issue 2 readers see both forms.

3. **No streaming infrastructure exists in V1.** A null `body` only makes sense if there's a materializer that can fetch the externalized blob on demand. V1 doesn't ship that. Storing `null` would mean "we lost the artifact"; storing inline guarantees retrieval is local.

4. **Convertibility invariant is preserved.** Per [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256), the directory-mirror layout splits the entry across `artifact.json`, `body` (its own file), and `meta.json`. Splitting `body` into a separate file means directory diffs don't re-emit large bodies — the V1 inline form already plans for the V2 file split.

## Operational consequences

| V1 behavior | Where enforced |
|---|---|
| Every blob entry MUST carry `id, kind, size, content_hash, body` | [BSP-002 §13.5.3 + §13.7 validation summary](../../notebook/BSP-002-conversation-graph.md) |
| `body` MUST be a string (utf8 or base64); MUST NOT be `null` | [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md) |
| `meta` block from BSP-002 Issue 1 (`mime`, `source`, `created_at`) preserved unchanged | [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md) |
| Consumers MUST tolerate `body: null` from forward producers and surface "artifact externalized — open lens to materialize" UI | [BSP-002 §13.7 validation](../../notebook/BSP-002-conversation-graph.md) |
| Cell-side references resolve via `id` (the sha256 hash) — no path through `body` | [concept/artifact-ref](../concepts/artifact-ref.md) |
| ContextPacker treats artifact bodies as opaque; it does not chunk or summarize them in V1 | [v1-contextpacker-walk](v1-contextpacker-walk.md) |

## V1 vs V2+

| | V1 | V2+ |
|---|---|---|
| `body` | Inline string, never null | May be null when externalized |
| Indexes | None | `byte_index`, `line_index`, `semantic_index` for streaming reads |
| Loading | Whole-blob-on-load | `loaded_windows[]` + `pinned_ranges[]` + viewport-driven materialization |
| Summaries | None — `meta.source` and `kind` only | `summaries[]` for partial-view cell rendering |
| RunFrame `artifact_windows[]` | NOT EMITTED ([v1-runframe-minimal](v1-runframe-minimal.md)) | Records which windows were materialized for the run |

## See also

- [concepts/artifact-ref](../concepts/artifact-ref.md) — the concept this constrains.
- [concepts/blob](../concepts/blob.md) — content-addressed storage; ArtifactRef references it.
- [decisions/v1-runframe-minimal](v1-runframe-minimal.md) — `artifact_windows[]` deferred is part of the same V2-streaming bundle.
- [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256) — the schema source.
- [PLAN-atom-refactor.md §4](../../notebook/PLAN-atom-refactor.md#4-the-24-v1-decisions-to-land-in-decisions-atoms) — the 24-row decision table.
