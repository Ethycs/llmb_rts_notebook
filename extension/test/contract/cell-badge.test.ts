// Contract tests for BSP-005 S1 — cell-as-agent identity badges + per-agent
// gutter colors. Pure-stub-kernel exercise; no live kernel required.
//
// Spec references:
//   atoms/concepts/cell.md           — what a cell IS, kind enum
//   atoms/concepts/agent.md          — agent_id / provider / runtime_status schema
//   atoms/concepts/cell-kinds.md     — directive vs comment vs promoted rules
//   atoms/protocols/family-a-otlp-spans.md — span attribute `llmnb.agent_id`
//   docs/notebook/BSP-002-conversation-graph.md §6 — issuance rule
//   docs/notebook/BSP-005-cell-roadmap.md §S1 — slice scope (X-EXT only)

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { encodeAttrs } from '../../src/otel/attrs.js';
import {
  AgentRegistryImpl,
  CellBadgeStatusBarProvider,
  GutterColorManager,
  InMemoryColorStore,
  GUTTER_COLOR_STATE_KEY,
  PROMOTED_BADGE_SUFFIX,
  agentIdToColor,
  computeCellBadge,
  hslToHex,
  fnv1a
} from '../../src/notebook/cell-badge.js';

const NOTEBOOK_TYPE = 'llmnb';
const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** Build a closed OTLP span carrying `llmnb.agent_id` so the cell renders
 *  the badge from the wire-source-of-truth (atoms/protocols/family-a-otlp-spans.md). */
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

/** Manufacture a minimal NotebookCell-shaped object with the surface the
 *  badge code reads. We pass this directly into computeCellBadge / the
 *  provider; we don't go through openNotebookDocument because the contract
 *  layer doesn't need to round-trip a real NotebookDocument for a pure
 *  status-bar-item assertion (and openNotebookDocument cells are read-only —
 *  cell.metadata cannot be mutated after construction without an edit). */
interface FakeCell {
  kind: vscode.NotebookCellKind;
  outputs: vscode.NotebookCellOutput[];
  metadata: Record<string, unknown>;
  /** Surfaces present on real NotebookCell that the badge module never
   *  reads but the type checker insists exist. */
  index: number;
  notebook: vscode.NotebookDocument;
  document: vscode.TextDocument;
  executionSummary?: vscode.NotebookCellExecutionSummary;
}

function fakeCell(opts: {
  kind?: vscode.NotebookCellKind;
  outputs?: vscode.NotebookCellOutput[];
  metadata?: Record<string, unknown>;
}): vscode.NotebookCell {
  const cell: FakeCell = {
    kind: opts.kind ?? vscode.NotebookCellKind.Code,
    outputs: opts.outputs ?? [],
    metadata: opts.metadata ?? {},
    index: 0,
    notebook: undefined as unknown as vscode.NotebookDocument,
    document: undefined as unknown as vscode.TextDocument
  };
  return cell as unknown as vscode.NotebookCell;
}

function outputWithSpan(payload: unknown): vscode.NotebookCellOutput {
  const item = vscode.NotebookCellOutputItem.json(payload, RTS_RUN_MIME);
  return new vscode.NotebookCellOutput([item]);
}

