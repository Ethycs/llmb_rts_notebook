# Protocol: Family F — Notebook metadata (bidirectional)

**Status**: `protocol` (V1 shipped, RFC-006 v2.0.2)
**Family**: RFC-006 Family F (`metadata.rts` envelope)
**Direction**: bidirectional, discriminated by `mode` — `snapshot` and `patch` (V1.5+) flow kernel → extension; `hydrate` flows extension → kernel; the kernel's `hydrate_complete` `snapshot` flows kernel → extension
**Source specs**: [RFC-006 §8](../../rfcs/RFC-006-kernel-extension-wire-format.md#8--family-f-notebook-metadata-bidirectional-in-v202), [RFC-005 §"Persistence strategy"](../../rfcs/RFC-005-llmnb-file-format.md#persistence-strategy-who-writes-the-file)
**Related atoms**: [contracts/metadata-writer](../contracts/metadata-writer.md), [contracts/metadata-applier](../contracts/metadata-applier.md), [contracts/drift-detector](../contracts/drift-detector.md), [protocols/family-a-otlp-spans](family-a-otlp-spans.md)

## Definition

Family F is the **persistence wire**. The kernel is the single logical writer of `metadata.rts`; the extension is the single physical reader/writer of `.llmnb` files. Family F flows `metadata.rts` between the two so VS Code's normal save flow can persist what the kernel produced. The bidirectionality (added v2.0.2) is required because the kernel cannot read `.llmnb` directly — on file-open, the extension parses the file and ships the persisted `metadata.rts` to the kernel for state hydration.

## Wire shape

The single message type, discriminated by `mode`:

```jsonc
{
  "type": "notebook.metadata",
  "payload": {
    "mode":             "snapshot | patch | hydrate",
    "snapshot_version": 42,
    "snapshot":         { /* full metadata.rts per RFC-005 — present when mode != "patch" */ },
    "patch":            [ /* RFC 6902 ops — V1.5+ only */ ],
    "trigger":          "save | shutdown | timer | end_of_run | open | hydrate_complete"
  }
}
```

### Direction by mode

| `mode`         | Direction              | Trigger value           |
|---|---|---|
| `snapshot`     | kernel → extension     | `save | shutdown | timer | end_of_run | hydrate_complete` |
| `patch`        | bidirectional, V1.5+   | (V1: MUST NOT emit; reject inbound) |
| `hydrate`      | extension → kernel     | `open` (file-open path) |

## Hydrate request/response

The extension's `hydrate` envelope is request-shaped:

1. Extension parses `.llmnb`, extracts `metadata.rts`, ships `mode: "hydrate"` `trigger: "open"`.
2. Kernel: calls `MetadataWriter.hydrate(snapshot)` idempotently → drives `DriftDetector.compare(...)` → respawns agents from `config.recoverable.agents[]` via `AgentSupervisor.respawn_from_config(...)`.
3. Kernel emits a confirmation `mode: "snapshot"` `trigger: "hydrate_complete"` carrying the post-hydrate state, within 10 seconds.
4. Extension expects the confirmation; on timeout, surfaces "kernel failed to hydrate" and treats agents as not-respawned.

The kernel processes **at most one** `hydrate` envelope per session. A second is rejected with a `wire-failure` LogRecord (RFC-006 §9 "Hydrate exclusivity").

## Schema-version handshake

Comm target name `llmnb.rts.v2` is the major-version handshake for the wire envelope. The inner `snapshot.schema_version` is governed by RFC-005. Major-version mismatch on the inner snapshot raises W7 (kernel stops emitting Family F until resolved).

## Error envelope

W7 (inner schema major mismatch — reject + upgrade banner), W8 (non-monotonic `snapshot_version` — log + discard, retain current state), W11 (oversized — blob-store via RFC-005 §F13). V1 receivers MUST reject inbound `mode: "patch"` with a `wire-failure` LogRecord; V1 senders MUST NOT emit `"patch"`. V1 receivers MUST reject `selectors` (V1.5 partial-hydrate) with `wire-failure`.

## Cadence (kernel-emitted)

Per RFC-005 §"Snapshot triggers": (1) operator save, (2) clean shutdown, (3) periodic timer (30s while dirty), (4) end of run (closed span lands in event_log).

## V1 vs V2+

- **V1**: `snapshot` and `hydrate` modes only; full snapshots (no patches); kernel processes ≤1 hydrate per session.
- **V1.5**: `patch` mode (RFC 6902); `selectors` field for partial hydrate.
- **V2.1**: `notebook.metadata.ack` extension → kernel for save acknowledgment (currently fire-and-forget).

## See also

- [contracts/metadata-writer](../contracts/metadata-writer.md) — kernel side: `hydrate(snapshot)`, `snapshot(trigger=...)` emission.
- [contracts/metadata-applier](../contracts/metadata-applier.md) — extension side: applies via `vscode.NotebookEdit.updateNotebookMetadata`.
- [contracts/drift-detector](../contracts/drift-detector.md) — invoked during `hydrate` to populate `drift_log`.
- [protocols/family-a-otlp-spans](family-a-otlp-spans.md) — closed Family A spans round-trip into Family F's `event_log.runs[]`.
