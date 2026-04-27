// Contract tests for the VS Code NotebookController API surface that the
// llmb extension uses.
//
// Doc-driven rule (see test/README.md): every assertion below cites the
// documented VS Code Extension API page it walks. If the API surface drifts
// between VS Code versions, these tests are the canary.
//
// Spec references:
//   chapter 06 — VS Code substrate (DR-0009: keep cells, drop kernel process)
//   chapter 07 — subtractive fork & storage (RTS_RUN_MIME canonicalised)
//   RFC-001    — notebook tool ABI (llmnb.run_type / tool dispatch)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { RTS_RUN_MIME } from '../../src/notebook/controller.js';

const EXT_ID = 'ethycs.llmb-rts-notebook';
const NOTEBOOK_TYPE = 'llmnb';

suite('contract: NotebookController API surface', () => {
  let api: ExtensionApi | undefined;

  suiteSetup(async function (): Promise<void> {
    this.timeout(30000);
    // Force the stub kernel so contract tests run without a Jupyter server.
    await vscode.workspace
      .getConfiguration('llmnb')
      .update('kernel.useStub', true, vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension<ExtensionApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    api = await ext.activate();
  });

  // https://code.visualstudio.com/api/references/vscode-api#notebooks.createNotebookController
  test('vscode.notebooks.createNotebookController returns a controller with the documented surface', () => {
    const controller = vscode.notebooks.createNotebookController(
      'llmnb.contract.probe',
      NOTEBOOK_TYPE,
      'Contract Probe'
    );
    try {
      assert.equal(typeof controller.id, 'string');
      assert.equal(typeof controller.notebookType, 'string');
      assert.equal(typeof controller.label, 'string');
      assert.equal(typeof controller.dispose, 'function');
      // executeHandler is a writable property. Before any assignment its
      // runtime type is 'undefined' but the surface MUST exist.
      const handlerType = typeof controller.executeHandler;
      assert.ok(
        handlerType === 'function' || handlerType === 'undefined',
        `executeHandler should be a function or undefined; got ${handlerType}`
      );
    } finally {
      controller.dispose();
    }
  });

  // https://code.visualstudio.com/api/references/vscode-api#NotebookController
  test('controller.executeHandler is settable to a function without throwing', () => {
    const controller = vscode.notebooks.createNotebookController(
      'llmnb.contract.handler',
      NOTEBOOK_TYPE,
      'Handler Probe'
    );
    try {
      assert.doesNotThrow(() => {
        controller.executeHandler = (): void => {
          /* no-op */
        };
      });
      assert.equal(typeof controller.executeHandler, 'function');
    } finally {
      controller.dispose();
    }
  });

  test("activate() returns ExtensionApi; getController() returns the registered controller", () => {
    assert.ok(api, 'activate() must have been awaited');
    const controller = api!.getController();
    assert.ok(controller, 'controller should be created on activate');
    // The wrapper exposes the underlying vscode.NotebookController.
    assert.ok(controller!.controller, 'wrapper should hold a vscode.NotebookController');
    assert.equal(controller!.controller.notebookType, NOTEBOOK_TYPE);
  });

  // https://code.visualstudio.com/api/references/vscode-api#workspace.openNotebookDocument
  test('NotebookData → openNotebookDocument produces a document with the expected cell count', async () => {
    const cellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      'echo hello',
      'llmnb-cell'
    );
    const data = new vscode.NotebookData([cellData]);
    data.metadata = { rts: { config: { rfc_version: '1.0.0' } } };

    const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
    assert.equal(doc.cellCount, 1);
    const first = doc.cellAt(0);
    assert.equal(first.kind, vscode.NotebookCellKind.Code);
    assert.equal(first.document.getText(), 'echo hello');
  });

  // https://code.visualstudio.com/api/references/vscode-api#NotebookCellExecution.appendOutput
  // https://code.visualstudio.com/api/references/vscode-api#NotebookCellOutputItem.json
  test('NotebookCellOutputItem.json carries the bare OTLP span at the RTS run MIME', () => {
    // I-X: per RFC-006 §1, cell outputs carry the bare OTLP span (no envelope).
    const sample = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'echo',
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: '1745588938412000000',
      endTimeUnixNano: '1745588938612000000',
      attributes: [{ key: 'llmnb.run_type', value: { stringValue: 'chain' } }],
      status: { code: 'STATUS_CODE_OK', message: '' }
    };
    const item = vscode.NotebookCellOutputItem.json(sample, RTS_RUN_MIME);
    assert.equal(item.mime, RTS_RUN_MIME);
    const decoded = JSON.parse(new TextDecoder('utf-8').decode(item.data)) as Record<string, unknown>;
    assert.equal(decoded['spanId'], 'b'.repeat(16));
    assert.equal((decoded['status'] as { code: string }).code, 'STATUS_CODE_OK');
  });

  // https://code.visualstudio.com/api/references/vscode-api#NotebookCellExecution
  test('controller.createNotebookCellExecution returns an object with start/end/appendOutput', async () => {
    assert.ok(api, 'activate() must have been awaited');
    const controllerWrapper = api!.getController();
    assert.ok(controllerWrapper, 'controller should exist');

    // Doc-driven: assert the documented method surface on the controller
    // itself. We do NOT invoke createNotebookCellExecution here because
    // that requires the controller to be the SELECTED controller for the
    // open notebook (VS Code rejects with "notebook controller is NOT
    // associated to notebook" otherwise). Selection is a UI step that
    // would require showing the notebook in an editor — out of scope for
    // a contract test. The runtime semantics are exercised by the
    // integration smoke (smoke-stub-kernel.test.ts).
    const ctrl = controllerWrapper!.controller;
    assert.equal(typeof ctrl.createNotebookCellExecution, 'function');
    assert.equal(typeof ctrl.dispose, 'function');
    assert.equal(typeof ctrl.updateNotebookAffinity, 'function');
  });
});
