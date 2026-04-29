# Contract: MessageRouter (extension)

**Status**: `contract` (V1 shipped)
**Module**: `extension/src/messaging/router.ts` — `class MessageRouter`
**Source specs**: [RFC-006 §3](../../rfcs/RFC-006-kernel-extension-wire-format.md#3--comm-envelope-thin) (envelope shape), [RFC-006 §"Failure modes"](../../rfcs/RFC-006-kernel-extension-wire-format.md) (W1–W11), [RFC-008 §6](../../rfcs/RFC-008-kernel-host-integration.md) (LogRecord frames)
**Related atoms**: [protocols/family-b-layout](../protocols/family-b-layout.md), [protocols/family-c-agent-graph](../protocols/family-c-agent-graph.md), [protocols/family-d-event-log](../protocols/family-d-event-log.md), [protocols/family-e-heartbeat](../protocols/family-e-heartbeat.md), [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md), [contracts/kernel-client](kernel-client.md)

## Definition

The `MessageRouter` is the **extension-side dispatcher** for inbound Comm envelopes (Families B–F), inbound Family A run-MIME payloads, inbound RFC-008 LogRecord frames, and outbound envelopes destined for the kernel. The router is purely classification + dispatch; it does no validation beyond shape checks (W4 unknown type / W5 missing fields). Per-family observers register interest at activation time; the router fan-outs in registration order.

## Public method signatures

```ts
export class MessageRouter {
  constructor(logger: vscode.LogOutputChannel);

  // -- observer registration --
  registerRunObserver(observer: RunLifecycleObserver): vscode.Disposable;
  registerMapObserver(observer: MapViewObserver): vscode.Disposable;     // Families B + C
  registerMetadataObserver(observer: NotebookMetadataObserver): vscode.Disposable;  // Family F
  registerLogRecordObserver(observer: LogRecordObserver): vscode.Disposable;        // RFC-008 §6
  registerLogRecordHandler(handler: (record: OtlpLogRecord) => void): vscode.Disposable;
  registerHeartbeatKernelObserver(observer: HeartbeatKernelObserver): vscode.Disposable;
  subscribeOutbound(subscriber: OutboundSubscriber): vscode.Disposable;

  // -- inbound dispatch --
  /** Comm entry point: validate shape then dispatch by `type` (Families B-F). */
  route(envelope: RtsV2Envelope<unknown>): void;
  /** Family A IOPub-style entry. Classifies as run-start / run-event / run-complete. */
  routeRunMime(payload: RunMimePayload): void;
  /** RFC-008 §6 — LogRecord frames lifted off the data plane. */
  routeLogRecord(record: OtlpLogRecord): void;

  // -- outbound --
  /** Push an envelope toward the kernel; subscribers (kernel client) ship it. */
  enqueueOutbound(envelope: RtsV2Envelope<unknown>): void;
}
```

## Invariants

- **Carrier-first dispatch.** Receivers MUST dispatch on the carrier (IOPub-MIME for Family A; Comm `type` for Families B–F; LogRecord for RFC-008 §6). The router never crosses these.
- **Unknown `type` → W4 log + discard.** No exception propagates out of `route(...)`; the bad envelope is dropped.
- **Missing required fields → W5 log + discard.** `validateEnvelope` enforces presence of `type` and `payload`.
- **Family A classification.** `routeRunMime` distinguishes three shapes (RFC-006 §1): full span with `endTimeUnixNano: null` → `onRunStart`; full span with terminal `endTimeUnixNano` → `onRunComplete`; `{spanId, event}` partial → `onRunEvent`.
- **Last-writer-wins on Family A.** Receivers MUST treat each emission as authoritative current state; the router does NOT merge events across emissions.
- **Outbound back-pressure.** When the kernel client is not yet attached, `enqueueOutbound` buffers via the kernel client's own `outboundBuffer`; the router is fire-and-forget at its layer.
- **Observer exceptions are caught.** A throwing observer logs but does NOT prevent fan-out to siblings (`registerHeartbeatKernelObserver` and `registerLogRecordObserver` wrap each call in try/catch).

## Inbound dispatch table

| Comm `type`             | Direction (RFC-006)        | Routed to             |
|---|---|---|
| `layout.update`         | kernel → ext               | `MapViewObserver.onLayoutUpdate` |
| `agent_graph.response`  | kernel → ext               | `MapViewObserver.onAgentGraphResponse` |
| `notebook.metadata`     | kernel → ext (or hydrate-confirm) | `NotebookMetadataObserver.onNotebookMetadata` |
| `heartbeat.kernel`      | kernel → ext               | `HeartbeatKernelObserver.onHeartbeatKernel` |
| `layout.edit` / `agent_graph.query` / `operator.action` / `heartbeat.extension` / `kernel.shutdown_request` | ext → kernel | `enqueueOutbound` (forward through outbound subscribers) |

## K-class / failure mode references

| Wire failure | Router behavior |
|---|---|
| W1 (Comm target name mismatch) | Surfaced by the kernel client; router never opens |
| W4 (unknown `type`) | log + discard |
| W5 (missing required fields) | log + discard |
| W6 (response with no matching query) | dispatched normally; the upstream correlator (kernel client) is the de-dup point |
| W11 (oversize) | enforced upstream (kernel client / Comm layer); router sees the truncation |

## Locking / threading

Node single-threaded; no locks. Observer arrays are mutated in registration order.

## Callers

- `extension/src/notebook/pty-kernel-client.ts` — invokes `route(envelope)`, `routeRunMime(payload)`, `routeLogRecord(record)` for each parsed frame.
- `extension/src/extension.ts` — registers observers (the metadata-applier, the heartbeat consumer, the run renderer host, log-record fan-outs) at activation.
- `extension/src/notebook/controller.ts` — registers itself as a `RunLifecycleObserver` so cell outputs stream live.
- `extension/src/messaging/heartbeat-consumer.ts` — registers as a `HeartbeatKernelObserver`.

## Code drift vs spec

Conformant. The router is mature and matches RFC-006 v2 verbatim. The brief mentioned `outbound` and `inbound` methods; the actual surface uses `enqueueOutbound` and `route` / `routeRunMime` / `routeLogRecord` plus per-family `register*Observer` methods. Functionally equivalent.

## See also

- [protocols/family-b-layout](../protocols/family-b-layout.md) — `layout.update` route.
- [protocols/family-c-agent-graph](../protocols/family-c-agent-graph.md) — `agent_graph.response` route + correlator.
- [protocols/family-d-event-log](../protocols/family-d-event-log.md) — `operator.action` outbound route.
- [protocols/family-e-heartbeat](../protocols/family-e-heartbeat.md) — `heartbeat.kernel` route.
- [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md) — `notebook.metadata` route.
- [contracts/kernel-client](kernel-client.md) — calls into the router; receives outbound through `subscribeOutbound`.
