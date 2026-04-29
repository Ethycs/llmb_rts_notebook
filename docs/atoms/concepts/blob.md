# Blob

**Status**: V1 shipped (content-addressed; body inline; carries the V1 [ArtifactRef](artifact-ref.md) shape)
**Source specs**: [BSP-002 §8.2](../../notebook/BSP-002-conversation-graph.md#82-schema) (storage layout), [BSP-002 §13.5.3](../../notebook/BSP-002-conversation-graph.md#1353-artifactref-shape-on-metadatartszoneblobssha256-kb-target-09), [KB-notebook-target.md §19](../../notebook/KB-notebook-target.md#19-persistence-model) (blobs in the persistence model)
**Related atoms**: [artifact-ref](artifact-ref.md), [zone](zone.md), [span](span.md)

## Definition

A **blob** is one entry in the content-addressed store at `metadata.rts.zone.blobs.<sha256>`. Blobs hold the body of every large output (file, log, diff, generated artifact) the notebook needs to persist. The outer key is the SHA-256 of the body — two writes of the same content collapse to one entry. Each blob entry carries the V1 [ArtifactRef](artifact-ref.md) shape (`id`, `kind`, `size`, `content_hash`, `body`, plus a `meta` sub-object). Cells point at blobs via the artifact-ref shape; the blob is the storage layer underneath.

## Schema (V1 — same shape as ArtifactRef)

```jsonc
// metadata.rts.zone.blobs.<sha256>
{
  "id":           "sha256-abc123...",   // == outer key == content_hash
  "kind":         "text/x-python",      // MIME-like type tag (mirrors meta.mime)
  "size":         4912,                 // bytes
  "content_hash": "sha256-abc123...",   // == id
  "body":         "<utf8 or base64>",   // V1: ALWAYS inline. V2: null when externalized.
  "meta": {
    "mime":       "text/x-python",
    "source":     "tool:read_file",
    "size_bytes": 4912,
    "created_at": "..."
  }
}
```

## Invariants

- **Content-addressed.** Outer key, `id`, and `content_hash` are equal — all the SHA-256 of `body`. Two identical writes collapse.
- **`body` MUST be inline in V1.** Producers MUST NOT emit `body: null` in V1; receivers SHOULD tolerate `body: null` from forward-version producers (V2+ externalized artifacts) and surface "artifact externalized — open lens to materialize" in the cell UI.
- **Per-zone storage.** Blobs live under one [zone](zone.md). There is no cross-zone blob sharing in V1.
- **Round-trip-safe to directory layout.** Per [BSP-002 §8.1](../../notebook/BSP-002-conversation-graph.md#81-convertibility-invariant), the JSON form flattens to `blobs/<hash>/{body, meta.json, artifact.json}`. `body` lives in its own file so directory diffs don't re-emit large payloads.
- **Carries the V1 ArtifactRef shape.** [ArtifactRef](artifact-ref.md) and the blob entry are the same shape; cells reference blobs via the `id` (= `sha256-...`).
- **`meta` preserves the Issue 1 fields unchanged** (`mime`, `source`, `size_bytes`, `created_at`). Issue 2's additive top-level fields (`id`, `kind`, `size`, `content_hash`, `body`) sit alongside.
- **Append/replace via `apply_overlay_commit` writers**, not direct edit. Blobs are part of the persisted snapshot; the writer ([BSP-003](../../notebook/PLAN-atom-refactor.md#7-operator-follow-ups-landing-in-this-refactor)) records the write through an intent.

## V1 vs V2+

- **V1**: 5 top-level fields + `meta`; body always inline; no streaming. Storage matches the existing `metadata.rts.zone.blobs` semantics.
- **V2+**: `body: null` permitted; the streaming materializer adds the indices and windows ([KB-target §16](../../notebook/KB-notebook-target.md#16-artifact-streaming) — `byte_index`, `line_index`, `semantic_index`, `loaded_windows`, `pinned_ranges`, `summaries`). The blob outer shape is unchanged; new fields are additive.

## See also

- [artifact-ref](artifact-ref.md) — the V1 reference shape, mirroring this storage shape.
- [zone](zone.md) — blobs live under one zone.
- [span](span.md) — `output.kind: "artifact_ref"` spans point at blobs.
- [decisions/v1-artifact-shape](../decisions/v1-artifact-shape.md) — the V1 inline-body rule.
- [operations/promote-span](../operations/promote-span.md) — promoting a span may register a new blob.
