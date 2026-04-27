// Heartbeat consumer — Family E (RFC-006 §7 v2.0.2) extension-side handling.
//
// The kernel emits `heartbeat.kernel` envelopes every 5 seconds carrying its
// state, uptime, and last_run_timestamp. The extension consumes them to:
//   1. Keep an operator-facing status indicator (e.g., a status bar item)
//      continuously fresh.
//   2. Run a liveness watchdog: if no heartbeat arrives for >30 seconds AND
//      the underlying PTY is reported healthy, surface a "kernel may be hung"
//      warning per RFC-006 §7 amendment final paragraph.
//
// V1 does NOT emit `heartbeat.extension` (deferred to V1.5+); see RFC-006
// §7 v2.0.2 amendment.

import type { HeartbeatKernelPayload } from './types.js';
import type { HeartbeatKernelObserver } from './router.js';

/** Default timeout per RFC-006 §7 amendment ("absence > 30s with PTY healthy
 *  signals 'kernel alive but stuck'"). */
export const HEARTBEAT_LIVENESS_TIMEOUT_MS = 30_000;

/** PTY-health gate. The watchdog suppresses the warning when PTY is unhealthy
 *  because RFC-008 §"PTY EOF" already covers "kernel process died". */
export interface PtyHealthGate {
  isHealthy(): boolean;
}

/** Sink invoked by the watchdog when liveness times out. The activation
 *  glue passes a closure that surfaces a VS Code warning toast; tests pass
 *  a recorder. */
export interface HeartbeatLivenessSink {
  onLivenessLost(payload: { lastSeenAt: number; sinceMs: number }): void;
}

/** Extension-side `heartbeat.kernel` consumer + liveness watchdog. */
export class HeartbeatConsumer implements HeartbeatKernelObserver {
  /** Last observed heartbeat payload (none until first emission). */
  private lastPayload: HeartbeatKernelPayload | undefined;
  /** Wall-clock millis of the last heartbeat we processed. */
  private lastHeartbeatTimestamp = 0;
  /** Whether we've already surfaced a liveness warning this absence window
   *  (so we don't spam toasts every poll while the kernel stays hung). */
  private warned = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly env: {
      /** Called on each heartbeat with the new state — for status indicators. */
      onState?: (payload: HeartbeatKernelPayload) => void;
      /** Surface for liveness loss. */
      sink?: HeartbeatLivenessSink;
      /** PTY health gate; defaults to `() => true` (PTY assumed healthy). */
      pty?: PtyHealthGate;
      /** Override `Date.now()` for tests. */
      now?: () => number;
      /** Watchdog poll interval; defaults to 5s, matching the kernel emission
       *  cadence. */
      pollIntervalMs?: number;
      /** Liveness timeout; defaults to 30s per RFC-006 §7 amendment. */
      timeoutMs?: number;
    } = {}
  ) {}

  /** RFC-006 §7 — `HeartbeatKernelObserver` impl. */
  public onHeartbeatKernel(payload: HeartbeatKernelPayload): void {
    this.lastPayload = payload;
    this.lastHeartbeatTimestamp = (this.env.now ?? Date.now)();
    this.warned = false;
    try {
      this.env.onState?.(payload);
    } catch {
      // State sink errors must not propagate into the wire dispatcher.
    }
  }

  /** Start the liveness watchdog. The activation glue calls this after the
   *  router subscription is in place. Idempotent. */
  public start(): void {
    if (this.timer) {
      return;
    }
    const interval = this.env.pollIntervalMs ?? 5_000;
    this.timer = setInterval(() => this.poll(), interval);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      // Don't keep node alive solely for the watchdog (CI / smokes).
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /** Stop the liveness watchdog. */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public dispose(): void {
    this.stop();
  }

  /** Test hook: run one watchdog poll synchronously instead of waiting for
   *  the interval. Production code never calls this directly. */
  public poll(): void {
    if (this.lastHeartbeatTimestamp === 0) {
      // Never seen a heartbeat yet — the kernel may still be starting; do
      // not flag liveness loss until at least one heartbeat has arrived.
      return;
    }
    const now = (this.env.now ?? Date.now)();
    const sinceMs = now - this.lastHeartbeatTimestamp;
    const timeout = this.env.timeoutMs ?? HEARTBEAT_LIVENESS_TIMEOUT_MS;
    if (sinceMs <= timeout) {
      return;
    }
    // PTY-health gate: only warn when the underlying transport is healthy.
    const ptyOk = this.env.pty?.isHealthy?.() ?? true;
    if (!ptyOk) {
      // PTY-EOF / SIGCHLD path (RFC-008 §"PTY EOF") already covers this case.
      return;
    }
    if (this.warned) {
      return;
    }
    this.warned = true;
    try {
      this.env.sink?.onLivenessLost({
        lastSeenAt: this.lastHeartbeatTimestamp,
        sinceMs
      });
    } catch {
      // Sink errors must not crash the watchdog.
    }
  }

  /** Test accessor: most-recent heartbeat payload (or undefined). */
  public getLastPayload(): HeartbeatKernelPayload | undefined {
    return this.lastPayload;
  }

  /** Test accessor: timestamp (epoch ms) of the most recent heartbeat. */
  public getLastHeartbeatTimestamp(): number {
    return this.lastHeartbeatTimestamp;
  }
}
