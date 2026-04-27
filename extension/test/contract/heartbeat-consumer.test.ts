// Contract tests for HeartbeatConsumer — RFC-006 §7 v2.0.2 amendment.
//
// Spec references:
//   RFC-006 §7 v2.0.2 — kernel emits `heartbeat.kernel` every 5s; extension
//                       consumes; absence > 30s with healthy PTY surfaces
//                       a "kernel may be hung" warning.
//   RFC-006 §9        — liveness signal hierarchy (PTY-EOF + heartbeat).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MessageRouter } from '../../src/messaging/router.js';
import {
  HeartbeatConsumer,
  HEARTBEAT_LIVENESS_TIMEOUT_MS
} from '../../src/messaging/heartbeat-consumer.js';
import type { HeartbeatKernelPayload, RtsV2Envelope } from '../../src/messaging/types.js';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'heartbeat-consumer-test-log',
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    append: noop,
    appendLine: noop,
    replace: noop,
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
    logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

function heartbeatEnvelope(payload: HeartbeatKernelPayload): RtsV2Envelope<HeartbeatKernelPayload> {
  return { type: 'heartbeat.kernel', payload };
}

suite('contract: HeartbeatConsumer (RFC-006 §7 v2.0.2)', () => {
  test('updates last-seen state on each heartbeat.kernel envelope', () => {
    const router = new MessageRouter(silentLogger());
    let nowMs = 1_000_000;
    const stateUpdates: HeartbeatKernelPayload[] = [];
    const consumer = new HeartbeatConsumer({
      now: () => nowMs,
      onState: (p) => stateUpdates.push(p)
    });
    const sub = router.registerHeartbeatKernelObserver(consumer);
    try {
      router.route(
        heartbeatEnvelope({ kernel_state: 'ok', uptime_seconds: 1.5 })
      );
      assert.equal(stateUpdates.length, 1);
      assert.equal(stateUpdates[0].kernel_state, 'ok');
      assert.equal(consumer.getLastHeartbeatTimestamp(), 1_000_000);
      // Bump time, send another beat.
      nowMs = 1_005_000;
      router.route(
        heartbeatEnvelope({ kernel_state: 'degraded', uptime_seconds: 6.5 })
      );
      assert.equal(stateUpdates.length, 2);
      assert.equal(consumer.getLastHeartbeatTimestamp(), 1_005_000);
      assert.equal(consumer.getLastPayload()?.kernel_state, 'degraded');
    } finally {
      sub.dispose();
      consumer.dispose();
    }
  });

  test('exposes the 30s liveness timeout per RFC-006 §7 amendment', () => {
    assert.equal(HEARTBEAT_LIVENESS_TIMEOUT_MS, 30_000);
  });

  test('liveness watchdog fires when >30s elapse since the last heartbeat (PTY healthy)', () => {
    let nowMs = 1_000_000;
    const losses: Array<{ sinceMs: number }> = [];
    const consumer = new HeartbeatConsumer({
      now: () => nowMs,
      pty: { isHealthy: () => true },
      sink: { onLivenessLost: (e) => losses.push(e) }
    });
    // First heartbeat at t=0.
    consumer.onHeartbeatKernel({ kernel_state: 'ok', uptime_seconds: 1 });
    // Just under 30s later — no warning.
    nowMs = 1_000_000 + 25_000;
    consumer.poll();
    assert.equal(losses.length, 0);
    // 31s later — warning surfaces.
    nowMs = 1_000_000 + 31_000;
    consumer.poll();
    assert.equal(losses.length, 1);
    assert.ok(losses[0].sinceMs >= 30_000);
    // A second poll without a fresh heartbeat does NOT re-warn.
    nowMs = 1_000_000 + 60_000;
    consumer.poll();
    assert.equal(losses.length, 1);
  });

  test('liveness watchdog suppresses the warning when PTY is unhealthy', () => {
    let nowMs = 1_000_000;
    const losses: Array<unknown> = [];
    let ptyHealthy = true;
    const consumer = new HeartbeatConsumer({
      now: () => nowMs,
      pty: { isHealthy: () => ptyHealthy },
      sink: { onLivenessLost: () => losses.push({}) }
    });
    consumer.onHeartbeatKernel({ kernel_state: 'ok', uptime_seconds: 1 });
    // Drop PTY health (RFC-008 §"PTY EOF" handles this branch).
    ptyHealthy = false;
    nowMs = 1_000_000 + 60_000;
    consumer.poll();
    assert.equal(losses.length, 0);
  });

  test('does not warn before the first heartbeat has arrived', () => {
    let nowMs = 1_000_000;
    const losses: Array<unknown> = [];
    const consumer = new HeartbeatConsumer({
      now: () => nowMs,
      pty: { isHealthy: () => true },
      sink: { onLivenessLost: () => losses.push({}) }
    });
    // Never delivered a heartbeat; advance time by 60s.
    nowMs = 1_000_000 + 60_000;
    consumer.poll();
    assert.equal(losses.length, 0);
  });

  test('a fresh heartbeat after an absence re-arms the watchdog', () => {
    let nowMs = 1_000_000;
    const losses: Array<unknown> = [];
    const consumer = new HeartbeatConsumer({
      now: () => nowMs,
      pty: { isHealthy: () => true },
      sink: { onLivenessLost: () => losses.push({}) }
    });
    consumer.onHeartbeatKernel({ kernel_state: 'ok', uptime_seconds: 1 });
    nowMs += 31_000;
    consumer.poll();
    assert.equal(losses.length, 1);
    // Kernel comes back: fresh heartbeat clears the warned flag.
    consumer.onHeartbeatKernel({ kernel_state: 'ok', uptime_seconds: 32 });
    nowMs += 31_000;
    consumer.poll();
    assert.equal(losses.length, 2);
  });

  test('router dispatches heartbeat.kernel to multiple registered observers', () => {
    const router = new MessageRouter(silentLogger());
    const a: HeartbeatKernelPayload[] = [];
    const b: HeartbeatKernelPayload[] = [];
    const subA = router.registerHeartbeatKernelObserver({
      onHeartbeatKernel: (p) => a.push(p)
    });
    const subB = router.registerHeartbeatKernelObserver({
      onHeartbeatKernel: (p) => b.push(p)
    });
    try {
      router.route(
        heartbeatEnvelope({ kernel_state: 'ok', uptime_seconds: 1 })
      );
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
    } finally {
      subA.dispose();
      subB.dispose();
    }
  });

  test('start()/stop() are idempotent', () => {
    const consumer = new HeartbeatConsumer({});
    consumer.start();
    consumer.start();
    consumer.stop();
    consumer.stop();
    consumer.dispose();
  });
});
