// PLAN-S10 §3.2-§3.3 (reduced) — contract tests for the wrapper commands.
//
// We assert against the WRAPPER_TO_BUILTIN map + the `makeWrapperHandler`
// closure factory rather than driving `vscode.commands.executeCommand`.
// The extension activation glue registers these commands once at startup;
// re-registering inside a test would throw `command already exists`. The
// map-level tests pin the wiring without colliding with activation.

import * as assert from 'node:assert/strict';
import {
  BUILTIN_COLLAPSE_COMMANDS,
  BUILTIN_FIND_COMMAND,
  COLLAPSE_ALL_INPUTS_COMMAND_ID,
  COLLAPSE_ALL_OUTPUTS_COMMAND_ID,
  EXPAND_ALL_INPUTS_COMMAND_ID,
  EXPAND_ALL_OUTPUTS_COMMAND_ID,
  FIND_IN_CELLS_COMMAND_ID,
  RecordingCommandRunner,
  WRAPPER_TO_BUILTIN,
  makeWrapperHandler
} from '../../src/notebook/three-pane-commands.js';

suite('contract: PLAN-S10 wrapper commands', () => {
  test('collapseAllInputs wrapper maps to the builtin notebook.cell.collapseAllCellInput', async () => {
    const runner = new RecordingCommandRunner();
    const handler = makeWrapperHandler(COLLAPSE_ALL_INPUTS_COMMAND_ID, runner);
    await handler();
    assert.deepEqual(runner.invocations, [BUILTIN_COLLAPSE_COMMANDS.collapseAllInputs]);
  });

  test('collapseAllOutputs wrapper maps to the builtin notebook.cell.collapseAllCellOutput', async () => {
    const runner = new RecordingCommandRunner();
    const handler = makeWrapperHandler(COLLAPSE_ALL_OUTPUTS_COMMAND_ID, runner);
    await handler();
    assert.deepEqual(runner.invocations, [BUILTIN_COLLAPSE_COMMANDS.collapseAllOutputs]);
  });

  test('expandAllInputs wrapper maps to the builtin notebook.cell.expandAllCellInput', async () => {
    const runner = new RecordingCommandRunner();
    const handler = makeWrapperHandler(EXPAND_ALL_INPUTS_COMMAND_ID, runner);
    await handler();
    assert.deepEqual(runner.invocations, [BUILTIN_COLLAPSE_COMMANDS.expandAllInputs]);
  });

  test('expandAllOutputs wrapper maps to the builtin notebook.cell.expandAllCellOutput', async () => {
    const runner = new RecordingCommandRunner();
    const handler = makeWrapperHandler(EXPAND_ALL_OUTPUTS_COMMAND_ID, runner);
    await handler();
    assert.deepEqual(runner.invocations, [BUILTIN_COLLAPSE_COMMANDS.expandAllOutputs]);
  });

  test('findInCells wrapper maps to the builtin actions.find', async () => {
    const runner = new RecordingCommandRunner();
    const handler = makeWrapperHandler(FIND_IN_CELLS_COMMAND_ID, runner);
    await handler();
    assert.deepEqual(runner.invocations, [BUILTIN_FIND_COMMAND]);
  });

  test('WRAPPER_TO_BUILTIN enumerates exactly five entries', () => {
    assert.equal(WRAPPER_TO_BUILTIN.size, 5);
    const ids = Array.from(WRAPPER_TO_BUILTIN.keys()).sort();
    assert.deepEqual(ids, [
      COLLAPSE_ALL_INPUTS_COMMAND_ID,
      COLLAPSE_ALL_OUTPUTS_COMMAND_ID,
      EXPAND_ALL_INPUTS_COMMAND_ID,
      EXPAND_ALL_OUTPUTS_COMMAND_ID,
      FIND_IN_CELLS_COMMAND_ID
    ].sort());
  });

  test('makeWrapperHandler rejects unknown wrapper ids', () => {
    const runner = new RecordingCommandRunner();
    assert.throws(
      () => makeWrapperHandler('llmnb.unknownCommand', runner),
      /unknown wrapper command id/
    );
  });
});
