// V1 smoke test. Activates the extension, opens an in-memory .llmnb
// document with one cell, executes it, and verifies that the
// StubKernelClient emitted run.start + run.complete and that the cell
// output carries an application/vnd.rts.run+json item.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/test/ — vscode-jupyter's smoke tests open a
// notebook via vscode.workspace.openNotebookDocument and execute through
// vscode.commands.executeCommand('notebook.cell.execute').
//
// TODO(T1): once Track B3 lands the real JupyterKernelClient, expand this
// to the full integration scenario (real RFC-003 envelopes over Jupyter
// messaging, run.event streaming, error paths, F1/F4/F5 from RFC-003).

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi, StubKernelClient } from './extension.js';
import { RTS_RUN_MIME } from './notebook/controller.js';

const EXT_ID = 'ethycs.llmb-rts-notebook';

suite('llmnb V1 smoke', () => {
  test('cell execution emits run.start + run.complete with rts.run+json output', async () => {
    // Force the stub kernel client for this smoke test. Track C R2 added a
    // JupyterKernelClient that requires a live Jupyter server (full
    // integration coverage is TODO(T1) in the WebdriverIO harness).
    await vscode.workspace
      .getConfiguration('llmnb')
      .update('kernel.useStub', true, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension<ExtensionApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    const api = await ext!.activate();
    assert.ok(api.getController(), 'controller should be created');

    const seedCell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      '/spawn alpha zone:refactor task:"smoke test"',
      'llmnb-cell'
    );
    const data = new vscode.NotebookData([seedCell]);
    data.metadata = { rts: { config: { rfc_version: '1.0.0' } } };

    const doc = await vscode.workspace.openNotebookDocument('llmnb', data);
    await vscode.window.showNotebookDocument(doc);

    await vscode.commands.executeCommand(
      'notebook.cell.execute',
      { ranges: [{ start: 0, end: 1 }] },
      doc.uri
    );

    // Allow time for the controller to flush outputs from run.complete.
    await waitFor(() => doc.cellAt(0).outputs.length > 0, 2000);

    const kernel = api.getKernelClient() as StubKernelClient;
    const types = kernel.lastEnvelopes.map((e) => e.message_type);
    assert.ok(types.includes('run.start'), `expected run.start in ${JSON.stringify(types)}`);
    assert.ok(types.includes('run.complete'), `expected run.complete in ${JSON.stringify(types)}`);

    const outputs = doc.cellAt(0).outputs;
    const items = outputs.flatMap((o) => o.items);
    const mimes = items.map((i) => i.mime);
    assert.ok(
      mimes.includes(RTS_RUN_MIME),
      `expected ${RTS_RUN_MIME} in cell outputs; saw ${JSON.stringify(mimes)}`
    );
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
