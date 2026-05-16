// Contract tests for PLAN-S5.0.4 §3.5 — privileged magic emission UI.
// Pure-stub exercise; no live kernel required.
//
// Covers:
//   - Promotion chip renders only for K3L entries on cells whose agent
//     holds an active grant.
//   - Promotion chip click emits a promote_stream_magic operator-action.
//   - Cell-toolbar Grant chip appears on agent cells WITHOUT a grant.
//   - Cell-toolbar Revoke chip appears on agent cells WITH a grant.
//   - Privilege header chip text reflects grant count + revoke menu
//     emits revoke_magic_emit_privilege.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.4-privileged-magic-emission.md §3.5
//   docs/atoms/discipline/certified-magic-emitter.md (privileged-agent V2+ row)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ContaminationRegistry,
  computePromotionChips,
  formatPromotionChipText,
  PROMOTE_STREAM_MAGIC_COMMAND_ID,
  K3L_PRIVILEGED_AGENT_STREAM_MAGIC,
  type PrivilegeRegistry as PromotionPrivilegeRegistry
} from '../../src/notebook/contamination-badge.js';
import {
  PrivilegeRegistry,
  computePrivilegeHeaderChip,
  buildMenuItems,
  parseMenuPick,
  openPrivilegeMenu,
  type OperatorActionEmitter,
  type PrivilegeQuickPickSink,
  PRIVILEGE_CHIP_PREFIX
} from '../../src/notebook/header-chips.js';
import {
  computeCellToolbarItems,
  GRANT_PRIVILEGE_COMMAND_ID,
  REVOKE_PRIVILEGE_COMMAND_ID,
  GRANT_TOOLBAR_TEXT,
  REVOKE_TOOLBAR_TEXT,
  runGrantCommand,
  runRevokeCommand,
  type GrantConfirmSink
} from '../../src/notebook/cell-toolbar.js';
import type { NotebookMetadataPayload } from '../../src/messaging/types.js';

interface FakeCell {
  kind: vscode.NotebookCellKind;
  outputs: vscode.NotebookCellOutput[];
  metadata: Record<string, unknown>;
  index: number;
  notebook: vscode.NotebookDocument;
  document: vscode.TextDocument;
}

function fakeCell(opts: {
  uri?: string;
  metadata?: Record<string, unknown>;
}): vscode.NotebookCell {
  const uri = opts.uri ?? 'vscode-notebook-cell:test#emit';
  const fakeDoc = {
    uri: vscode.Uri.parse(uri)
  } as unknown as vscode.TextDocument;
  const cell: FakeCell = {
    kind: vscode.NotebookCellKind.Code,
    outputs: [],
    metadata: opts.metadata ?? {},
    index: 0,
    notebook: undefined as unknown as vscode.NotebookDocument,
    document: fakeDoc
  };
  return cell as unknown as vscode.NotebookCell;
}

function snapshotPayload(
  cells: Record<string, unknown>,
  config?: Record<string, unknown>
): NotebookMetadataPayload {
  return {
    mode: 'snapshot',
    snapshot_version: 1,
    snapshot: {
      schema_version: '1.0.0',
      cells,
      config: config ?? {}
    }
  } as unknown as NotebookMetadataPayload;
}

/** Stub privilege registry for the promotion-chip path. The
 *  promotion-chip helper uses only ``hasGrant`` so a thin stub
 *  suffices. */
class StubPrivilegeRegistry implements PromotionPrivilegeRegistry {
  private readonly grants: Set<string> = new Set();
  public grant(agent_id: string): void {
    this.grants.add(agent_id);
  }
  public hasGrant(agent_id: string): boolean {
    return this.grants.has(agent_id);
  }
}

/** Capturing emitter — records every operator-action envelope. */
class CapturingEmitter implements OperatorActionEmitter {
  public readonly out: Array<{ action: string; params: Record<string, unknown> }> = [];
  public emit(action_type: string, parameters: Record<string, unknown>): void {
    this.out.push({ action: action_type, params: parameters });
  }
}

