// Contract tests for PLAN-S5.5 Phase 2 — section operator commands.
//
// Pure-stub-kernel exercises; no live kernel required. Verifies the wire
// envelope shape matches what `overlay_applier._OPERATION_DISPATCH`
// kernel-side expects, plus the prompt-flow logic for each command.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MessageRouter } from '../../src/messaging/router.js';
import {
  buildCreateSectionEnvelope,
  buildDeleteSectionEnvelope,
  buildRenameSectionEnvelope,
  buildSetSectionStatusEnvelope,
  mintIntentId,
  mintSectionIdFromTitle,
  parseSectionMagicArgs,
  runSectionCreateCommand,
  runSectionDeleteCommand,
  runSectionRenameCommand,
  runSectionSetStatusCommand,
  SECTION_CREATE_COMMAND_ID,
  SECTION_DELETE_ACCEPT,
  SECTION_DELETE_CANCEL,
  SECTION_DELETE_COMMAND_ID,
  SECTION_RENAME_COMMAND_ID,
  SECTION_SET_STATUS_COMMAND_ID,
  SECTION_STATUSES,
  type SectionPromptSink
} from '../../src/notebook/commands/section-ops.js';

function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => undefined;
  return {
    name: 'section-commands-test-log',
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    append: noop, appendLine: noop, replace: noop, clear: noop,
    show: noop, hide: noop, dispose: noop, logLevel: 0,
    onDidChangeLogLevel: (() => ({ dispose: noop })) as unknown as vscode.Event<vscode.LogLevel>
  } as unknown as vscode.LogOutputChannel;
}

class StubPromptSink implements SectionPromptSink {
  public inputBoxReply: string | undefined = undefined;
  public quickPickReply: string | undefined = undefined;
  public confirmReply: string | undefined = undefined;
  public lastInputPrompt: string | undefined;
  public lastQuickPickItems: string[] = [];
  public lastConfirmMessage: string | undefined;

  public async inputBox(opts: { prompt: string }): Promise<string | undefined> {
    this.lastInputPrompt = opts.prompt;
    return this.inputBoxReply;
  }
  public async quickPick(
    items: string[],
    _placeHolder: string
  ): Promise<string | undefined> {
    this.lastQuickPickItems = items;
    return this.quickPickReply;
  }
  public async confirm(message: string): Promise<string | undefined> {
    this.lastConfirmMessage = message;
    return this.confirmReply;
  }
}

function makeRouter(): {
  router: MessageRouter;
  outbox: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const router = new MessageRouter(silentLogger());
  const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  router.subscribeOutbound((env) => {
    outbox.push({
      type: env.type,
      payload: env.payload as Record<string, unknown>
    });
  });
  return { router, outbox };
}