suite('contract: BSP-005 S1 — cell badges + gutter colors', () => {

  // --------------------------------------------------------------------------
  // S1.1 — status-bar badge
  // --------------------------------------------------------------------------

  test('test_directive_cell_renders_badge_with_agent_id_provider_status', () => {
    // Fixture: a directive (code-kind) cell carrying one closed span with
    // `llmnb.agent_id="alpha"` on its outputs. Agent registry knows alpha
    // has provider=claude-code and runtime_status=idle.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'idle' });
    const provider = new CellBadgeStatusBarProvider(registry);
    try {
      const cell = fakeCell({
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 1, 'directive cell must surface exactly one status-bar badge');
      // BSP-005 S1 / BSP-002 §6 shape: `<agent_id> · <provider> · <runtime_status>`.
      assert.equal(items[0].text, 'alpha · claude-code · idle');
      assert.equal(
        items[0].alignment,
        vscode.NotebookCellStatusBarAlignment.Left,
        'badge MUST sit on the left per BSP-005 S1 (where the operator scans first)'
      );
    } finally {
      provider.dispose();
      registry.dispose();
    }
  });

  test('test_comment_cell_carries_no_badge', () => {
    // Comment cells (atoms/concepts/cell-kinds.md `markdown` row) carry no
    // agent. The provider MUST return zero items so the cell shows nothing.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'idle' });
    const provider = new CellBadgeStatusBarProvider(registry);
    try {
      // Markup-kind cells map to atoms cell-kinds `markdown`. Even with a
      // span lying around (operator paste, drift) the provider MUST NOT
      // render a badge — `markdown` MUST NOT carry bound_agent_id.
      const cell = fakeCell({
        kind: vscode.NotebookCellKind.Markup,
        outputs: [outputWithSpan(spanForAgent('alpha'))]
      });
      const items = provider.provideCellStatusBarItems(
        cell,
        new vscode.CancellationTokenSource().token
      ) as vscode.NotebookCellStatusBarItem[];
      assert.equal(items.length, 0, 'comment / markdown cells MUST NOT carry an agent badge');
      // computeCellBadge returns undefined for the same case (pure-function
      // contract) so anything else consuming the API stays consistent.
      assert.equal(computeCellBadge(cell, registry), undefined);
    } finally {
      provider.dispose();
      registry.dispose();
    }
  });

  test('test_promoted_cell_has_promoted_suffix', () => {
    // A promoted cell (atoms/operations/promote-span.md) renders with the
    // source span's agent id and a " (promoted)" suffix per cell-kinds.md.
    const registry = new AgentRegistryImpl();
    registry.upsert({ agent_id: 'alpha', provider: 'claude-code', runtime_status: 'idle' });
    const cell = fakeCell({
      outputs: [outputWithSpan(spanForAgent('alpha'))],
      metadata: { rts: { cell: { kind: 'agent', promoted: true, bound_agent_id: 'alpha' } } }
    });
    const badge = computeCellBadge(cell, registry);
    assert.ok(badge, 'promoted directive cell must produce a badge');
    assert.ok(
      badge!.text.endsWith(PROMOTED_BADGE_SUFFIX),
      `badge text "${badge!.text}" must end with the promoted suffix "${PROMOTED_BADGE_SUFFIX}"`
    );
    assert.equal(badge!.text, `alpha · claude-code · idle${PROMOTED_BADGE_SUFFIX}`);
    assert.equal(badge!.promoted, true);
  });

  // --------------------------------------------------------------------------
  // S1.2 — stable per-agent gutter color
  // --------------------------------------------------------------------------

  test('test_gutter_color_stable_across_reload', () => {
    // Step 1 — a fresh workspace assigns a color for alpha.
    const store1 = new InMemoryColorStore();
    const mgr1 = new GutterColorManager(store1);
    const colorBeforeReload = mgr1.colorFor('alpha');
    assert.match(colorBeforeReload, /^#[0-9a-f]{6}$/, 'color must be a #rrggbb hex string');
    // The color is persisted under the documented workspaceState key.
    const persisted = store1.get<Record<string, string>>(GUTTER_COLOR_STATE_KEY);
    assert.ok(persisted, 'workspaceState entry must exist after first sight');
    assert.equal(persisted!['alpha'], colorBeforeReload);

    // Step 2 — simulate VS Code reload: a new store seeded from the
    // persisted snapshot, then a new manager reads it back.
    const store2 = new InMemoryColorStore();
    store2.load(store1.snapshot());
    const mgr2 = new GutterColorManager(store2);
    const colorAfterReload = mgr2.colorFor('alpha');
    assert.equal(
      colorAfterReload,
      colorBeforeReload,
      'gutter color for the same agent_id MUST be stable across reload'
    );
  });

  test('test_gutter_color_deterministic_per_agent_id', () => {
    // Insertion-order independence: regardless of how / when an agent is
    // first seen, the color is a pure function of `agent_id`.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const reverse = [...ids].reverse();

    const fwd = new GutterColorManager(new InMemoryColorStore());
    const rev = new GutterColorManager(new InMemoryColorStore());

    const fwdColors: Record<string, string> = {};
    for (const id of ids) {
      fwdColors[id] = fwd.colorFor(id);
    }
    const revColors: Record<string, string> = {};
    for (const id of reverse) {
      revColors[id] = rev.colorFor(id);
    }
    for (const id of ids) {
      assert.equal(
        fwdColors[id],
        revColors[id],
        `agent_id="${id}" must yield the same color irrespective of insertion order`
      );
      // The pure function MUST agree with the manager.
      assert.equal(agentIdToColor(id), fwdColors[id]);
    }

    // Sanity: distinct agent ids produce distinct hashes (collisions are
    // theoretically possible but our test set should not collide). If this
    // ever flakes, add a small "tweak the hue" step in the manager.
    const colorSet = new Set(Object.values(fwdColors));
    assert.equal(colorSet.size, ids.length, 'distinct agent_ids should produce distinct colors');

    // Sanity: the helpers are themselves deterministic.
    assert.equal(fnv1a('alpha'), fnv1a('alpha'));
    assert.equal(hslToHex(0, 0, 0), '#000000');
    assert.equal(hslToHex(0, 0, 1), '#ffffff');
  });
});
