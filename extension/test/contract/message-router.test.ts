// Contract tests for MessageRouter against RFC-003.
//
// Doc-driven rule: each test cites the RFC-003 section it walks. The router
// is the single point at which envelopes are accepted on the extension side,
// so its surface is the canonical place to assert the version-handshake (F10)
// and fail-closed (F1, F2) behaviours.
//
// Spec references:
//   RFC-003 §Specification        — the 10 message_types and the envelope shape
//   RFC-003 §Family A             — run.start / run.event / run.complete
//   RFC-003 §Failure mode F1      — invalid envelopes are rejected without throw
//   RFC-003 §Failure mode F2      — unknown message_type is fail-closed
//   RFC-003 §Failure mode F10     — major-version mismatch is rejected

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MessageRouter, RunLifecycleObserver } from '../../src/messaging/router.js';
import type {
  Rfc003Envelope,
  Rfc003MessageType,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload
} from '../../src/messaging/types.js';
import { RFC003_SAMPLES } from './rfc003-samples.js';

/** A LogOutputChannel-shaped sink that drops everything. Casts through unknown
 *  because the public surface includes an event we never use here. */
function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'router-test-log',
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

interface RecordingObserver extends RunLifecycleObserver {
  starts: Rfc003Envelope<RunStartPayload>[];
  events: Rfc003Envelope<RunEventPayload>[];
  completes: Rfc003Envelope<RunCompletePayload>[];
}

function recordingObserver(): RecordingObserver {
  const obs: RecordingObserver = {
    starts: [],
    events: [],
    completes: [],
    onRunStart(env): void {
      obs.starts.push(env);
    },
    onRunEvent(env): void {
      obs.events.push(env);
    },
    onRunComplete(env): void {
      obs.completes.push(env);
    }
  };
  return obs;
}

function envelopeOf<P>(message_type: Rfc003MessageType, payload: P): Rfc003Envelope<P> {
  return {
    message_type,
    direction: 'kernel→extension',
    correlation_id: `cid-${message_type}`,
    timestamp: '2026-04-26T00:00:00.000Z',
    rfc_version: '1.0.0',
    payload
  };
}

function sampleFor(t: Rfc003MessageType): unknown {
  const found = RFC003_SAMPLES.find((s) => s.type === t);
  assert.ok(found, `RFC003_SAMPLES is missing ${t}`);
  return found.payload;
}

suite('contract: MessageRouter (RFC-003)', () => {
  test('routes all 10 RFC-003 message_types without throwing', () => {
    const router = new MessageRouter(silentLogger());
    for (const sample of RFC003_SAMPLES) {
      const env = envelopeOf(sample.type, sample.payload);
      assert.doesNotThrow(() => router.route(env), `route(${sample.type}) must not throw`);
    }
  });

  // RFC-003 §Family A — run-lifecycle messages emit on registered observers.
  test('run.start / run.event / run.complete are dispatched to registered observers', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingObserver();
    const sub = router.registerRunObserver(obs);
    try {
      router.route(envelopeOf('run.start', sampleFor('run.start')));
      router.route(envelopeOf('run.event', sampleFor('run.event')));
      router.route(envelopeOf('run.complete', sampleFor('run.complete')));
      assert.equal(obs.starts.length, 1);
      assert.equal(obs.events.length, 1);
      assert.equal(obs.completes.length, 1);
    } finally {
      sub.dispose();
    }
  });

  // RFC-003 §Family B/C/D/E — non-run-lifecycle envelopes do NOT reach
  // RunLifecycleObserver and are logged-and-ignored on the V1 router.
  test('non-run-lifecycle messages do not reach run-observer hooks', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingObserver();
    const sub = router.registerRunObserver(obs);
    try {
      const nonRun: Rfc003MessageType[] = [
        'layout.update',
        'layout.edit',
        'agent_graph.query',
        'agent_graph.response',
        'operator.action',
        'heartbeat.kernel',
        'heartbeat.extension'
      ];
      for (const t of nonRun) {
        router.route(envelopeOf(t, sampleFor(t)));
      }
      assert.equal(obs.starts.length, 0);
      assert.equal(obs.events.length, 0);
      assert.equal(obs.completes.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // RFC-003 F1 — fail-closed on malformed input.
  test('route(undefined) does not throw', () => {
    const router = new MessageRouter(silentLogger());
    assert.doesNotThrow(() => router.route(undefined as unknown as Rfc003Envelope<unknown>));
  });

  // RFC-003 F1 — fail-closed on missing required fields.
  test('route({}) does not throw and produces no observer dispatch', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingObserver();
    const sub = router.registerRunObserver(obs);
    try {
      assert.doesNotThrow(() => router.route({} as Rfc003Envelope<unknown>));
      assert.equal(obs.starts.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // RFC-003 F10 — major-version mismatch is rejected; observer is not invoked.
  test('rfc_version major mismatch is rejected', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingObserver();
    const sub = router.registerRunObserver(obs);
    try {
      const env = envelopeOf('run.start', sampleFor('run.start'));
      env.rfc_version = '2.0.0'; // foreign major
      router.route(env);
      assert.equal(obs.starts.length, 0, 'observer must not see foreign-major envelopes');
    } finally {
      sub.dispose();
    }
  });

  // RFC-003 F2 — unknown message_type is logged-and-ignored.
  test('unknown message_type does not throw or reach observer', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingObserver();
    const sub = router.registerRunObserver(obs);
    try {
      const env = envelopeOf('totally.fake' as Rfc003MessageType, {});
      assert.doesNotThrow(() => router.route(env));
      assert.equal(obs.starts.length, 0);
    } finally {
      sub.dispose();
    }
  });
});
