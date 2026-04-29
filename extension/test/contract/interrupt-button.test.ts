// Contract tests for BSP-005 S9 — cell-toolbar interrupt button (extension
// half). Pure-stub-kernel exercise; no live kernel required.
//
// Spec references:
//   atoms/concepts/agent.md                 — runtime_status semantics
//   atoms/operations/stop-agent.md          — stop vs interrupt distinction
//   atoms/protocols/operator-action.md      — outer envelope shape (locked)
//   docs/notebook/BSP-005-cell-roadmap.md §S9 — slice scope (X-EXT-S9)
//
// Wire envelope (locked by S9 brief):
//   {
//     "type": "operator.action",
//     "payload": {
//       "action_type": "agent_interrupt",
//       "agent_id": "alpha"
//     }
//   }

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { encodeAttrs } from '../../src/otel/attrs.js';
import { AgentRegistryImpl } from '../../src/notebook/cell-badge.js';
import {
  InterruptButtonStatusBarProvider,
  LocalOverrideStore,
  INTERRUPT_BUTTON_TEXT,
  INTERRUPT_COMMAND_ID,
  TRANSIENT_INTERRUPTING_STATUS,
  computeInterruptButton,
  postAgentInterrupt
} from '../../src/notebook/interrupt-button.js';
import { MessageRouter } from '../../src/messaging/router.js';
import type { RtsV2Envelope } from '../../src/messaging/types.js';

const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** A LogOutputChannel-shaped sink that drops everything (mirrors the helper
 *  used by message-router.test.ts). */