suite('contract: PLAN-S5.5 Phase 2 — section operator commands', () => {

  // ------------------------------------------------------------------
  // Envelope shape — wire compatibility with kernel _OPERATION_DISPATCH
  // ------------------------------------------------------------------

  test('test_create_envelope_routes_through_apply_overlay_commit', () => {
    const env = buildCreateSectionEnvelope('sec_arch', 'Architecture');
    assert.equal(env.type, 'operator.action');
    const payload = env.payload as unknown as Record<string, unknown>;
    assert.equal(payload['action_type'], 'zone_mutate');
    assert.equal(payload['intent_kind'], 'apply_overlay_commit');
    assert.ok(typeof payload['intent_id'] === 'string' && (payload['intent_id'] as string).length > 0);
    const params = payload['parameters'] as Record<string, unknown>;
    const ops = params['operations'] as Record<string, unknown>[];
    assert.equal(ops.length, 1);
    assert.equal(ops[0]['kind'], 'create_section');
    assert.equal(ops[0]['section_id'], 'sec_arch');
    assert.equal(ops[0]['title'], 'Architecture');
  });

  test('test_create_envelope_with_cell_range_appends_move_op', () => {
    const env = buildCreateSectionEnvelope('sec_x', 'X', ['c_a', 'c_b']);
    const payload = env.payload as unknown as Record<string, unknown>;
    const params = payload['parameters'] as Record<string, unknown>;
    const ops = params['operations'] as Record<string, unknown>[];
    assert.equal(ops.length, 2);
    assert.equal(ops[1]['kind'], 'move_cells_into_section');
    assert.equal(ops[1]['target_section_id'], 'sec_x');
    assert.deepEqual(ops[1]['cell_ids'], ['c_a', 'c_b']);
    assert.equal(ops[1]['position'], 0);
  });

  test('test_rename_envelope_carries_section_id_and_title', () => {
    const env = buildRenameSectionEnvelope('sec_r', 'New Title');
    const payload = env.payload as unknown as Record<string, unknown>;
    const ops = (payload['parameters'] as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['kind'], 'rename_section');
    assert.equal(ops[0]['section_id'], 'sec_r');
    assert.equal(ops[0]['title'], 'New Title');
  });

  test('test_delete_envelope_carries_section_id_only', () => {
    const env = buildDeleteSectionEnvelope('sec_d');
    const payload = env.payload as unknown as Record<string, unknown>;
    const ops = (payload['parameters'] as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['kind'], 'delete_section');
    assert.equal(ops[0]['section_id'], 'sec_d');
  });

  test('test_set_status_envelope_carries_new_status', () => {
    const env = buildSetSectionStatusEnvelope('sec_s', 'in_progress');
    const payload = env.payload as unknown as Record<string, unknown>;
    const ops = (payload['parameters'] as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['kind'], 'set_section_status');
    assert.equal(ops[0]['section_id'], 'sec_s');
    assert.equal(ops[0]['new_status'], 'in_progress');
  });

  // ------------------------------------------------------------------
  // ID minting — must produce kernel-safe section ids (no spaces, no
  // special chars beyond underscores).
  // ------------------------------------------------------------------

  test('test_mint_section_id_from_title_is_slug_plus_tail', () => {
    const id = mintSectionIdFromTitle('Architecture & Design');
    assert.ok(/^sec_architecture_design_[a-z0-9]{6,8}$/.test(id), `got: ${id}`);
  });

  test('test_mint_section_id_handles_pure_punctuation_title', () => {
    const id = mintSectionIdFromTitle('!!!');
    assert.ok(/^sec_[a-z0-9]{6,8}$/.test(id), `got: ${id}`);
  });

  test('test_mint_intent_id_includes_prefix', () => {
    const id = mintIntentId('sec-create-abc123');
    assert.ok(id.startsWith('sec-create-abc123-'), `got: ${id}`);
  });

  // ------------------------------------------------------------------
  // Create command flow
  // ------------------------------------------------------------------

  test('test_create_prompts_for_title_then_ships_envelope', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.inputBoxReply = 'Runtime';
    const ok = await runSectionCreateCommand(undefined, router, sink);
    assert.equal(ok, true);
    assert.equal(outbox.length, 1);
    assert.equal(sink.lastInputPrompt, 'Section title');
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['kind'], 'create_section');
    assert.equal(ops[0]['title'], 'Runtime');
  });

  test('test_create_cancelled_when_title_blank', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.inputBoxReply = undefined;
    const ok = await runSectionCreateCommand(undefined, router, sink);
    assert.equal(ok, false);
    assert.equal(outbox.length, 0);
  });

  test('test_create_with_cell_ids_arg_includes_move_op', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.inputBoxReply = 'Tests';
    const ok = await runSectionCreateCommand(
      { cell_ids: ['c_1', 'c_2', 'c_3'] }, router, sink
    );
    assert.equal(ok, true);
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[1]['cell_ids'], ['c_1', 'c_2', 'c_3']);
  });

  // ------------------------------------------------------------------
  // Rename command flow
  // ------------------------------------------------------------------

  test('test_rename_requires_section_id_arg', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.inputBoxReply = 'whatever';
    const ok = await runSectionRenameCommand({}, router, sink);
    assert.equal(ok, false);
    assert.equal(outbox.length, 0);
  });

  test('test_rename_prompts_with_current_title_and_ships', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.inputBoxReply = 'Better Name';
    const ok = await runSectionRenameCommand(
      { section_id: 'sec_r', current_title: 'Old Name' },
      router, sink
    );
    assert.equal(ok, true);
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['title'], 'Better Name');
  });

  // ------------------------------------------------------------------
  // Delete command flow
  // ------------------------------------------------------------------

  test('test_delete_requires_confirm_accept', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.confirmReply = SECTION_DELETE_CANCEL;
    const ok = await runSectionDeleteCommand(
      { section_id: 'sec_d', title: 'X' }, router, sink
    );
    assert.equal(ok, false);
    assert.equal(outbox.length, 0);
  });

  test('test_delete_ships_envelope_on_accept', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.confirmReply = SECTION_DELETE_ACCEPT;
    const ok = await runSectionDeleteCommand(
      { section_id: 'sec_d' }, router, sink
    );
    assert.equal(ok, true);
    assert.equal(outbox.length, 1);
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['kind'], 'delete_section');
    assert.equal(ops[0]['section_id'], 'sec_d');
  });

  // ------------------------------------------------------------------
  // Set-status command flow
  // ------------------------------------------------------------------

  test('test_set_status_quickpick_offers_4_statuses', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.quickPickReply = 'frozen';
    const ok = await runSectionSetStatusCommand(
      { section_id: 'sec_s' }, router, sink
    );
    assert.equal(ok, true);
    assert.deepEqual(sink.lastQuickPickItems, [...SECTION_STATUSES]);
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['new_status'], 'frozen');
  });

  test('test_set_status_arg_skips_quickpick', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    // Pre-supplied status; the QuickPick should NOT be invoked.
    const ok = await runSectionSetStatusCommand(
      { section_id: 'sec_s', new_status: 'complete' }, router, sink
    );
    assert.equal(ok, true);
    assert.equal(sink.lastQuickPickItems.length, 0);
    const ops = (outbox[0].payload.parameters as Record<string, unknown>)['operations'] as Record<string, unknown>[];
    assert.equal(ops[0]['new_status'], 'complete');
  });

  test('test_set_status_rejects_invalid_arg_status', async () => {
    const { router, outbox } = makeRouter();
    const sink = new StubPromptSink();
    sink.quickPickReply = 'bogus';  // ignored — invalid arg falls through to picker
    const ok = await runSectionSetStatusCommand(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      { section_id: 'sec_s', new_status: 'bogus' as 'open' },
      router, sink
    );
    // Picker also returns 'bogus', which our validator rejects.
    assert.equal(ok, false);
    assert.equal(outbox.length, 0);
  });

  // ------------------------------------------------------------------
  // Command-id constants — pinned so the package.json contribution
  // declarations track changes if we ever rename them.
  // ------------------------------------------------------------------

  test('test_command_ids_locked', () => {
    assert.equal(SECTION_CREATE_COMMAND_ID, 'llmnb.section.create');
    assert.equal(SECTION_RENAME_COMMAND_ID, 'llmnb.section.rename');
    assert.equal(SECTION_DELETE_COMMAND_ID, 'llmnb.section.delete');
    assert.equal(SECTION_SET_STATUS_COMMAND_ID, 'llmnb.section.setStatus');
  });

});

