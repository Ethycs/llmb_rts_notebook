// Contract tests for PLAN-S5.5 Phase 3 — section-header decoration.
//
// Covers:
//   - section-header-compute pure compute (no vscode dependency).
//   - runSectionActionsCommand routing to the Phase 2 commands.
// The vscode-bound provider class is exercised indirectly via the
// compute helpers; the registration glue is covered by the activation
// path (extension.ts).

import * as assert from 'node:assert/strict';
import {
  computeSectionHeader,
  SECTION_CONTINUATION_PREFIX,
  SECTION_HEADER_PREFIX,
  SECTION_STATUSES,
  type NotebookMetadataForSections
} from '../../src/notebook/sections/section-header-compute.js';
import {
  ACTION_DELETE,
  ACTION_RENAME,
  ACTION_SET_STATUS,
  runSectionActionsCommand,
  SECTION_HEADER_ACTIONS_COMMAND_ID,
  type SectionActionsArgs,
  type SectionActionsPicker
} from '../../src/notebook/sections/section-header-provider.js';
import {
  SECTION_DELETE_COMMAND_ID,
  SECTION_RENAME_COMMAND_ID,
  SECTION_SET_STATUS_COMMAND_ID
} from '../../src/notebook/commands/section-ops.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeMetadata(opts: {
  sections?: Record<string, Record<string, unknown>>;
  cells?: Record<string, Record<string, unknown>>;
} = {}): NotebookMetadataForSections {
  return {
    rts: {
      zone: { sections: opts.sections ?? {} },
      cells: opts.cells ?? {}
    }
  };
}

// ---------------------------------------------------------------------------
// computeSectionHeader — pure logic
// ---------------------------------------------------------------------------

suite('contract: PLAN-S5.5 Phase 3 — section-header compute', () => {

  test('test_no_metadata_returns_undefined', () => {
    const r = computeSectionHeader({ cellId: 'c_1', metadata: undefined });
    assert.equal(r, undefined);
  });

  test('test_no_section_id_on_cell_returns_undefined', () => {
    const md = makeMetadata({ cells: { c_1: { kind: 'agent' } } });
    const r = computeSectionHeader({ cellId: 'c_1', metadata: md });
    assert.equal(r, undefined);
  });

  test('test_section_id_pointing_to_missing_section_returns_undefined', () => {
    const md = makeMetadata({
      cells: { c_1: { kind: 'agent', section_id: 'sec_ghost' } }
    });
    const r = computeSectionHeader({ cellId: 'c_1', metadata: md });
    assert.equal(r, undefined);
  });

  test('test_first_cell_in_section_renders_header_with_status_and_count', () => {
    const md = makeMetadata({
      sections: {
        sec_arch: {
          id: 'sec_arch',
          title: 'Architecture',
          status: 'open',
          cell_range: ['c_1', 'c_2', 'c_3']
        }
      },
      cells: {
        c_1: { kind: 'agent', section_id: 'sec_arch' },
        c_2: { kind: 'agent', section_id: 'sec_arch' },
        c_3: { kind: 'agent', section_id: 'sec_arch' }
      }
    });
    const r = computeSectionHeader({ cellId: 'c_1', metadata: md });
    assert.ok(r);
    assert.equal(r.section_id, 'sec_arch');
    assert.equal(r.title, 'Architecture');
    assert.equal(r.status, 'open');
    assert.equal(r.is_first, true);
    assert.equal(r.cell_count, 3);
    assert.ok(r.text.startsWith(SECTION_HEADER_PREFIX), `got: ${r.text}`);
    assert.ok(r.text.includes('Architecture'));
    assert.ok(r.text.includes('(open)'));
    assert.ok(r.text.includes('3 cells'));
  });

  test('test_continuation_cell_renders_short_form', () => {
    const md = makeMetadata({
      sections: {
        sec_arch: {
          id: 'sec_arch',
          title: 'Architecture',
          status: 'in_progress',
          cell_range: ['c_1', 'c_2', 'c_3']
        }
      },
      cells: {
        c_1: { kind: 'agent', section_id: 'sec_arch' },
        c_2: { kind: 'agent', section_id: 'sec_arch' },
        c_3: { kind: 'agent', section_id: 'sec_arch' }
      }
    });
    const r = computeSectionHeader({ cellId: 'c_2', metadata: md });
    assert.ok(r);
    assert.equal(r.is_first, false);
    assert.equal(r.cell_count, 3);
    assert.ok(r.text.startsWith(SECTION_CONTINUATION_PREFIX), `got: ${r.text}`);
    assert.ok(r.text.includes('Architecture'));
    // Continuation form does NOT include status or count.
    assert.ok(!r.text.includes('(in_progress)'));
    assert.ok(!r.text.includes('cells'));
  });

  test('test_singular_cell_form_in_first_header', () => {
    const md = makeMetadata({
      sections: {
        sec_solo: {
          id: 'sec_solo', title: 'Solo', status: 'open',
          cell_range: ['c_only']
        }
      },
      cells: { c_only: { section_id: 'sec_solo' } }
    });
    const r = computeSectionHeader({ cellId: 'c_only', metadata: md });
    assert.ok(r);
    assert.ok(r.text.includes('1 cell'));
    assert.ok(!r.text.includes('1 cells'));
  });

  test('test_invalid_status_defaults_to_open_for_render', () => {
    const md = makeMetadata({
      sections: {
        sec_x: {
          id: 'sec_x', title: 'X', status: 'bogus',
          cell_range: ['c_x']
        }
      },
      cells: { c_x: { section_id: 'sec_x' } }
    });
    const r = computeSectionHeader({ cellId: 'c_x', metadata: md });
    assert.ok(r);
    assert.equal(r.status, 'open');
  });

  test('test_missing_title_falls_back_to_section_id', () => {
    const md = makeMetadata({
      sections: {
        sec_unnamed: { id: 'sec_unnamed', cell_range: ['c_u'] }
      },
      cells: { c_u: { section_id: 'sec_unnamed' } }
    });
    const r = computeSectionHeader({ cellId: 'c_u', metadata: md });
    assert.ok(r);
    assert.equal(r.title, 'sec_unnamed');
  });

  test('test_all_four_statuses_render_distinct_text', () => {
    const texts = new Set<string>();
    for (const status of SECTION_STATUSES) {
      const md = makeMetadata({
        sections: {
          s: { id: 's', title: 'S', status, cell_range: ['c'] }
        },
        cells: { c: { section_id: 's' } }
      });
      const r = computeSectionHeader({ cellId: 'c', metadata: md });
      assert.ok(r);
      texts.add(r.text);
    }
    assert.equal(texts.size, SECTION_STATUSES.length);
  });

  test('test_tooltip_carries_section_id_and_title', () => {
    const md = makeMetadata({
      sections: {
        sec_t: {
          id: 'sec_t', title: 'Tooltip Test', status: 'frozen',
          cell_range: ['c_t']
        }
      },
      cells: { c_t: { section_id: 'sec_t' } }
    });
    const r = computeSectionHeader({ cellId: 'c_t', metadata: md });
    assert.ok(r);
    assert.ok(r.tooltip.includes('sec_t'));
    assert.ok(r.tooltip.includes('Tooltip Test'));
    assert.ok(r.tooltip.includes('frozen'));
    // Frozen tooltip carries the unfreeze hint.
    assert.ok(r.tooltip.includes('unfreeze'));
  });

});