function silentLogger(): vscode.LogOutputChannel {
  const noop = (): void => {
    /* drop */
  };
  return {
    name: 'interrupt-button-test-log',
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

/** Minimal closed OTLP span carrying `llmnb.agent_id` so the cell resolves
 *  its bound agent from the wire-source-of-truth (mirrors cell-badge.test.ts). */
function spanForAgent(agent_id: string): unknown {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'stub.echo',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: '1745588938412000000',
    endTimeUnixNano: '1745588938612000000',
    attributes: encodeAttrs({
      'llmnb.run_type': 'chain',
      'llmnb.agent_id': agent_id
    }),
    status: { code: 'STATUS_CODE_OK', message: '' }
  };
}

/** Same FakeCell shape cell-badge.test.ts uses; the real NotebookCell
 *  surface is read-only and rejects ad-hoc metadata mutation. */
interface FakeCell {
  kind: vscode.NotebookCellKind;
  outputs: vscode.NotebookCellOutput[];
  metadata: Record<string, unknown>;
  index: number;
  notebook: vscode.NotebookDocument;
  document: vscode.TextDocument;
  executionSummary?: vscode.NotebookCellExecutionSummary;
}

function fakeCell(opts: {
  kind?: vscode.NotebookCellKind;
  outputs?: vscode.NotebookCellOutput[];
  metadata?: Record<string, unknown>;
  uri?: string;
}): vscode.NotebookCell {
  const uri = opts.uri ?? 'vscode-notebook-cell:test#interrupt';
  const fakeDoc = {
    uri: vscode.Uri.parse(uri)
  } as unknown as vscode.TextDocument;
  const cell: FakeCell = {
    kind: opts.kind ?? vscode.NotebookCellKind.Code,
    outputs: opts.outputs ?? [],
    metadata: opts.metadata ?? {},
    index: 0,
    notebook: undefined as unknown as vscode.NotebookDocument,
    document: fakeDoc
  };
  return cell as unknown as vscode.NotebookCell;
}

function outputWithSpan(payload: unknown): vscode.NotebookCellOutput {
  const item = vscode.NotebookCellOutputItem.json(payload, RTS_RUN_MIME);
  return new vscode.NotebookCellOutput([item]);
}

suite('contract: BSP-005 S9 — cell interrupt button', () => {

  // --------------------------------------------------------------------------
  // Visibility rules
  // --------------------------------------------------------------------------

  test('test_interrupt_button_present_for_active_agent', () => {
    // Fixture: a directive cell whose bound agent has runtime_status="active".
    // The provider MUST surface a single "■ interrupt" status-bar item.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'active' });
    const overrides = new LocalOverrideStore();
    const provider = new InterruptButtonStatusBarProvider(registry, overrides);
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(
        items.length,
        1,
        'active-agent directive cell MUST surface exactly one interrupt button'
      );
      assert.equal(items[0].text, INTERRUPT_BUTTON_TEXT);
      // The button MUST be wired to the llmnb.interruptCell command so
      // VS Code dispatches the click to extension.ts's handler.
      const cmd = items[0].command;
      assert.ok(cmd && typeof cmd === 'object', 'item.command must be a Command object');
      const cmdObj = cmd as vscode.Command;
      assert.equal(cmdObj.command, INTERRUPT_COMMAND_ID);
      const args = (cmdObj.arguments ?? [])[0] as { agent_id: string; cell_id: string };
      assert.equal(args.agent_id, 'alpha');
    } finally {
      provider.dispose();
      overrides.dispose();
      registry.dispose();
    }
  });

  test('test_interrupt_button_present_for_spawning_agent', () => {
    // Spawning is the second eligible state per BSP-005 §S9. The button MUST
    // appear so the operator can abort a stuck spawn.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'spawning' });
    const overrides = new LocalOverrideStore();
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const desc = computeInterruptButton(cell, registry, overrides);
      assert.ok(desc, 'spawning-agent cell MUST produce an interrupt button');
      assert.equal(desc!.text, INTERRUPT_BUTTON_TEXT);
    } finally {
      overrides.dispose();
      registry.dispose();
    }
  });

  test('test_interrupt_button_hidden_for_idle_agent', () => {
    // BSP-005 §S9 visibility rule: hide for `idle`. No button MUST appear.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'idle' });
    const overrides = new LocalOverrideStore();
    const provider = new InterruptButtonStatusBarProvider(registry, overrides);
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0, 'idle-agent cell MUST NOT carry an interrupt button');
      assert.equal(computeInterruptButton(cell, registry, overrides), undefined);
    } finally {
      provider.dispose();
      overrides.dispose();
      registry.dispose();
    }
  });

  test('test_interrupt_button_hidden_for_exited_agent', () => {
    // BSP-005 §S9 visibility rule: hide for `exited` — the agent process is
    // gone and an interrupt has nothing to signal.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'exited' });
    const overrides = new LocalOverrideStore();
    const provider = new InterruptButtonStatusBarProvider(registry, overrides);
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0, 'exited-agent cell MUST NOT carry an interrupt button');
      assert.equal(computeInterruptButton(cell, registry, overrides), undefined);
    } finally {
      provider.dispose();
      overrides.dispose();
      registry.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Click → wire envelope
  // --------------------------------------------------------------------------

  test('test_interrupt_click_posts_agent_interrupt_envelope', () => {
    // Click handler captured: the outbound envelope MUST carry
    // `action_type: "agent_interrupt"` with the bound agent_id, matching
    // the BSP-005 §S9 locked wire shape.
    const router = new MessageRouter(silentLogger());
    const overrides = new LocalOverrideStore();
    const captured: RtsV2Envelope<unknown>[] = [];
    const sub = router.subscribeOutbound((env) => captured.push(env));
    try {
      postAgentInterrupt(router, overrides, {
        agent_id: 'alpha',
        cell_id: 'vscode-notebook-cell:test#c1'
      });
      assert.equal(captured.length, 1, 'click MUST post exactly one outbound envelope');
      const env = captured[0] as RtsV2Envelope<Record<string, unknown>>;
      assert.equal(env.type, 'operator.action');
      const payload = env.payload as Record<string, unknown>;
      assert.equal(payload['action_type'], 'agent_interrupt');
      // Locked wire shape: agent_id appears at the payload root (S9 brief).
      assert.equal(payload['agent_id'], 'alpha');
      // The standard operator-action shape is also honored — kernel-side
      // dispatchers reading `parameters.agent_id` continue to work.
      const params = payload['parameters'] as Record<string, unknown> | undefined;
      assert.ok(params, 'envelope payload should carry a parameters block');
      assert.equal((params as Record<string, unknown>)['agent_id'], 'alpha');
      assert.equal((params as Record<string, unknown>)['cell_id'], 'vscode-notebook-cell:test#c1');
      // Cell attribution survives so the kernel can route UI feedback
      // back to the originating cell decoration.
      assert.equal(payload['originating_cell_id'], 'vscode-notebook-cell:test#c1');
    } finally {
      sub.dispose();
      overrides.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Optimistic UI
  // --------------------------------------------------------------------------

  test('test_interrupt_optimistic_hide_after_click', () => {
    // Before the click: button is visible (agent is active).
    // After the click: the optimistic-override store carries
    // runtime_status="interrupting" for the agent, and the button MUST
    // hide without waiting for a kernel response.
    const router = new MessageRouter(silentLogger());
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'active' });
    const overrides = new LocalOverrideStore();
    const provider = new InterruptButtonStatusBarProvider(registry, overrides);
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      // Pre-click: button visible.
      const before = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(before.length, 1, 'sanity: button is visible while agent is active');

      // Click: helper sets the override + ships envelope synchronously.
      postAgentInterrupt(router, overrides, {
        agent_id: 'alpha',
        cell_id: cell.document.uri.toString()
      });

      // Override store reflects the transient status.
      assert.equal(
        overrides.get('alpha'),
        TRANSIENT_INTERRUPTING_STATUS,
        'override MUST carry the transient interrupting status after click'
      );

      // Post-click: button hides even though the registry still says active.
      assert.equal(
        registry.get('alpha')?.runtime_status,
        'active',
        'registry retains the kernel-authoritative status until the next snapshot'
      );
      const after = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(
        after.length,
        0,
        'button MUST hide immediately after click without waiting for kernel response'
      );
    } finally {
      provider.dispose();
      overrides.dispose();
      registry.dispose();
    }
  });
});
