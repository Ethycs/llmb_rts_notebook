// Contract tests for MessageRouter against RFC-006 (v2 wire).
//
// Doc-driven rule: each test cites the RFC-006 section it walks. The router
// is the single point at which envelopes are accepted on the extension side,
// so its surface is the canonical place to assert envelope validation (W5),
// per-family dispatch (§4–§8), and unknown-type fail-closed (W4).
//
// Spec references:
//   RFC-006 §3                       — thin Comm envelope `{type, payload, correlation_id?}`
//   RFC-006 §4–§8                    — per-family dispatch
//   RFC-006 §"Failure modes" W4      — unknown `type` → log+discard
//   RFC-006 §"Failure modes" W5      — missing required field → log+discard
//   RFC-006 §1                       — run-MIME (Family A, bare OTLP)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  MessageRouter,
  RunLifecycleObserver,
  MapViewObserver,
  NotebookMetadataObserver,
  LogRecordObserver
} from '../../src/messaging/router.js';
import type {
  RtsV2Envelope,
  RtsV2MessageType,
  LayoutUpdatePayload,
  AgentGraphResponsePayload,
  NotebookMetadataPayload,
  RunStartPayload,
  RunEventPayload,
  RunCompletePayload,
  OtlpLogRecord
} from '../../src/messaging/types.js';
import {
  RFC006_SAMPLES,
  RUN_OPEN_SAMPLE,
  RUN_EVENT_SAMPLE,
  RUN_CLOSED_SAMPLE
} from './rfc003-samples.js';

/** A LogOutputChannel-shaped sink that drops everything. */
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

interface RecordingRunObserver extends RunLifecycleObserver {
  starts: RunStartPayload[];
  events: RunEventPayload[];
  completes: RunCompletePayload[];
}

function recordingRunObserver(): RecordingRunObserver {
  const obs: RecordingRunObserver = {
    starts: [],
    events: [],
    completes: [],
    onRunStart(p): void { obs.starts.push(p); },
    onRunEvent(p): void { obs.events.push(p); },
    onRunComplete(p): void { obs.completes.push(p); }
  };
  return obs;
}

interface RecordingMapObserver extends MapViewObserver {
  layouts: LayoutUpdatePayload[];
  graphs: AgentGraphResponsePayload[];
}

function recordingMapObserver(): RecordingMapObserver {
  const obs: RecordingMapObserver = {
    layouts: [],
    graphs: [],
    onLayoutUpdate(p): void { obs.layouts.push(p); },
    onAgentGraphResponse(p): void { obs.graphs.push(p); }
  };
  return obs;
}

interface RecordingMetadataObserver extends NotebookMetadataObserver {
  metadata: NotebookMetadataPayload[];
}

function recordingMetadataObserver(): RecordingMetadataObserver {
  const obs: RecordingMetadataObserver = {
    metadata: [],
    onNotebookMetadata(p): void { obs.metadata.push(p); }
  };
  return obs;
}

function envelopeOf<P>(type: RtsV2MessageType, payload: P, correlation_id?: string): RtsV2Envelope<P> {
  return correlation_id !== undefined
    ? { type, payload, correlation_id }
    : { type, payload };
}

function sampleFor(t: RtsV2MessageType): unknown {
  const found = RFC006_SAMPLES.find((s) => s.type === t);
  assert.ok(found, `RFC006_SAMPLES is missing ${t}`);
  return found.payload;
}

