# Zone

**Status**: V1 shipped (kernel-side session id; one zone per `.llmnb` file)
**Source specs**: [BSP-002 §1](../../notebook/BSP-002-conversation-graph.md#1-scope) (axiom: zone = notebook), [BSP-002 §2.3](../../notebook/BSP-002-conversation-graph.md#23-zone), [BSP-002 §13.1](../../notebook/BSP-002-conversation-graph.md#131-section-as-overlay-graph-concept) (zone vs section reconciliation), [KB-notebook-target.md §0.1](../../notebook/KB-notebook-target.md#01-naming-reconciliation)
**Related atoms**: [section](section.md), [turn](turn.md), [agent](agent.md)

## Definition

A **zone** is the kernel-side session identifier — one notebook = one zone, one `.llmnb` file = one `zone_id`. The zone IS the connected turn DAG: all [turns](turn.md), [agents](agent.md), [overlay commits](overlay-commit.md), [run-frames](run-frame.md), [context-manifests](context-manifest.md), and [blobs](blob.md) for one notebook live under one zone. The zone is the only "conversation" entity in BSP-002's data model — there is no sub-zone or cross-zone concept in V1.

The zone is **distinct from the operator-side [section](section.md)**. KB-target's body uses "Zone" for both concepts; V1 reconciles by keeping `zone_id` for the kernel-side session and renaming the operator-narrative concept to **Section**. The two coexist without ambiguity: kernel `zone_id` is per-file; operator `section_id` is per-narrative-range within one file.

## Schema

```jsonc
// metadata.rts.zone
{
  "zone_id":        "00000000-0000-0000-0000-...",  // UUID; immutable for the file's lifetime
  "schema_version": "1.1.0",
  "created_at":     "...",
  "agents":         { ... },     // per-agent storage, keyed by agent_id
  "turns":          [...],       // (in Issue 1 schema) — per-agent in §8.2 directory layout
  "blobs":          { ... },     // content-addressed; see blob atom
  "ordering":       [...],       // linear render order over (agent_id, turn_id) pairs
  "sections":       [...],       // operator-side narrative ranges; see section atom
  "overlay":        { ... }      // overlay commits + refs; see overlay-commit atom
}
```

The `llmnb.zone_id` OTLP attribute on Family A spans ([RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md)) carries this same `zone_id`.

## Invariants

- **One `.llmnb` file = one zone.** Immutable for the file's lifetime. The zone is the file's identity from the kernel's perspective.
- **No sub-zone or cross-zone concept in V1.** Cross-notebook agents, cross-notebook turns, cross-notebook sections do not exist. Reserved for V2+ if needed.
- **Zone is shared by all agents in the file.** Every agent in the notebook is per-zone; the zone is the only conversation. Multiple agents share the [turn](turn.md) DAG; each has its own [agent](agent.md) ref into it.
- **Notebook is single-truth, agent claude-sessions are caches.** When a session falls behind the zone's truth (another agent contributed a turn the cache doesn't know about), the kernel reconciles via the cross-agent context handoff per [BSP-002 §4.6](../../notebook/BSP-002-conversation-graph.md#46-cross-agent-context-handoff).
- **`zone_id` keeps its meaning across all wire and storage layers.** `llmnb.zone_id` on Family A spans, `metadata.rts.zone.zone_id` in the file. RFC-006 wire impact of the Section rename is **additive only** — no existing attribute changes meaning; one new optional `llmnb.section_id` attribute is reserved.
- **Distinct from [section](section.md).** Kernel-side: zone = notebook session, immutable. Operator-side: section = narrative range across cells, mutable, multiple per notebook.
- **Convertibility-safe.** The directory-mirror layout ([BSP-002 §8.1](../../notebook/BSP-002-conversation-graph.md#81-convertibility-invariant)) flattens `zone_id` to `metadata.rts.json` at the top level; per-agent + per-blob storage flattens beneath.

## V1 vs V2+

- **V1**: one zone per file; no cross-zone concept; `zone_id` immutable.
- **V2+**: no schema change planned. Cross-notebook concepts (if they arrive) would NOT extend the zone — they would compose multiple zones via a higher-level container.

## See also

- [section](section.md) — the operator-side concept this is NOT.
- [agent](agent.md) — agents are per-zone.
- [turn](turn.md) — the DAG lives within one zone.
- [blob](blob.md) — `zone.blobs.<sha256>` is per-zone content storage.
- [overlay-commit](overlay-commit.md) — `zone.overlay.*` is per-zone history.
