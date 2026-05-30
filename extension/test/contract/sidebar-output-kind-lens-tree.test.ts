// V2 Output-kind lens — TreeDataProvider contract tests.
//
// Uses the `SpansResolver` constructor seam to inject synthetic
// `TaggedSpan[]` directly. This avoids the VS Code quirk where
// `NotebookCellData.outputs` doesn't reliably populate
// `NotebookCell.outputs` after `openNotebookDocument`. Pure
// extraction logic is covered separately in
// `sidebar-output-kind-extractor.test.ts`.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  LENS_EMPTY,
  OutputKindLensTreeProvider,
  type SpansResolver
} from '../../src/sidebar/output-kind-lens/lens-tree.js';
import {
  InMemorySidebarMetadataSource,
  type NotebookSnapshot
} from '../../src/sidebar/metadata-source.js';
import type {
  LensNode,
  OutputKind,
  TaggedSpan
} from '../../src/sidebar/output-kind-lens/types.js';
import { OTHER_KIND_KEY } from '../../src/sidebar/output-kind-lens/types.js';
import { REVEAL_CELL_COMMAND_ID } from '../../src/notebook/commands/reveal-cell.js';

function makeSpan(opts: {
  cellIndex?: number;
  cellId?: string;
  spanId?: string;
  outputKind: OutputKind | typeof OTHER_KIND_KEY;
  agentId?: string;
  snippet?: string;
  timestampMs?: number;
}): TaggedSpan {
  return {
    cellIndex: opts.cellIndex ?? 0,
    cellId: opts.cellId ?? 'cell:test',
    spanId: opts.spanId ?? 'span-0001',
    outputKind: opts.outputKind,
    agentId: opts.agentId,
    snippet: opts.snippet ?? `${opts.outputKind} span`,
    timestampMs: opts.timestampMs ?? 0
  };
}

function inMemorySource(): {
  source: InMemorySidebarMetadataSource;
  snapshot: NotebookSnapshot;
} {
  const source = new InMemorySidebarMetadataSource();
  const snapshot: NotebookSnapshot = {
    uri: vscode.Uri.parse('file:///workspace/active.llmnb'),
    label: 'active.llmnb',
    metadata: {}
  };
  source.set([snapshot]);
  return { source, snapshot };
}

function fixed(spans: TaggedSpan[]): SpansResolver {
  return () => spans;
}

suite('contract: V2 OutputKindLensTreeProvider', () => {
  test('renders LENS_EMPTY when no spans are tagged', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(source, fixed([]));
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
      assert.equal((roots[0] as { message: string }).message, LENS_EMPTY);
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('groups tagged spans by kind and orders high-attention kinds first', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(
      source,
      fixed([
        makeSpan({ outputKind: 'plan', spanId: 'p1' }),
        makeSpan({ outputKind: 'decision', spanId: 'd1' }),
        makeSpan({ outputKind: 'plan', spanId: 'p2' }),
        makeSpan({ outputKind: 'warning', spanId: 'w1' })
      ])
    );
    try {
      const roots = provider.getChildren() as LensNode[];
      const kindOrder = roots
        .filter((n) => n.kind === 'kind-group')
        .map((n) => (n as { outputKind: string }).outputKind);
      assert.deepEqual(kindOrder, ['decision', 'warning', 'plan']);
      const counts = roots
        .filter((n) => n.kind === 'kind-group')
        .map((n) => (n as { count: number }).count);
      assert.deepEqual(counts, [1, 1, 2]);
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('kind-group children are the per-span rows with click-to-reveal', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(
      source,
      fixed([
        makeSpan({
          outputKind: 'decision',
          cellId: 'cell:decision-source',
          snippet: 'Decided X',
          agentId: 'alpha'
        })
      ])
    );
    try {
      const [group] = provider.getChildren() as LensNode[];
      const children = provider.getChildren(group);
      assert.equal(children.length, 1);
      assert.equal(children[0].kind, 'tagged-span');
      const item = provider.getTreeItem(children[0]);
      assert.ok(item.command);
      assert.equal(item.command!.command, REVEAL_CELL_COMMAND_ID);
      const args = item.command!.arguments?.[0] as { cell_id?: string };
      assert.equal(args.cell_id, 'cell:decision-source');
      assert.equal(item.label, 'Decided X');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('unknown output kinds bucket as the trailing <other> group', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(
      source,
      fixed([
        makeSpan({ outputKind: 'decision' }),
        makeSpan({ outputKind: OTHER_KIND_KEY })
      ])
    );
    try {
      const roots = provider.getChildren() as LensNode[];
      const kinds = roots
        .filter((n) => n.kind === 'kind-group')
        .map((n) => (n as { outputKind: string }).outputKind);
      assert.deepEqual(kinds, ['decision', OTHER_KIND_KEY]);
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('kind-group row description matches the bucket size (singular/plural)', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(
      source,
      fixed([
        makeSpan({ outputKind: 'decision', spanId: 'a' }),
        makeSpan({ outputKind: 'plan', spanId: 'b' }),
        makeSpan({ outputKind: 'plan', spanId: 'c' })
      ])
    );
    try {
      const roots = provider.getChildren() as LensNode[];
      const [decision, plan] = roots;
      assert.equal(provider.getTreeItem(decision).description, '1 span');
      assert.equal(provider.getTreeItem(plan).description, '2 spans');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('tagged-span row description carries the cell index + agent id', () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(
      source,
      fixed([
        makeSpan({
          outputKind: 'plan',
          cellIndex: 4,
          agentId: 'alpha'
        })
      ])
    );
    try {
      const [group] = provider.getChildren() as LensNode[];
      const [span] = provider.getChildren(group);
      const item = provider.getTreeItem(span);
      assert.equal(item.description, '#5 · alpha');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('no active zone -> empty render', () => {
    const source = new InMemorySidebarMetadataSource();
    const provider = new OutputKindLensTreeProvider(source, fixed([]));
    try {
      const roots = provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].kind, 'empty');
    } finally {
      provider.dispose();
      source.dispose();
    }
  });

  test('onDidChangeTreeData fires when the source changes', async () => {
    const { source } = inMemorySource();
    const provider = new OutputKindLensTreeProvider(source, fixed([]));
    const fires: number[] = [];
    provider.onDidChangeTreeData(() => fires.push(Date.now()));
    try {
      source.set([
        {
          uri: vscode.Uri.parse('file:///workspace/different.llmnb'),
          label: 'different.llmnb',
          metadata: {}
        }
      ]);
      await Promise.resolve();
      assert.ok(fires.length >= 1);
    } finally {
      provider.dispose();
      source.dispose();
    }
  });
});
