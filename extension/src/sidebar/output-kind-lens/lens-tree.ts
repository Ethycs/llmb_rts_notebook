// V2 Output-kind lens — TreeDataProvider.
//
// Top-level: one `kind-group` row per output kind that has at least
// one tagged span in the active notebook. Children: per-span rows
// with click-to-reveal via `llmnb.revealCell`.
//
// Mirrors the S7 sidebar tree pattern (zones-tree / agents-tree):
// pure compute lives in extractor.ts; the provider subscribes to the
// shared SidebarMetadataSource for change signals.

import * as vscode from 'vscode';
import type { SidebarMetadataSource } from '../metadata-source.js';
import {
  OTHER_KIND_KEY,
  OUTPUT_KIND_ORDER,
  type LensNode,
  type OutputKind,
  type TaggedSpan
} from './types.js';
import { extractTaggedSpans, groupByKind } from './extractor.js';
import { REVEAL_CELL_COMMAND_ID } from '../../notebook/commands/reveal-cell.js';

/** Optional injectable spans resolver. Tests use it to provide
 *  `TaggedSpan[]` directly instead of relying on VS Code's
 *  `NotebookCellData.outputs` -> `NotebookCell.outputs` plumbing
 *  (which is unreliable across `openNotebookDocument` paths). */
export type SpansResolver = (
  source: SidebarMetadataSource
) => ReadonlyArray<TaggedSpan>;

/** Empty-state copy when the active notebook has no tagged spans
 *  (either no agent_emit outputs yet, or none of them carry
 *  `llmnb.output.kind`). Centralised here so the test pins the
 *  string. */
export const LENS_EMPTY = 'No tagged outputs. Run cells whose agents emit decisions, plans, or diagnostics.';

/** Per-kind row icon. Maps each output kind to a codicon that hints
 *  at the operator-visible semantics. */
function getKindIcon(kind: OutputKind | typeof OTHER_KIND_KEY): string {
  switch (kind) {
    case 'decision':     return 'check';
    case 'question':     return 'question';
    case 'warning':      return 'warning';
    case 'diagnostic':   return 'alert';
    case 'plan':         return 'list-ordered';
    case 'patch':        return 'git-pull-request';
    case 'diff':         return 'diff';
    case 'test_result':  return 'beaker';
    case 'checkpoint':   return 'bookmark';
    case 'code':         return 'code';
    case 'prose':        return 'comment';
    case 'artifact_ref': return 'file-symlink-directory';
    default:             return 'circle-small';
  }
}

/** Human-readable label for the kind-group row header. */
function getKindLabel(kind: OutputKind | typeof OTHER_KIND_KEY): string {
  if (kind === OTHER_KIND_KEY) return 'other';
  return kind;
}

export class OutputKindLensTreeProvider
  implements vscode.TreeDataProvider<LensNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<LensNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private readonly subscription: vscode.Disposable;
  private readonly spansResolver: SpansResolver;

  public constructor(
    private readonly source: SidebarMetadataSource,
    spansResolver?: SpansResolver
  ) {
    this.spansResolver = spansResolver ?? defaultSpansResolver;
    this.subscription = this.source.onChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public getTreeItem(node: LensNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(
          node.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'kind-group': {
        const label = getKindLabel(node.outputKind);
        const item = new vscode.TreeItem(
          label,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.description = node.count === 1 ? '1 span' : `${node.count} spans`;
        item.iconPath = new vscode.ThemeIcon(getKindIcon(node.outputKind));
        item.contextValue = 'llmnb.sidebar.lens.kindGroup';
        return item;
      }
      case 'tagged-span':
        return this.buildSpanItem(node.span);
    }
  }

  public getChildren(node?: LensNode): LensNode[] {
    const spans = this.spansResolver(this.source);
    if (!node) {
      if (spans.length === 0) {
        return [{ kind: 'empty', message: LENS_EMPTY }];
      }
      const groups = groupByKind(spans);
      const result: LensNode[] = [];
      // Render kinds in the canonical order; unknown / `<other>`
      // bucket goes last when present.
      for (const k of OUTPUT_KIND_ORDER) {
        const bucket = groups.get(k);
        if (bucket && bucket.length > 0) {
          result.push({ kind: 'kind-group', outputKind: k, count: bucket.length });
        }
      }
      const other = groups.get(OTHER_KIND_KEY);
      if (other && other.length > 0) {
        result.push({ kind: 'kind-group', outputKind: OTHER_KIND_KEY, count: other.length });
      }
      return result;
    }
    if (node.kind === 'kind-group') {
      const groups = groupByKind(spans);
      const bucket = groups.get(node.outputKind) ?? [];
      return bucket.map((s): LensNode => ({ kind: 'tagged-span', span: s }));
    }
    return [];
  }

  private buildSpanItem(span: TaggedSpan): vscode.TreeItem {
    const item = new vscode.TreeItem(
      span.snippet,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = `#${span.cellIndex + 1}${span.agentId ? ` · ${span.agentId}` : ''}`;
    item.tooltip = `${span.outputKind} · cell #${span.cellIndex + 1}${
      span.agentId ? ` · ${span.agentId}` : ''
    }${span.timestampMs > 0 ? ` · ${new Date(span.timestampMs).toISOString()}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(getKindIcon(span.outputKind));
    item.contextValue = 'llmnb.sidebar.lens.taggedSpan';
    if (span.cellId) {
      item.command = {
        command: REVEAL_CELL_COMMAND_ID,
        title: 'Reveal cell',
        arguments: [{ cell_id: span.cellId }]
      };
    }
    return item;
  }

}

/** Default spans resolver — locate the active llmnb notebook by URI
 *  and walk its outputs. Span data lives on the document's per-cell
 *  `outputs` (kept in memory by VS Code), not in the metadata
 *  snapshot, so we resolve against `vscode.workspace.notebookDocuments`. */
function defaultSpansResolver(source: SidebarMetadataSource): TaggedSpan[] {
  const active = source.getActiveZone();
  if (!active) return [];
  const target = active.uri.toString();
  for (const nb of vscode.workspace.notebookDocuments) {
    if (nb.uri.toString() === target) {
      return extractTaggedSpans(nb);
    }
  }
  return [];
}
