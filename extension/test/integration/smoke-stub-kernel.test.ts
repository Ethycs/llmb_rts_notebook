// Integration smoke — operator workflow simulation against the stub kernel.
//
// In-process equivalent of Stage 3's paper-telephone smoke. Uses
// llmnb.kernel.useStub=true so the test runs without a Jupyter server (CI
// contexts where Claude Code + a live kernel are unavailable).
//
// Spec references:
//   chapter 06 — VS Code substrate (cell paradigm + NotebookController)
//   chapter 07 — subtractive fork (RTS_RUN_MIME on cell outputs)
//   chapter 08 — testing strategy (three-layer test pyramid)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { RTS_RUN_MIME } from '../../src/notebook/controller.js';

const EXT_ID = 'ethycs.llmb-rts-notebook';
const NOTEBOOK_TYPE = 'llmnb';

suite('integration: stub-kernel smoke', () => {
  let api: ExtensionApi | undefined;

  suiteSetup(async function (): Promise<void> {
    this.timeout(30000);
    await vscode.workspace
      .getConfiguration('llmnb')
      .update('kernel.useStub', true, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension<ExtensionApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    api = await ext.activate();
    assert.ok(api.getController(), 'controller should be created on activate');
  });

  test('execute one cell → cell.outputs contains rts.run+json with status=success', async function (): Promise<void> {
    this.timeout(20000);

    const cellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'echo hello',
      'llmnb-cell'
    );
    const data = new vscode.NotebookData([cellData]);
    data.metadata = { rts: { config: { rfc_version: '1.0.0' } } };

    const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
    await vscode.window.showNotebookDocument(doc);

    await vscode.commands.executeCommand(
      'notebook.cell.execute',
      { ranges: [{ start: 0, end: 1 }] },
      doc.uri
    );

    await waitFor(() => doc.cellAt(0).outputs.length > 0, 5000);

    const outputs = doc.cellAt(0).outputs;
    const items = outputs.flatMap((o) => o.items);
    const runItems = items.filter((i) => i.mime === RTS_RUN_MIME);
    assert.ok(runItems.length > 0, `expected at least one ${RTS_RUN_MIME} output item`);

    // I-X: per RFC-006 §1, cell outputs carry bare OTLP spans (no envelope).
    // Identification is by `endTimeUnixNano` (set ⇒ closed) + status.code.
    const decoded = runItems.map((i) => JSON.parse(new TextDecoder('utf-8').decode(i.data))) as Array<{
      spanId?: string;
      endTimeUnixNano?: string | null;
      status?: { code?: string };
    }>;
    const closed = decoded.find(
      (d) => typeof d.endTimeUnixNano === 'string' && d.endTimeUnixNano.length > 0
    );
    assert.ok(closed, 'expected a closed span (terminal endTimeUnixNano) in cell outputs');
    assert.equal(closed!.status?.code, 'STATUS_CODE_OK');
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