suite('contract: PLAN-S5.0.4 §3.5 — privileged magic emission UI', () => {
  // -------------------------------------------------------------------------
  // Promotion chip
  // -------------------------------------------------------------------------

  test('test_promotion_chip_renders_for_K3L_on_privileged_agent', () => {
    const contam = new ContaminationRegistry();
    contam.upsert('c_src', {
      contaminated: true,
      bound_agent_id: 'alpha',
      contamination_log: [
        {
          line: '@@spawn beta',
          source: 'stdout',
          ts: '2026-05-14T00:00:00Z',
          layer: 'plain',
          k_class: K3L_PRIVILEGED_AGENT_STREAM_MAGIC
        }
      ]
    });
    const privs = new StubPrivilegeRegistry();
    privs.grant('alpha');
    const cell = fakeCell({
      uri: 'vscode-notebook-cell:test#emit',
      metadata: { rts: { cell: { id: 'c_src' } } }
    });
    const chips = computePromotionChips(cell, contam, privs);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].agent_id, 'alpha');
    assert.equal(chips[0].cell_id, 'c_src');
    assert.equal(chips[0].line, '@@spawn beta');
    assert.match(chips[0].text, /promote/);
  });

  test('test_promotion_chip_hidden_when_agent_has_no_grant', () => {
    const contam = new ContaminationRegistry();
    contam.upsert('c_src', {
      contaminated: true,
      bound_agent_id: 'alpha',
      contamination_log: [
        {
          line: '@@spawn beta',
          source: 'stdout',
          ts: '2026-05-14T00:00:00Z',
          layer: 'plain',
          k_class: K3L_PRIVILEGED_AGENT_STREAM_MAGIC
        }
      ]
    });
    const privs = new StubPrivilegeRegistry();
    // No grant for alpha — chip MUST NOT render even if K3L is present.
    const cell = fakeCell({
      uri: 'vscode-notebook-cell:test#emit',
      metadata: { rts: { cell: { id: 'c_src' } } }
    });
    const chips = computePromotionChips(cell, contam, privs);
    assert.equal(chips.length, 0);
  });

  test('test_promotion_chip_hidden_for_non_K3L_entries', () => {
    const contam = new ContaminationRegistry();
    contam.upsert('c_src', {
      contaminated: true,
      bound_agent_id: 'alpha',
      contamination_log: [
        {
          line: '@@spawn beta',
          source: 'stdout',
          ts: '2026-05-14T00:00:00Z',
          layer: 'plain'
          // No k_class -- unprivileged-agent contamination.
        }
      ]
    });
    const privs = new StubPrivilegeRegistry();
    privs.grant('alpha');
    const cell = fakeCell({
      uri: 'vscode-notebook-cell:test#emit',
      metadata: { rts: { cell: { id: 'c_src' } } }
    });
    const chips = computePromotionChips(cell, contam, privs);
    assert.equal(chips.length, 0);
  });

  test('test_promotion_chip_text_is_truncated_prefix', () => {
    const t = formatPromotionChipText('@@spawn beta task=research-the-long-thing');
    assert.match(t, /^↑ promote /);
    assert.ok(t.length <= 64);
  });

  test('test_promotion_command_id_is_stable_token', () => {
    assert.equal(PROMOTE_STREAM_MAGIC_COMMAND_ID, 'llmnb.promoteStreamMagic');
  });

  // -------------------------------------------------------------------------
  // Cell toolbar (Grant / Revoke)
  // -------------------------------------------------------------------------

  test('test_grant_chip_renders_on_agent_cell_without_grant', () => {
    const privs = new PrivilegeRegistry();
    const cell = fakeCell({
      metadata: { kind: 'agent', bound_agent_id: 'alpha' }
    });
    const items = computeCellToolbarItems(cell, privs);
    assert.equal(items.length, 1);
    assert.equal(items[0].command, GRANT_PRIVILEGE_COMMAND_ID);
    assert.equal(items[0].text, GRANT_TOOLBAR_TEXT);
    assert.equal(items[0].agent_id, 'alpha');
  });

  test('test_revoke_chip_renders_on_agent_cell_with_grant', () => {
    const privs = new PrivilegeRegistry();
    privs.set([
      {
        agent_id: 'alpha',
        zone_id: 'z1',
        granted_at: '2026-05-14T00:00:00Z',
        scope: { magics: 'all' }
      }
    ]);
    const cell = fakeCell({
      metadata: { kind: 'agent', bound_agent_id: 'alpha' }
    });
    const items = computeCellToolbarItems(cell, privs);
    assert.equal(items.length, 1);
    assert.equal(items[0].command, REVOKE_PRIVILEGE_COMMAND_ID);
    assert.equal(items[0].text, REVOKE_TOOLBAR_TEXT);
  });

  test('test_no_toolbar_on_non_agent_cells', () => {
    const privs = new PrivilegeRegistry();
    privs.set([
      {
        agent_id: 'alpha',
        zone_id: 'z1',
        granted_at: 'now',
        scope: { magics: 'all' }
      }
    ]);
    // markdown cell — no toolbar regardless of grant state.
    const md = fakeCell({ metadata: { kind: 'markdown' } });
    assert.equal(computeCellToolbarItems(md, privs).length, 0);
    // Cell with no bound_agent_id — no toolbar.
    const orphan = fakeCell({ metadata: { kind: 'agent' } });
    assert.equal(computeCellToolbarItems(orphan, privs).length, 0);
  });

  test('test_grant_command_emits_operator_action_after_confirm', async () => {
    const emitter = new CapturingEmitter();
    const sink: GrantConfirmSink = {
      confirm: async (_agent_id: string) => ({ scope: { magics: 'all' as const } })
    };
    const ok = await runGrantCommand(
      { agent_id: 'alpha', zone_id: 'z1' },
      sink,
      emitter
    );
    assert.equal(ok, true);
    assert.equal(emitter.out.length, 1);
    assert.equal(emitter.out[0].action, 'grant_magic_emit_privilege');
    assert.deepEqual(emitter.out[0].params, {
      agent_id: 'alpha',
      zone_id: 'z1',
      scope: { magics: 'all' }
    });
  });

  test('test_grant_command_aborts_on_cancel_no_envelope', async () => {
    const emitter = new CapturingEmitter();
    const sink: GrantConfirmSink = {
      confirm: async (_agent_id: string) => undefined
    };
    const ok = await runGrantCommand(
      { agent_id: 'alpha' },
      sink,
      emitter
    );
    assert.equal(ok, false);
    assert.equal(emitter.out.length, 0);
  });

  test('test_revoke_command_emits_operator_action', async () => {
    const emitter = new CapturingEmitter();
    const ok = await runRevokeCommand(
      { agent_id: 'alpha', zone_id: 'z1' },
      emitter
    );
    assert.equal(ok, true);
    assert.equal(emitter.out.length, 1);
    assert.equal(emitter.out[0].action, 'revoke_magic_emit_privilege');
    assert.deepEqual(emitter.out[0].params, {
      agent_id: 'alpha',
      zone_id: 'z1'
    });
  });

  // -------------------------------------------------------------------------
  // Privilege header chip
  // -------------------------------------------------------------------------

  test('test_privilege_header_chip_count_reflects_registry', () => {
    const registry = new PrivilegeRegistry();
    let chip = computePrivilegeHeaderChip(registry.list());
    assert.equal(chip.count, 0);
    assert.match(chip.text, /\(0\)$/);
    assert.ok(chip.text.startsWith(PRIVILEGE_CHIP_PREFIX));

    registry.set([
      { agent_id: 'alpha', zone_id: 'z1', granted_at: 'now', scope: { magics: 'all' } },
      { agent_id: 'beta', zone_id: 'z1', granted_at: 'now', scope: { magics: ['spawn'] } }
    ]);
    chip = computePrivilegeHeaderChip(registry.list());
    assert.equal(chip.count, 2);
    assert.match(chip.text, /\(2\)$/);
  });

  test('test_privilege_registry_absorbs_snapshot', () => {
    const registry = new PrivilegeRegistry();
    registry.onNotebookMetadata(
      snapshotPayload({}, {
        magic_emit_privileges: [
          {
            agent_id: 'alpha',
            zone_id: 'z1',
            granted_at: '2026-05-14T00:00:00Z',
            scope: { magics: ['spawn'] }
          }
        ]
      })
    );
    assert.equal(registry.list().length, 1);
    assert.ok(registry.hasGrant('alpha'));
    assert.equal(registry.hasGrant('unknown'), false);
  });

  test('test_privilege_menu_revoke_emits_envelope', async () => {
    const registry = new PrivilegeRegistry();
    registry.set([
      { agent_id: 'alpha', zone_id: 'z1', granted_at: 'now', scope: { magics: 'all' } }
    ]);
    const emitter = new CapturingEmitter();
    const items = buildMenuItems(registry.list());
    assert.equal(items.length, 1);
    const sink: PrivilegeQuickPickSink = {
      pick: async (_items: string[]) => items[0]
    };
    const picked = await openPrivilegeMenu(registry, sink, emitter);
    assert.ok(picked);
    assert.equal(picked!.agent_id, 'alpha');
    assert.equal(emitter.out.length, 1);
    assert.equal(emitter.out[0].action, 'revoke_magic_emit_privilege');
    assert.deepEqual(emitter.out[0].params, { agent_id: 'alpha', zone_id: 'z1' });
  });

  test('test_privilege_menu_parses_sentinel_no_grants', () => {
    const items = buildMenuItems([]);
    assert.deepEqual(items, ['(no active grants)']);
    const parsed = parseMenuPick(items[0], []);
    assert.equal(parsed, null);
  });
});