suite('contract: MessageRouter (RFC-006)', () => {
  test('routes all 8 RFC-006 Comm `type` values without throwing', () => {
    const router = new MessageRouter(silentLogger());
    for (const sample of RFC006_SAMPLES) {
      const env = envelopeOf(sample.type, sample.payload);
      assert.doesNotThrow(() => router.route(env), `route(${sample.type}) must not throw`);
    }
  });

  // RFC-006 §4 — layout.update is dispatched to map observers.
  test('layout.update reaches MapViewObserver.onLayoutUpdate', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMapObserver();
    const sub = router.registerMapObserver(obs);
    try {
      router.route(envelopeOf('layout.update', sampleFor('layout.update')));
      assert.equal(obs.layouts.length, 1);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §5 — agent_graph.response is dispatched to map observers.
  test('agent_graph.response reaches MapViewObserver.onAgentGraphResponse', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMapObserver();
    const sub = router.registerMapObserver(obs);
    try {
      router.route(envelopeOf('agent_graph.response', sampleFor('agent_graph.response')));
      assert.equal(obs.graphs.length, 1);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §8 — notebook.metadata is dispatched to NotebookMetadataObserver.
  test('notebook.metadata reaches NotebookMetadataObserver', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMetadataObserver();
    const sub = router.registerMetadataObserver(obs);
    try {
      router.route(envelopeOf('notebook.metadata', sampleFor('notebook.metadata')));
      assert.equal(obs.metadata.length, 1);
      assert.equal(obs.metadata[0].mode, 'snapshot');
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §1 — Family A run-MIME → RunLifecycleObserver dispatch.
  test('routeRunMime dispatches open / event / closed payloads to run observers', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingRunObserver();
    const sub = router.registerRunObserver(obs);
    try {
      router.routeRunMime(RUN_OPEN_SAMPLE);
      router.routeRunMime(RUN_EVENT_SAMPLE);
      router.routeRunMime(RUN_CLOSED_SAMPLE);
      assert.equal(obs.starts.length, 1);
      assert.equal(obs.events.length, 1);
      assert.equal(obs.completes.length, 1);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §3 / W5 — fail-closed on missing required fields.
  test('route(undefined) does not throw', () => {
    const router = new MessageRouter(silentLogger());
    assert.doesNotThrow(() => router.route(undefined as unknown as RtsV2Envelope<unknown>));
  });

  test('route({}) does not throw and produces no observer dispatch', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMapObserver();
    const sub = router.registerMapObserver(obs);
    try {
      assert.doesNotThrow(() => router.route({} as RtsV2Envelope<unknown>));
      assert.equal(obs.layouts.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §3 — envelope without `payload` is rejected.
  test('envelope missing `payload` is rejected', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMetadataObserver();
    const sub = router.registerMetadataObserver(obs);
    try {
      router.route({ type: 'notebook.metadata' } as unknown as RtsV2Envelope<unknown>);
      assert.equal(obs.metadata.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 W4 — unknown `type` is logged-and-ignored.
  test('unknown comm `type` does not throw or reach any observer', () => {
    const router = new MessageRouter(silentLogger());
    const obs = recordingMapObserver();
    const sub = router.registerMapObserver(obs);
    try {
      const env = envelopeOf('totally.fake' as RtsV2MessageType, {});
      assert.doesNotThrow(() => router.route(env));
      assert.equal(obs.layouts.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §6 — `drift_acknowledged` is a valid action_type in v2.
  test('operator.action with drift_acknowledged is forwarded to outbound subscribers', () => {
    const router = new MessageRouter(silentLogger());
    const seen: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => seen.push(env));
    try {
      router.route(
        envelopeOf('operator.action', {
          action_type: 'drift_acknowledged',
          parameters: { field_path: 'config.volatile.agents[0].model' }
        })
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, 'operator.action');
    } finally {
      sub.dispose();
    }
  });

  // RFC-006 §3 — extension→kernel families fall through to outbound subscribers.
  test('extension→kernel comm types reach outbound subscribers', () => {
    const router = new MessageRouter(silentLogger());
    const seen: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => seen.push(env));
    try {
      router.route(envelopeOf('layout.edit', sampleFor('layout.edit')));
      router.route(envelopeOf('agent_graph.query', sampleFor('agent_graph.query')));
      assert.equal(seen.length, 2);
    } finally {
      sub.dispose();
    }
  });

  // RFC-008 §6 — LogRecordObserver registration and dispatch.
  test('routeLogRecord fans OTLP/JSON LogRecord frames to LogRecordObserver subscribers', () => {
    const router = new MessageRouter(silentLogger());
    const seen: OtlpLogRecord[] = [];
    const obs: LogRecordObserver = { onLogRecord: (r) => seen.push(r) };
    const sub = router.registerLogRecordObserver(obs);
    try {
      const rec: OtlpLogRecord = {
        timeUnixNano: '1745588938412000000',
        severityNumber: 9,
        severityText: 'INFO',
        body: { stringValue: 'hello' },
        attributes: [
          { key: 'event.name', value: { stringValue: 'kernel.ready' } }
        ]
      };
      router.routeLogRecord(rec);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body?.stringValue, 'hello');
    } finally {
      sub.dispose();
    }
  });

  test('registerLogRecordHandler convenience returns a Disposable that unhooks the handler', () => {
    const router = new MessageRouter(silentLogger());
    const seen: OtlpLogRecord[] = [];
    const sub = router.registerLogRecordHandler((r) => seen.push(r));
    const rec: OtlpLogRecord = {
      timeUnixNano: '1',
      severityNumber: 13,
      body: { stringValue: 'warn1' }
    };
    router.routeLogRecord(rec);
    assert.equal(seen.length, 1);
    sub.dispose();
    router.routeLogRecord({ ...rec, body: { stringValue: 'warn2' } });
    // No additional dispatch after unsubscription.
    assert.equal(seen.length, 1);
  });

  test('routeLogRecord on a non-object input does not throw', () => {
    const router = new MessageRouter(silentLogger());
    assert.doesNotThrow(() => router.routeLogRecord(undefined as unknown as OtlpLogRecord));
    assert.doesNotThrow(() => router.routeLogRecord(null as unknown as OtlpLogRecord));
  });
});
