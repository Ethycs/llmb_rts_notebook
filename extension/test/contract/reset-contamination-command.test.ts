// Contract tests for PLAN-S5.0.1 §3.10/§3.8 — `llmnb.resetContamination`
// command. Pure-stub-kernel exercise; no live kernel required.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.10 K3F

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MessageRouter } from '../../src/messaging/router.js';
import {
  buildResetContaminationEnvelope,
  runResetContaminationCommand,
  RESET_CONTAMINATION_COMMAND_ID,
  CONFIRM_RESET_ACCEPT,
  CONFIRM_RESET_CANCEL,
  type ConfirmationSink
} from '../../src/notebook/commands/reset-contamination.js';
import type { RtsV2Envelope } from '../../src/messaging/types.js';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => undefined;
  return {
    name: 'reset-contamination-test-log',
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    append: noop, appendLine: noop, replace: noop, clear: noop,
    show: noop, hide: noop, dispose: noop, logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

class StubConfirm implements ConfirmationSink {
  public lastMessage: string | undefined;
  public lastActions: string[] = [];
  public response: string | undefined;
  public async ask(message: string, ...actions: string[]): Promise<string | undefined> {
    this.lastMessage = message;
    this.lastActions = actions;
    return this.response;
  }
}

suite('contract: PLAN-S5.0.1 §3.8 — reset-contamination command', () => {

  // --------------------------------------------------------------------------
  // Envelope shape
  // --------------------------------------------------------------------------

  test('test_envelope_action_type_and_cell_id_at_payload_root', () => {
    const env = buildResetContaminationEnvelope('vscode-notebook-cell:test#a');
    assert.equal(env.type, 'operator.action');
    const payload = env.payload as unknown as Record<string, unknown>;
    assert.equal(payload['action_type'], 'reset_contamination');
    // Locked shape: cell_id duplicated at payload root for parity with the
    // S9 agent_interrupt envelope.
    assert.equal(payload['cell_id'], 'vscode-notebook-cell:test#a');
    const params = payload['parameters'] as Record<string, unknown>;
    assert.ok(params, 'envelope payload MUST carry a parameters block');
    assert.equal(params['cell_id'], 'vscode-notebook-cell:test#a');
    assert.equal(payload['originating_cell_id'], 'vscode-notebook-cell:test#a');
  });

  // --------------------------------------------------------------------------
  // Confirmation flow
  // --------------------------------------------------------------------------

  test('test_command_emits_envelope_only_after_confirmation_accept', async () => {
    const router = new MessageRouter(silentLogger());
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    const confirm = new StubConfirm();
    confirm.response = CONFIRM_RESET_ACCEPT;
    try {
      const ok = await runResetContaminationCommand(
        { cell_id: 'cell-1' },
        router,
        confirm
      );
      assert.equal(ok, true);
      assert.equal(captured.length, 1, 'confirmed reset MUST enqueue exactly one envelope');
      const env = captured[0] as RtsV2Envelope<Record<string, unknown>>;
      const payload = env.payload as Record<string, unknown>;
      assert.equal(payload['action_type'], 'reset_contamination');
      assert.equal(payload['cell_id'], 'cell-1');
      // Confirmation copy MUST surface both Reset and Cancel options.
      assert.deepEqual(confirm.lastActions, [CONFIRM_RESET_ACCEPT, CONFIRM_RESET_CANCEL]);
    } finally {
      sub.dispose();
    }
  });

  test('test_command_emits_nothing_when_confirmation_cancelled', async () => {
    const router = new MessageRouter(silentLogger());
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    const confirm = new StubConfirm();
    confirm.response = CONFIRM_RESET_CANCEL;
    try {
      const ok = await runResetContaminationCommand(
        { cell_id: 'cell-1' },
        router,
        confirm
      );
      assert.equal(ok, false, 'cancelled flow MUST report false');
      assert.equal(captured.length, 0, 'cancelled flow MUST NOT enqueue any envelope');
    } finally {
      sub.dispose();
    }
  });

  test('test_command_emits_nothing_when_confirmation_dismissed', async () => {
    // Operator hits Esc → showInformationMessage resolves to undefined.
    const router = new MessageRouter(silentLogger());
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    const confirm = new StubConfirm();
    confirm.response = undefined;
    try {
      const ok = await runResetContaminationCommand(
        { cell_id: 'cell-1' },
        router,
        confirm
      );
      assert.equal(ok, false);
      assert.equal(captured.length, 0);
    } finally {
      sub.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Args validation
  // --------------------------------------------------------------------------

  test('test_command_rejects_args_without_cell_id', async () => {
    const router = new MessageRouter(silentLogger());
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    const confirm = new StubConfirm();
    confirm.response = CONFIRM_RESET_ACCEPT;
    try {
      const ok = await runResetContaminationCommand(undefined, router, confirm);
      assert.equal(ok, false);
      assert.equal(captured.length, 0);
      assert.equal(confirm.lastMessage, undefined, 'no confirm prompt when args invalid');
    } finally {
      sub.dispose();
    }
  });

  test('test_command_accepts_camelcase_cellId_alias', async () => {
    // Renderer-side bridges ship `{cellId}`; the handler MUST accept both
    // spellings transparently.
    const router = new MessageRouter(silentLogger());
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    const confirm = new StubConfirm();
    confirm.response = CONFIRM_RESET_ACCEPT;
    try {
      const ok = await runResetContaminationCommand(
        { cellId: 'cell-from-renderer' },
        router,
        confirm
      );
      assert.equal(ok, true);
      assert.equal(captured.length, 1);
      const env = captured[0] as RtsV2Envelope<Record<string, unknown>>;
      assert.equal(env.payload['cell_id'], 'cell-from-renderer');
    } finally {
      sub.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Command id constant
  // --------------------------------------------------------------------------

  test('test_command_id_constant_matches_package_json', () => {
    assert.equal(RESET_CONTAMINATION_COMMAND_ID, 'llmnb.resetContamination');
  });
});
