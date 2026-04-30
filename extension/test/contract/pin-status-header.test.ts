// Contract tests for PLAN-S5.0.1 §3.8 — pin-status header.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.5 (`@auth` magic)
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.11 (injection-acceptance banner)

import * as assert from 'node:assert/strict';
import {
  PinStatusRegistry,
  computePinStatusChip,
  actionsForChip,
  dispatchPinAction,
  openPinStatusMenu,
  ACTION_SET_PIN,
  ACTION_ROTATE_PIN,
  ACTION_VERIFY_PIN,
  ACTION_DISABLE_HASH_MODE,
  ACTION_REFUSE_HASH_MODE,
  type QuickPickSink
} from '../../src/notebook/pin-status-header.js';
import {
  type AuthPromptSink,
  type CellInserter,
  authCellText,
  REFUSE_BUTTON_ACCEPT,
  REFUSE_BUTTON_CANCEL,
  REFUSE_BUTTON_TELL_ME
} from '../../src/notebook/commands/auth-prompts.js';
import type { NotebookMetadataPayload } from '../../src/messaging/types.js';

// ---------- stub sinks ------------------------------------------------------

class StubPrompts implements AuthPromptSink {
  public pinResponses: Array<string | undefined> = [];
  public warnResponses: Array<string | undefined> = [];
  public infoCalls: number = 0;
  public lastPinKind: 'set' | 'rotate' | 'verify' | undefined;

  public async promptPin(args: { kind: 'set' | 'rotate' | 'verify' }): Promise<string | undefined> {
    this.lastPinKind = args.kind;
    return this.pinResponses.shift();
  }
  public async warn(_t: string, _d: string, ..._b: string[]): Promise<string | undefined> {
    return this.warnResponses.shift();
  }
  public async info(_m: string): Promise<void> {
    this.infoCalls += 1;
  }
}

class StubInserter implements CellInserter {
  public inserted: string[] = [];
  public async insertTopCell(text: string): Promise<{ uri: import('vscode').Uri; index: number } | undefined> {
    this.inserted.push(text);
    // The pin-status-header tests don't inspect the URI; return a sentinel.
    return { uri: { toString: () => 'fake://nb' } as unknown as import('vscode').Uri, index: 0 };
  }
}

class StubPick implements QuickPickSink {
  public responses: Array<string | undefined> = [];
  public askedItems: string[][] = [];
  public async pick(items: string[], _placeholder: string): Promise<string | undefined> {
    this.askedItems.push([...items]);
    return this.responses.shift();
  }
}

function snapshotPayload(cfg: Record<string, unknown>): NotebookMetadataPayload {
  return {
    mode: 'snapshot',
    snapshot_version: 1,
    snapshot: { schema_version: '1.0.0', config: cfg }
  };
}