// ---------------------------------------------------------------------------
// runSectionActionsCommand — QuickPick routing to Phase 2 commands
// ---------------------------------------------------------------------------

class StubActionsPicker implements SectionActionsPicker {
  public reply: string | undefined = undefined;
  public lastItems: string[] = [];
  public async pickAction(items: string[]): Promise<string | undefined> {
    this.lastItems = items;
    return this.reply;
  }
}

interface ExecutedCommand {
  id: string;
  args: unknown[];
}

function makeExecCommand(): {
  exec: (id: string, ...args: unknown[]) => Thenable<unknown>;
  calls: ExecutedCommand[];
} {
  const calls: ExecutedCommand[] = [];
  const exec = async (id: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ id, args });
    return undefined;
  };
  return { exec, calls };
}

suite('contract: PLAN-S5.5 Phase 3 — section-header actions QuickPick', () => {

  test('test_actions_quickpick_offers_rename_setstatus_delete', async () => {
    const picker = new StubActionsPicker();
    picker.reply = undefined;
    const { exec, calls } = makeExecCommand();
    const args: SectionActionsArgs = {
      section_id: 'sec_x', title: 'X', status: 'open'
    };
    await runSectionActionsCommand(args, picker, exec);
    assert.deepEqual(picker.lastItems, [
      ACTION_RENAME, ACTION_SET_STATUS, ACTION_DELETE
    ]);
    assert.equal(calls.length, 0);
  });

  test('test_actions_rename_dispatches_to_rename_command', async () => {
    const picker = new StubActionsPicker();
    picker.reply = ACTION_RENAME;
    const { exec, calls } = makeExecCommand();
    const args: SectionActionsArgs = {
      section_id: 'sec_r', title: 'Old', status: 'open'
    };
    const choice = await runSectionActionsCommand(args, picker, exec);
    assert.equal(choice, ACTION_RENAME);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, SECTION_RENAME_COMMAND_ID);
    const cmdArgs = calls[0].args[0] as { section_id: string; current_title: string };
    assert.equal(cmdArgs.section_id, 'sec_r');
    assert.equal(cmdArgs.current_title, 'Old');
  });

  test('test_actions_delete_dispatches_to_delete_command', async () => {
    const picker = new StubActionsPicker();
    picker.reply = ACTION_DELETE;
    const { exec, calls } = makeExecCommand();
    const args: SectionActionsArgs = {
      section_id: 'sec_d', title: 'Doomed', status: 'open'
    };
    await runSectionActionsCommand(args, picker, exec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, SECTION_DELETE_COMMAND_ID);
    const cmdArgs = calls[0].args[0] as { section_id: string; title: string };
    assert.equal(cmdArgs.section_id, 'sec_d');
    assert.equal(cmdArgs.title, 'Doomed');
  });

  test('test_actions_set_status_dispatches_to_set_status_command', async () => {
    const picker = new StubActionsPicker();
    picker.reply = ACTION_SET_STATUS;
    const { exec, calls } = makeExecCommand();
    const args: SectionActionsArgs = {
      section_id: 'sec_s', title: 'S', status: 'open'
    };
    await runSectionActionsCommand(args, picker, exec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, SECTION_SET_STATUS_COMMAND_ID);
    const cmdArgs = calls[0].args[0] as { section_id: string };
    assert.equal(cmdArgs.section_id, 'sec_s');
  });

  test('test_actions_no_section_id_is_noop', async () => {
    const picker = new StubActionsPicker();
    picker.reply = ACTION_RENAME;
    const { exec, calls } = makeExecCommand();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const choice = await runSectionActionsCommand(
      undefined, picker, exec
    );
    assert.equal(choice, undefined);
    assert.equal(calls.length, 0);
  });

  test('test_actions_command_id_locked', () => {
    assert.equal(SECTION_HEADER_ACTIONS_COMMAND_ID, 'llmnb.section.openActions');
  });

});
