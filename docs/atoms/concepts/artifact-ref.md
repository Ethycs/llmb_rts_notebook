# ArtifactRef

**Status**: V1 shipped (shape only; `body` always inline; streaming materializer + windows V2+)
**Source specs**: [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256-kb-target-09), [KB-notebook-target.md §0.9](../../notebook/KB-notebook-target.md#09-artifacts--v1-ships-the-shape-v2-ships-streaming), [KB-notebook-target.md §16](../../notebook/KB-notebook-target.md#16-artifact-streaming)
**Related atoms**: [blob](blob.md), [cell-kinds](cell-kinds.md), [span](span.md)

## Definition

An **ArtifactRef** is the V1 shape of a content-addressed reference to a large output (file, log, diff, generated artifact) stored under [`metadata.rts.zone.blobs.<sha256>`](../../notebook/BSP-002-conversation-graph.md#82-schema). Cells point to artifacts; artifact bodies live in the [blob](blob.md) store keyed by their content hash. V1 stores `body` inline (matches the existing blob semantics); V2 will permit `body: null` when the artifact is externalized via the streaming materializer. The cell-side reference shape doesn't change between V1 and V2 — only `body: null` becomes legal — so cells written today survive the V1→V2 transition without migration.

## Schema (V1)

```jsonc
// metadata.rts.zone.blobs.<sha256>
{
  "id":           "sha256-abc123...",        // content hash; matches outer key
  "kind":         "text/x-python",           // MIME-like type tag
  "size":         4912,                      // bytes
  "content_hash": "sha256-abc123...",        // == id
  "body":         "<utf8 or base64>",        // V1: ALWAYS inline. V2: null when externalized.
  "meta": {
    "mime":       "text/x-python",
    "source":     "tool:read_file",
    "created_at": "..."
  }
}
```

## Invariants

- **`body` MUST NOT be `null` in V1.** Producers always inline. Receivers seeing `body: null` from a forward-version producer SHOULD render "artifact externalized — open lens to materialize" and treat it as forward-compat.
- **Content-addressed.** `id` and `content_hash` are equal and match the outer object key under `zone.blobs`. Two writes of the same content collapse to one entry.
- **Convertibility-safe.** Per [BSP-002 §8.1](../../notebook/BSP-002-conversation-graph.md#81-convertibility-invariant), the JSON layout flattens to a directory: `blobs/<hash>/{body, meta.json, artifact.json}`. `body` lives in its own file so directory diffs don't re-emit large bodies.
- **Five top-level fields are normative.** `id`, `kind`, `size`, `content_hash`, `body` are the V1 ArtifactRef contract. `meta` is preserved unchanged from Issue 1 with its existing children.
- **Cell-side references stay stable across V1→V2.** A cell pointing at `sha256-abc123...` resolves to the same artifact whether the body is inline (V1) or externalized (V2). Only the body-loading path changes.
- **Mirrored in [RFC-005](../../rfcs/RFC-005-llmnb-file-format.md).** Op-3 of [the atom-refactor plan](../../notebook/PLAN-atom-refactor.md#7-operator-follow-ups-landing-in-this-refactor) calls for RFC-005 to link to this atom; the wire shape and storage shape stay aligned.

## V1 vs V2+

- **V1**: 5 fields; `body` inline; no streaming. The `artifact` [cell-kind](cell-kinds.md) is enum-reserved but inactive (no streaming materializer to point at yet).
- **V2+**: `body: null` permitted. Adds `byte_index`, `line_index`, `semantic_index`, `loaded_windows[]`, `pinned_ranges[]`, `summaries[]` per [KB-target §16](../../notebook/KB-notebook-target.md#16-artifact-streaming). The `artifact` cell-kind activates with the streaming materializer; cells become portals (viewport → range resolver → window fetch → renderer).

## See also

- [blob](blob.md) — the storage layer this shape lives in.
- [cell-kinds](cell-kinds.md) — `artifact` kind is reserved for V2 streaming display.
- [operations/promote-span](../operations/promote-span.md) — promotes an artifact span into an addressable cell.
- [decisions/v1-artifact-shape](../decisions/v1-artifact-shape.md) — why V1 ships only the shape.
- [span](span.md) — `output.kind: "artifact_ref"` spans carry pointers to ArtifactRefs.