suite('contract: PLAN-S5.0.1 §3.8 — pin-status header', () => {

  // --------------------------------------------------------------------------
  // Chip rendering — §3.8 OFF / ON / fingerprint
  // --------------------------------------------------------------------------

  test('test_chip_off_when_hash_mode_disabled', () => {
    const chip = computePinStatusChip({ magic_hash_enabled: false, magic_pin_fingerprint: null });
    assert.match(chip.text, /unprotected/);
    assert.equal(chip.hashEnabled, false);
    assert.equal(chip.injectionAccepted, false);
  });

  test('test_chip_on_with_fingerprint_tail', () => {
    const chip = computePinStatusChip({
      magic_hash_enabled: true,
      magic_pin_fingerprint: 'a3b4c5d6e7f8'
    });
    assert.match(chip.text, /hash mode/);
    assert.match(chip.text, /e7f8/, 'fingerprint last 4 chars MUST appear in chip text');
    assert.equal(chip.hashEnabled, true);
    assert.equal(chip.fingerprintTail, 'e7f8');
  });

  test('test_chip_on_without_fingerprint_omits_tail', () => {
    const chip = computePinStatusChip({ magic_hash_enabled: true, magic_pin_fingerprint: null });
    assert.match(chip.text, /hash mode/);
    assert.doesNotMatch(chip.text, /…/);
  });

  test('test_chip_surfaces_injection_acceptance_marker', () => {
    const chip = computePinStatusChip({
      magic_hash_enabled: false,
      magic_pin_fingerprint: null,
      injection_acceptance: 'The Operator Has Accepted Arbitrary Code Injection at 2026-04-29T00:00:00Z'
    });
    assert.equal(chip.injectionAccepted, true);
    assert.match(chip.text, /injection-accepted/);
    // Tooltip MUST quote the verbatim acceptance string per §3.11.
    assert.match(chip.tooltip, /Arbitrary Code Injection at 2026-04-29T00:00:00Z/);
  });

  // --------------------------------------------------------------------------
  // Actions per state — §3.8
  // --------------------------------------------------------------------------

  test('test_actions_off_state_offers_set_and_refuse', () => {
    const chip = computePinStatusChip({ magic_hash_enabled: false, magic_pin_fingerprint: null });
    const actions = actionsForChip(chip);
    assert.deepEqual(actions, [ACTION_SET_PIN, ACTION_REFUSE_HASH_MODE]);
  });

  test('test_actions_on_state_offers_verify_rotate_disable', () => {
    const chip = computePinStatusChip({
      magic_hash_enabled: true,
      magic_pin_fingerprint: 'ffeeddcc'
    });
    const actions = actionsForChip(chip);
    assert.deepEqual(actions, [ACTION_VERIFY_PIN, ACTION_ROTATE_PIN, ACTION_DISABLE_HASH_MODE]);
  });

  test('test_actions_off_after_injection_accepted_drops_refuse', () => {
    // §3.11 the acceptance marker is permanent; the refuse button MUST NOT
    // re-appear (it would be a no-op).
    const chip = computePinStatusChip({
      magic_hash_enabled: false,
      magic_pin_fingerprint: null,
      injection_acceptance: 'accepted'
    });
    const actions = actionsForChip(chip);
    assert.deepEqual(actions, [ACTION_SET_PIN]);
  });

  // --------------------------------------------------------------------------
  // Registry (Family F snapshot consumption)
  // --------------------------------------------------------------------------

  test('test_registry_absorbs_config_snapshot', () => {
    const reg = new PinStatusRegistry();
    try {
      reg.onNotebookMetadata(
        snapshotPayload({
          magic_hash_enabled: true,
          magic_pin_fingerprint: '1234567890abcdef'
        })
      );
      const cfg = reg.get();
      assert.equal(cfg.magic_hash_enabled, true);
      assert.equal(cfg.magic_pin_fingerprint, '1234567890abcdef');
    } finally {
      reg.dispose();
    }
  });

  test('test_registry_change_event_fires_on_state_flip', () => {
    const reg = new PinStatusRegistry();
    let fires = 0;
    const sub = reg.onDidChange(() => {
      fires += 1;
    });
    try {
      reg.set({ magic_hash_enabled: true, magic_pin_fingerprint: 'x'.repeat(16) });
      reg.set({ magic_hash_enabled: true, magic_pin_fingerprint: 'x'.repeat(16) });
      assert.equal(fires, 1, 'duplicate set MUST NOT re-fire onDidChange');
    } finally {
      sub.dispose();
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Set-pin flow — §3.8: "Set pin" inserts cell with @auth set <pin>
  // --------------------------------------------------------------------------

  test('test_set_pin_inserts_auth_set_cell_with_pin_text', async () => {
    const reg = new PinStatusRegistry();
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_SET_PIN);
    prompts.pinResponses.push('correctPin1234');
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth set correctPin1234');
      assert.deepEqual(inserter.inserted, ['@auth set correctPin1234']);
      assert.equal(prompts.lastPinKind, 'set');
    } finally {
      reg.dispose();
    }
  });

  test('test_set_pin_cancelled_inserts_nothing', async () => {
    const reg = new PinStatusRegistry();
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_SET_PIN);
    prompts.pinResponses.push(undefined); // operator cancels InputBox
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, undefined);
      assert.deepEqual(inserter.inserted, []);
    } finally {
      reg.dispose();
    }
  });

  test('test_rotate_pin_inserts_auth_rotate_cell', async () => {
    const reg = new PinStatusRegistry();
    reg.set({ magic_hash_enabled: true, magic_pin_fingerprint: 'a'.repeat(16) });
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_ROTATE_PIN);
    prompts.pinResponses.push('newCorrectPin99');
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth rotate newCorrectPin99');
      assert.deepEqual(inserter.inserted, ['@auth rotate newCorrectPin99']);
      assert.equal(prompts.lastPinKind, 'rotate');
    } finally {
      reg.dispose();
    }
  });

  test('test_disable_hash_mode_inserts_auth_off_cell', async () => {
    const reg = new PinStatusRegistry();
    reg.set({ magic_hash_enabled: true, magic_pin_fingerprint: 'a'.repeat(16) });
    const inserter = new StubInserter();
    const prompts = new StubPrompts();
    const pick = new StubPick();
    pick.responses.push(ACTION_DISABLE_HASH_MODE);
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth off');
      assert.deepEqual(inserter.inserted, ['@auth off']);
    } finally {
      reg.dispose();
    }
  });

  test('test_verify_pin_inserts_auth_verify_cell', async () => {
    const reg = new PinStatusRegistry();
    reg.set({ magic_hash_enabled: true, magic_pin_fingerprint: 'b'.repeat(16) });
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_VERIFY_PIN);
    prompts.pinResponses.push('verifyMePin77');
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth verify verifyMePin77');
      assert.equal(prompts.lastPinKind, 'verify');
    } finally {
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Refuse-hash-mode flow — destructive warning copy + tell-me-more loop
  // --------------------------------------------------------------------------

  test('test_refuse_hash_mode_inserts_auth_refuse_only_on_explicit_accept', async () => {
    const reg = new PinStatusRegistry();
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_REFUSE_HASH_MODE);
    prompts.warnResponses.push(REFUSE_BUTTON_ACCEPT);
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth refuse');
      assert.deepEqual(inserter.inserted, ['@auth refuse']);
    } finally {
      reg.dispose();
    }
  });

  test('test_refuse_hash_mode_cancel_inserts_nothing', async () => {
    const reg = new PinStatusRegistry();
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_REFUSE_HASH_MODE);
    prompts.warnResponses.push(REFUSE_BUTTON_CANCEL);
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, undefined);
      assert.deepEqual(inserter.inserted, []);
    } finally {
      reg.dispose();
    }
  });

  test('test_refuse_hash_mode_tell_me_more_loops_back', async () => {
    // Tell-me-more MUST surface the explainer and re-prompt; only an
    // explicit accept on the second pass inserts the cell.
    const reg = new PinStatusRegistry();
    const prompts = new StubPrompts();
    const inserter = new StubInserter();
    const pick = new StubPick();
    pick.responses.push(ACTION_REFUSE_HASH_MODE);
    prompts.warnResponses.push(REFUSE_BUTTON_TELL_ME);
    prompts.warnResponses.push(REFUSE_BUTTON_ACCEPT);
    try {
      const text = await openPinStatusMenu(reg, pick, prompts, inserter);
      assert.equal(text, '@auth refuse');
      assert.equal(prompts.infoCalls, 1, 'tell-me-more MUST surface the info modal exactly once');
      assert.deepEqual(inserter.inserted, ['@auth refuse']);
    } finally {
      reg.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // dispatchPinAction direct
  // --------------------------------------------------------------------------

  test('test_dispatch_pin_action_unknown_returns_undefined', async () => {
    const inserter = new StubInserter();
    const prompts = new StubPrompts();
    const result = await dispatchPinAction('not-a-real-action', prompts, inserter);
    assert.equal(result, undefined);
    assert.deepEqual(inserter.inserted, []);
  });

  // --------------------------------------------------------------------------
  // authCellText — verbatim form
  // --------------------------------------------------------------------------

  test('test_auth_cell_text_set', () => {
    assert.equal(authCellText('set', 'pinpinpin1234'), '@auth set pinpinpin1234');
  });
  test('test_auth_cell_text_off', () => {
    assert.equal(authCellText('off'), '@auth off');
  });
  test('test_auth_cell_text_refuse', () => {
    assert.equal(authCellText('refuse'), '@auth refuse');
  });
});
