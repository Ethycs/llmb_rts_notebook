# Contract: NotebookMetadataApplier (extension)

**Status**: `contract` (V1 shipped — `mode: "snapshot"` path; `mode: "patch"` is rejected per V1.5+ deferral)
**Module**: `extension/src/notebook/metadata-applier.ts` — `class NotebookMetadataApplier`
**Source specs**: [RFC-006 §8](../../rfcs/RFC-006-kernel-extension-wire-format.md#8--family-f-notebook-metadata-bidirectional-in-v202), [RFC-006 §"Failure modes"](../../rfcs/RFC-006-kernel-extension-wire-format.md) (W7, W8), [RFC-005 §"Persistence strategy"](../../rfcs/RFC-005-llmnb-file-format.md#persistence-strategy-who-writes-the-file)
**Related atoms**: [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md), [contracts/messaging-router](messaging-router.md), [contracts/metadata-writer](metadata-writer.md)

## Definition

The `NotebookMetadataApplier` is the **extension-side terminus of [Family F](../protocols/family-f-notebook-metadata.md)**: it receives `notebook.metadata` Comm envelopes from the router, validates per RFC-006 §"Failure modes" rows W7/W8, and applies the inner `metadata.rts` snapshot to the active VS Code `NotebookDocument` via `vscode.NotebookEdit.updateNotebookMetadata`. VS Code's normal save flow then persists to disk. The applier preserves unknown top-level keys verbatim (RFC-005's "Top-level structure" forward-compat rule).

## Public method signatures

```ts
export interface ActiveNotebookProvider {
  getActiveLlmnbNotebook(): vscode.NotebookDocument | undefined;
}

export interface MetadataApplierFailure {
  reason: 'schema_version_major_mismatch'
        | 'non_monotonic_snapshot'
        | 'unsupported_mode'
        | 'no_active_notebook'
        | 'apply_failed';
  snapshot_version?:      number;
  expected_schema_major?: string;
  observed_schema_major?: string;
  last_accepted_version?: number;
  detail?:                string;
}

export class NotebookMetadataApplier implements NotebookMetadataObserver {
  constructor(active: ActiveNotebookProvider, logger: vscode.LogOutputChannel);

  /** Subscribe to wire-failure events (RFC-006 W7/W8). */
  readonly onFailure: vscode.Event<MetadataApplierFailure>;

  /** Inbound Family F handler (router invokes). */
  onNotebookMetadata(payload: NotebookMetadataPayload): void;

  /** Test accessor; production code does not call. */
  getLastAcceptedVersion(): number | undefined;

  dispose(): void;
}
```

## Invariants

- **V1 accepts only `mode: "snapshot"`.** `mode: "patch"` (V1.5+) and any unknown mode emit a `unsupported_mode` failure and discard. RFC-006 §8.
- **W7 schema-version major check.** `snapshot.schema_version` major MUST equal RFC-005's major (`"1"`). Mismatch emits `schema_version_major_mismatch`; discards; the kernel stops emitting Family F until resolved.
- **W8 monotonicity check.** `snapshot_version` MUST be ≥ `lastAcceptedVersion`. Non-monotonic emits `non_monotonic_snapshot`; discards; receiver retains current state.
- **Unknown top-level keys preserved verbatim.** The kernel owns `metadata.rts`; everything else (`kernelspec`, `language_info`, etc.) is round-tripped untouched.
- **Atomic apply via `WorkspaceEdit`.** A single `vscode.NotebookEdit.updateNotebookMetadata(...)` is staged; `vscode.workspace.applyEdit(...)` commits or rolls back as a unit. A `false` return surfaces `apply_failed` via the failure event.
- **`lastAcceptedVersion` advances only on successful apply.** A failed apply does NOT bump the bound, so the next snapshot still gets monotonicity-checked against the last good version.
- **Single notebook per kernel session.** When multiple `.llmnb` notebooks are open, the first `notebookType` match wins.

## K-class / wire-failure mapping

| Reason                          | RFC-006 row | Behavior |
|---|---|---|
| `schema_version_major_mismatch` | W7  | log error + discard + emit failure event |
| `non_monotonic_snapshot`        | W8  | log error + discard + emit failure event |
| `unsupported_mode` (V1: anything ≠ "snapshot") | (V1 deferral) | log warn + discard + emit failure event |
| `no_active_notebook`            | (no row — environment) | log warn + discard + emit failure event |
| `apply_failed`                  | (no row — VS Code-side) | log error + emit failure event |

## Locking / threading

Node single-threaded; no locks. `lastAcceptedVersion` is a private number bumped on the await-resolved path only.

## Callers

- `extension/src/messaging/router.ts` — `MessageRouter.route(...)` dispatches `notebook.metadata` envelopes to every registered `NotebookMetadataObserver`. The applier registers via `registerMetadataObserver`.
- `extension/src/extension.ts` — activation glue constructs the applier with a `WindowActiveNotebookProvider` and a logger.

## Code drift vs spec

Conformant with RFC-006 v2.0.2's `mode: "snapshot"` path. The `mode: "hydrate"` direction is **not handled here** — that flows the other way (`extension/src/notebook/metadata-loader.ts` constructs the hydrate envelope and ships it via the kernel client). The applier sees only the `hydrate_complete` snapshot confirmation, which it processes as a normal `mode: "snapshot"` envelope. This is correct per RFC-006 §8 but worth noting: the applier's name suggests symmetry that the wire actually splits between two extension modules.

## See also

- [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md) — the wire this contract terminates.
- [contracts/messaging-router](messaging-router.md) — dispatches inbound `notebook.metadata` envelopes here.
- [contracts/metadata-writer](metadata-writer.md) — kernel side that produces what this applier consumes.
- [anti-patterns/stub-kernel-race](../anti-patterns/stub-kernel-race.md) — `lastAcceptedVersion` defends against late snapshots from a respawned stub.
