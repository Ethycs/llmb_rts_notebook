# Contract: KernelClient (extension)

**Status**: `contract` (V1 shipped — `PtyKernelClient` is the production implementation; `StubKernelClient` is the dev/test shim)
**Module**: `extension/src/notebook/controller.ts` declares the interface; `extension/src/notebook/pty-kernel-client.ts` implements production; `extension/src/extension.ts` declares a stub
**Source specs**: [RFC-008 §4](../../rfcs/RFC-008-kernel-host-integration.md) (lifecycle), [RFC-008 §6](../../rfcs/RFC-008-kernel-host-integration.md) (data-plane LogRecord), [RFC-006 §1](../../rfcs/RFC-006-kernel-extension-wire-format.md#1--family-a-run-lifecycle-otlpjson-over-iopub) (Family A), [DR-0009](../../decisions/0009-notebook-controller-no-jupyter-kernel.md) (no Jupyter kernel)
**Related atoms**: [protocols/family-a-otlp-spans](../protocols/family-a-otlp-spans.md), [protocols/family-d-event-log](../protocols/family-d-event-log.md), [contracts/messaging-router](messaging-router.md), [contracts/metadata-applier](metadata-applier.md)

## Definition

The `KernelClient` is the **extension-side surface for the running kernel**: spawn, ready handshake, execute one cell, observe `kernel.ready`, send envelopes outbound, route inbound frames into the [messaging router](messaging-router.md) and [Family F applier](metadata-applier.md). The interface lives in `controller.ts` so the controller can be tested with a stub; the production implementation is `PtyKernelClient` (RFC-008 PTY transport), and the dev/test stub lives inline in `extension.ts`.

## Public method signatures

```ts
// extension/src/notebook/controller.ts:29
export interface KernelClient {
  /** Optional eager-connect hook (PtyKernelClient: spawn + handshake). */
  connect?(): Promise<void>;

  /** Begin executing one cell. MUST emit ≥1 in-progress span and exactly
   *  one terminal span via the supplied sink before resolving. Streaming
   *  events MAY be emitted via the partial `{spanId, event}` shape. */
  executeCell(input: KernelExecuteRequest, sink: KernelEventSink): Promise<void>;

  /** True once the kernel has emitted the `kernel.ready` LogRecord. */
  readonly isReady: boolean;
}

// PtyKernelClient surface (extends the interface):
class PtyKernelClient implements KernelClient {
  constructor(config: PtyKernelConfig, router: MessageRouter, logger: vscode.LogOutputChannel);
  start(): Promise<void>;                                    // alias for connect()
  interrupt(): void;                                         // RFC-008 §5 SIGINT
  shutdown(): Promise<void>;                                 // §"Failure modes" K11
  disconnect(): Promise<void>;                               // alias for shutdown
  dispose(): void;
  sendEnvelope(envelope: RtsV2Envelope<unknown>): Promise<void>;
  setCommSink(sink: CommEnvelopeSink): void;                 // for inbound Comm forwarding
  onPtyData(listener: PtyDataListener): vscode.Disposable;
  writePtyInput(data: string): void;
  getDriftEvents(): readonly KernelDriftEvent[];
  readonly onDrift: vscode.Event<KernelDriftEvent>;
}
```

`hydrate(...)` does **not** live on the KernelClient interface; the metadata-loader (`extension/src/notebook/metadata-loader.ts`) sends a `notebook.metadata` `mode:"hydrate"` envelope through the router, which goes through the kernel client's `sendEnvelope`. See [protocols/family-f-notebook-metadata](../protocols/family-f-notebook-metadata.md).

## Invariants

- **Idempotent `start()` / `connect()`.** Repeated calls return the same `readyPromise`. The controller awaits it before each `executeCell` call.
- **`executeCell` blocks on terminal span.** The promise resolves only after a span with `endTimeUnixNano` set AND `status.code !== STATUS_CODE_UNSET` arrives, preventing the "exec.end(false) before any span arrives" race per [anti-patterns/stub-kernel-race](../anti-patterns/stub-kernel-race.md).
- **One inflight cell in V1.** `activeRunSink` is single-valued; multi-cell parallelism is deferred.
- **Ready handshake bounds.** `kernel.ready` MUST land within `readyTimeoutMs` (default 30_000 per RFC-008 §4) or `readyReject` fires with K71 semantics.
- **Single-client socket.** RFC-008 §2 forbids multi-client; the kernel accepts the first (and only) connection.
- **Drift events captured during ready handshake** are exposed via `onDrift` so the metadata-applier can append them to the inbound drift_log.
- **PTY-EOF / SIGCHLD = "kernel process died."** Family E heartbeat absence (>30s) with PTY healthy = "kernel alive but stuck." Both signals route through the router; the kernel client does not auto-restart.

## K-class error modes

| Code | Trigger |
|---|---|
| K11 (RFC-008) | Kernel did not respond to `shutdown_request`; SIGTERM after `shutdownGraceMs`, SIGKILL after 2× |
| K71 (FSP-003) | `waitForKernelReady` timed out before `isReady` flipped |
| W1 (RFC-006) | Comm target name mismatch on attach (kernel-client surfaces this on the ready handshake) |

## Locking / threading

Node.js is single-threaded; no locks. The PTY ready handshake uses a `readyPromise` + timer pattern. Outbound envelopes that arrive before the socket is up are buffered in `outboundBuffer` and flushed when the socket connects.

## Callers

- `extension/src/notebook/controller.ts` — `LlmnbNotebookController` calls `kernel.executeCell(...)` per cell.
- `extension/src/extension.ts` — activation glue constructs the kernel client, wires it to the router, and forwards inbound Comm envelopes to the router via `setCommSink`.
- `extension/src/notebook/metadata-loader.ts` — sends `mode:"hydrate"` envelopes via `kernel.sendEnvelope(...)` on `.llmnb` open.

## Code drift vs spec

The brief asked for `start, executeCell, hydrate, isReady, dispose` on the interface. The actual interface is narrower: `connect?`, `executeCell`, `isReady`. The `start`, `hydrate`, and `dispose` surfaces live on the `PtyKernelClient` concrete class (and `hydrate` is not a method at all — it is a wire envelope sent via `sendEnvelope`, processed by the kernel-side `MetadataWriter.hydrate(...)`). The code is correct; the brief over-specified the interface. Suggest amending the brief or extracting `start()` and `dispose()` into the interface (low risk).

## See also

- [protocols/family-a-otlp-spans](../protocols/family-a-otlp-spans.md) — what `executeCell` produces on the wire (in the IOPub-style flow over RFC-008's data plane).
- [protocols/family-d-event-log](../protocols/family-d-event-log.md) — `executeCell` ships an `operator.action` envelope into this family.
- [contracts/messaging-router](messaging-router.md) — receives inbound frames the kernel client decodes.
- [contracts/metadata-applier](metadata-applier.md) — receives `notebook.metadata` envelopes via the router.
- [anti-patterns/stub-kernel-race](../anti-patterns/stub-kernel-race.md) — terminal-span gating exists because of this hazard.
