# Protocol: Family E — Heartbeat / liveness

**Status**: `protocol` (V1 shipped asymmetric, RFC-006 v2.0.2)
**Family**: RFC-006 Family E (liveness ping)
**Direction**: bidirectional but asymmetric — `heartbeat.kernel` kernel → extension (MUST in V1); `heartbeat.extension` extension → kernel (SHOULD in V1, MUST in V1.5+)
**Source specs**: [RFC-006 §7](../../rfcs/RFC-006-kernel-extension-wire-format.md#7--family-e-heartbeat--liveness), [RFC-006 §7.1](../../rfcs/RFC-006-kernel-extension-wire-format.md#71--kernelshutdown_request-additive-in-v201) (shutdown sibling), [RFC-008 §"Failure modes"](../../rfcs/RFC-008-kernel-host-integration.md) (PTY-EOF complement)
**Related atoms**: [contracts/messaging-router](../contracts/messaging-router.md), [contracts/kernel-client](../contracts/kernel-client.md), [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md)

## Definition

Family E is the **application-level liveness signal**. PTY-EOF + SIGCHLD (RFC-008) detect "kernel process died" — necessary but not sufficient. Family E detects "kernel alive but stuck" (deadlock, infinite loop, hung native code, blocked I/O). V1 ships the asymmetric posture per the v2.0.2 amendment: the kernel MUST emit a 5-second heartbeat; the extension SHOULD but is not required to. Together with PTY-EOF, the two signals fully cover kernel liveness.

## Wire shape

### `heartbeat.kernel` (kernel → extension; MUST in V1)

```jsonc
{
  "type": "heartbeat.kernel",
  "payload": {
    "kernel_state":         "ok | degraded | starting | shutting_down",
    "uptime_seconds":       1834.21,
    "last_run_timestamp":   "2026-04-26T14:32:18.611Z"
  }
}
```

Cadence: every 5 seconds.

### `heartbeat.extension` (extension → kernel; SHOULD in V1, MUST in V1.5+)

```jsonc
{
  "type": "heartbeat.extension",
  "payload": {
    "extension_state":     "ok | degraded | starting | shutting_down",
    "active_notebook_id":  "session-2026-04-26.llmnb",
    "focused_cell_id":     "cell-12"
  }
}
```

Cadence: every 5 seconds (when emitted).

## Liveness rule

Receivers MUST surface a "peer may be hung" warning when **all three** hold: (a) no heartbeat received from the peer for >30 seconds AND (b) the underlying RFC-008 PTY transport is reporting unhealthy AND (c) the peer is required to emit (V1: only the kernel side qualifies). With the PTY healthy and Family E silent, silence is normal — the producer is V1-conformant under the asymmetric posture. Heartbeat absence alone never auto-restarts; the operator decides.

## Schema-version handshake

Comm target name `llmnb.rts.v2`. New `kernel_state` / `extension_state` enum values are additive; receivers tolerate unknown values.

## Error envelope

Failure mode W9 (RFC-006 §"Failure modes"): heartbeat timeout surfaces a liveness warning; the kernel-side switches to queueing for [Family F](family-f-notebook-metadata.md); extension marks the kernel-state badge as `degraded`. There is no in-band ack — the next heartbeat IS the recovery.

## V1 vs V2+

- **V1 (v2.0.2 amended)**: kernel-side MUST every 5s; extension-side SHOULD; receivers tolerate one-sided silence. PTY-EOF / SIGCHLD covers "process died"; heartbeat absence covers "alive but stuck."
- **V1.5+**: extension-side becomes MUST; both sides emit symmetrically. Hung-extension detection joins the operator surface.

## See also

- [contracts/messaging-router](../contracts/messaging-router.md) — extension-side dispatcher fan-outs `heartbeat.kernel` to status-bar + watchdog observers.
- [contracts/kernel-client](../contracts/kernel-client.md) — owns the PTY the heartbeat complements (RFC-008 §6 socket).
- [protocols/family-f-notebook-metadata](family-f-notebook-metadata.md) — Family F emissions are gated by PTY health, not heartbeat absence.
- [protocols/jupyter-mapping](jupyter-mapping.md) — Family E is the one LLMKernel family that's structurally identical to Jupyter (heartbeat REQ/REP echo).
