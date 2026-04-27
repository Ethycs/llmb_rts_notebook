// V1 smoke test. Activates the extension, opens an in-memory .llmnb
// document with one cell, executes it, and verifies that the
// StubKernelClient emitted an open + closed OTLP span pair and that the
// cell output carries an application/vnd.rts.run+json item.
//
// Pattern adapted from
// vendor/vscode-jupyter/src/test/ — vscode-jupyter's smoke tests open a
// notebook via vscode.workspace.openNotebookDocument and execute through
// vscode.commands.executeCommand('notebook.cell.execute').
//
// I-X: payloads are now bare OTLP/JSON spans per RFC-006 §1; the run
// lifecycle is no longer enveloped. Identification is by `endTimeUnixNano`
// (`null` ⇒ open; set ⇒ closed).

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi, StubKernelClient } from './extension.js';
import { RTS_RUN_MIME } from './notebook/controller.js';
import type { OtlpSpan } from './otel/attrs.js';

const EXT_ID = 'ethycs.llmb-rts-notebook';

suite('llmnb V1 smoke', () => {
  test('cell execution emits open + closed OTLP spans with rts.run+json output', async () => {
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

    // Allow time for the controller to flush outputs from the closed span.
    await waitFor(() => doc.cellAt(0).outputs.length > 0, 2000);

    const kernel = api.getKernelClient() as StubKernelClient;
    const spans = kernel.lastPayloads.filter(
      (p): p is OtlpSpan => 'name' in (p as object) && 'kind' in (p as object)
    );
    const open = spans.find((s) => s.endTimeUnixNano === null);
    const closed = spans.find((s) => s.endTimeUnixNano !== null);
    assert.ok(open, `expected an open span (endTimeUnixNano:null) in ${spans.length} payloads`);
    assert.ok(closed, `expected a closed span (terminal endTimeUnixNano) in ${spans.length} payloads`);

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