// ---------------------------------------------------------------------------
// parseSectionMagicArgs — Phase 4 extension recognition for @@section
// ---------------------------------------------------------------------------

suite('contract: PLAN-S5.5 Phase 4 ext — @@section args parsing', () => {

  test('test_positional_unquoted_title', () => {
    const r = parseSectionMagicArgs('Architecture');
    assert.equal(r.title, 'Architecture');
    assert.equal(r.section_id, undefined);
  });

  test('test_positional_quoted_multi_word_title', () => {
    const r = parseSectionMagicArgs('"Runtime Concerns"');
    assert.equal(r.title, 'Runtime Concerns');
  });

  test('test_named_title_kwarg', () => {
    const r = parseSectionMagicArgs('title:"Multi Word Title"');
    assert.equal(r.title, 'Multi Word Title');
  });

  test('test_positional_with_explicit_id', () => {
    const r = parseSectionMagicArgs('Tests id:"sec_tests_pinned"');
    assert.equal(r.title, 'Tests');
    assert.equal(r.section_id, 'sec_tests_pinned');
  });

  test('test_named_title_with_explicit_id', () => {
    const r = parseSectionMagicArgs('id:"sec_x" title:"Foo Bar"');
    assert.equal(r.title, 'Foo Bar');
    assert.equal(r.section_id, 'sec_x');
  });

  test('test_empty_args_yields_no_title', () => {
    const r = parseSectionMagicArgs('');
    assert.equal(r.title, undefined);
    assert.equal(r.section_id, undefined);
  });

  test('test_only_id_no_title', () => {
    const r = parseSectionMagicArgs('id:"sec_orphan"');
    assert.equal(r.title, undefined);
    assert.equal(r.section_id, 'sec_orphan');
  });

  test('test_non_string_input_safe', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = parseSectionMagicArgs(undefined as unknown as string);
    assert.deepEqual(r, {});
  });

});
