# Protocol: Family B — Layout

**Status**: `protocol` (V1 shipped, RFC-006 v2)
**Family**: RFC-006 Family B (layout state)
**Direction**: bidirectional — `layout.update` kernel → extension; `layout.edit` extension → kernel
**Source specs**: [RFC-006 §4](../../rfcs/RFC-006-kernel-extension-wire-format.md#4--family-b-layout), [RFC-005 §`metadata.rts.layout`](../../rfcs/RFC-005-llmnb-file-format.md#metadatartslayout--layout-tree)
**Related atoms**: [contracts/metadata-writer](../contracts/metadata-writer.md), [contracts/messaging-router](../contracts/messaging-router.md), [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md)

## Definition

Family B carries the **layout tree** — the operator-visible workspace arrangement (zones, panels, render hints) — between kernel and extension over the `llmnb.rts.v2` Comm. The kernel is the single logical writer. `layout.update` ships an authoritative full snapshot; `layout.edit` is an operator-driven mutation request that the kernel echoes back as a fresh `layout.update` (or unchanged, if rejected). V1 ships full snapshots only — JSON Patch is reserved for V1.5.

## Wire shape

Both messages travel inside the [thin Comm envelope](../../rfcs/RFC-006-kernel-extension-wire-format.md#3--comm-envelope-thin) (`{type, payload, correlation_id?}`).

### `layout.update` (kernel → extension)

```jsonc
{
  "type": "layout.update",
  "payload": {
    "snapshot_version": 17,
    "tree": {
      "id":           "root",
      "type":         "workspace",
      "render_hints": {},
      "children":     [ /* zones, panels — same shape as metadata.rts.layout.tree */ ]
    }
  }
}
```

Receivers MUST replace their in-memory copy atomically.

### `layout.edit` (extension → kernel)

```jsonc
{
  "type": "layout.edit",
  "payload": {
    "operation":  "add_zone | remove_node | move_node | rename_node | update_render_hints",
    "parameters": {
      "node_id":       "...",
      "new_parent_id": "...",   // for move_node
      "new_name":      "...",   // for rename_node
      "render_hints":  { },     // for update_render_hints
      "node_spec":     { }      // for add_zone
    }
  }
}
```

Kernel applies, then echoes the new state via `layout.update`. Kernel MAY reject by emitting an unchanged `layout.update`. There is no synchronous response — the new `layout.update` is the acknowledgment.

## Schema-version handshake

The Comm target name `llmnb.rts.v2` IS the major-version handshake (RFC-006 §2). A v3 kernel registers `llmnb.rts.v3`; a v2 extension refuses to open a v3 Comm. Within v2.x, additive changes (new `operation` enum values, new `render_hints` keys) are minor; consumers MUST ignore unknown fields.

## Error envelope

Failures surface as RFC-006 §"Failure modes" rows: W1 (Comm-open mismatch), W4 (unknown `operation`), W5 (missing `payload`), W11 (size limit). Each is log + discard. There is no in-band error reply — the absence of a follow-up `layout.update` after a `layout.edit` IS the rejection signal in V1.

## V1 vs V2+

- **V1**: full snapshots only; one logical writer (the kernel).
- **V1.5**: JSON-Patch wire mode (saves bandwidth on large layouts).
- **V2+**: per-operator views may diverge from the canonical tree (multi-operator V3 work).

## See also

- [contracts/metadata-writer](../contracts/metadata-writer.md) — owns `apply_layout_edit` and emits `layout.update` snapshots.
- [contracts/messaging-router](../contracts/messaging-router.md) — extension-side dispatch by `type`.
- [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md) — sibling Family F carries the same `tree` inside the full `metadata.rts` snapshot.
- [decisions/v1-flat-sections](../decisions/v1-flat-sections.md) — flat-overlay invariant constrains tree shape in V1.
