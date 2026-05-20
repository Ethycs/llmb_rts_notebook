// PLAN-S7 §3.3 — Agents TreeDataProvider.
//
// Root nodes  : one per agent in the active notebook's
//               `metadata.rts.zone.agents`. Roots show `agent_id` +
//               `runtime_status` (colored via badge-style).
// Children    : 4 detail rows pulled from `agents[id].session.*`
//               (head_turn_id, last_seen_turn_id, claude_session_id, pid).
//
// Inline action: each agent root carries a `command` invoking
// `llmnb.revealCell` with the agent's first turn's `cell_id`. Clicking
// the agent jumps the editor to the cell that first dispatched it.
// Reachability of the first cell verified in slice 1's probe — written
// at `agents[id].turns[0].cell_id` per metadata_writer.py:1579.

import * as vscode from 'vscode';
import type { AgentsNode, RawAgent, RawAgentSession, RawTurnRecord } from './types.js';
import type { SidebarMetadataSource } from './metadata-source.js';
import { AGENTS_EMPTY } from './empty-states.js';
import { getAgentStatusBadgeColor } from './badge-style.js';
import { REVEAL_CELL_COMMAND_ID } from '../notebook/commands/reveal-cell.js';
import {
  buildAgentLineage,
  type AgentLineage,
  type ForkRecord
} from './agent-lineage.js';

export class AgentsTreeProvider
  implements vscode.TreeDataProvider<AgentsNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AgentsNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private readonly subscription: vscode.Disposable;

  public constructor(private readonly source: SidebarMetadataSource) {
    this.subscription = this.source.onChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public getTreeItem(node: AgentsNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(
          node.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'agent': {
        const active = this.source.getActiveZone();
        const agent = active?.metadata?.zone?.agents?.[node.agentId];
        return this.buildAgentItem(node.agentId, agent);
      }
      case 'agent-detail': {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None
        );
        item.description = node.value;
        item.tooltip = node.value;
        item.contextValue = 'llmnb.sidebar.agentDetail';
        return item;
      }
      case 'branches-root': {
        const active = this.source.getActiveZone();
        const lineage = buildAgentLineage(active?.metadata);
        const count = lineage.children.get(node.parentAgentId)?.length ?? 0;
        const item = new vscode.TreeItem(
          'Branches',
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.description = count === 1 ? '1 branch' : `${count} branches`;
        item.iconPath = new vscode.ThemeIcon('source-control');
        item.contextValue = 'llmnb.sidebar.branchesRoot';
        return item;
      }
      case 'branch-agent': {
        return this.buildBranchAgentItem(node);
      }
    }
  }

  public getChildren(node?: AgentsNode): AgentsNode[] {
    if (!node) {
      const active = this.source.getActiveZone();
      const agents = active?.metadata?.zone?.agents;
      if (!agents || Object.keys(agents).length === 0) {
        return [{ kind: 'empty', message: AGENTS_EMPTY }];
      }
      return Object.keys(agents)
        .sort()
        .map((agentId): AgentsNode => ({ kind: 'agent', agentId }));
    }
    if (node.kind === 'agent') {
      const active = this.source.getActiveZone();
      const agents = active?.metadata?.zone?.agents;
      const session = agents?.[node.agentId]?.session;
      const lineage = buildAgentLineage(active?.metadata);
      const rows = this.buildSessionDetails(node.agentId, session);
      // Append a "Branches" subnode IF this agent has any forked
      // descendants in the event_log lineage. Operators that haven't
      // run /branch never see the extra row, so it doesn't clutter
      // the simple single-agent case.
      if ((lineage.children.get(node.agentId)?.length ?? 0) > 0) {
        rows.push({ kind: 'branches-root', parentAgentId: node.agentId });
      }
      return rows;
    }
    if (node.kind === 'branches-root') {
      const active = this.source.getActiveZone();
      const lineage = buildAgentLineage(active?.metadata);
      const records = lineage.children.get(node.parentAgentId) ?? [];
      return records.map((rec): AgentsNode => ({
        kind: 'branch-agent',
        sourceAgentId: rec.sourceAgentId,
        branchAgentId: rec.branchAgentId,
        atTurnId: rec.atTurnId,
        case: rec.case
      }));
    }
    return [];
  }

  private buildAgentItem(
    agentId: string,
    agent: RawAgent | undefined
  ): vscode.TreeItem {
    const session = agent?.session;
    const status = session?.runtime_status ?? 'idle';
    const item = new vscode.TreeItem(
      agentId,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = new vscode.ThemeIcon('person', getAgentStatusBadgeColor(status));
    item.description = status;
    item.contextValue = 'llmnb.sidebar.agent';
    // Reveal the agent's first cell on click. The command no-ops if the
    // cell_id is missing or doesn't match any cell in the active editor
    // (per reveal-cell.ts runRevealCellCommand fallback).
    const firstCellId = firstTurnCellId(agent?.turns);
    if (firstCellId) {
      item.command = {
        command: REVEAL_CELL_COMMAND_ID,
        title: 'Jump to first cell',
        arguments: [{ cell_id: firstCellId }]
      };
    }
    return item;
  }

  private buildSessionDetails(
    agentId: string,
    session: RawAgentSession | undefined
  ): AgentsNode[] {
    const rows: AgentsNode[] = [];
    const push = (label: string, value: string | number | undefined | null): void => {
      if (value === undefined || value === null || value === '') return;
      rows.push({
        kind: 'agent-detail',
        agentId,
        label,
        value: String(value)
      });
    };
    push('head_turn_id', session?.head_turn_id);
    push('last_seen_turn_id', session?.last_seen_turn_id);
    push('claude_session_id', session?.claude_session_id);
    push('pid', session?.pid);
    if (rows.length === 0) {
      rows.push({
        kind: 'agent-detail',
        agentId,
        label: 'session',
        value: '(empty)'
      });
    }
    return rows;
  }

  /** Build the TreeItem for a single forked agent under a "Branches"
   *  subnode. The label is the branch agent id; the description carries
   *  the operator-recognisable lineage ("← <source> @ <short turn>") +
   *  the runtime_status from the active session map. Clicking the row
   *  navigates to the branch agent's first cell (mirrors the top-level
   *  `agent` row's reveal command). */
  private buildBranchAgentItem(node: {
    sourceAgentId: string;
    branchAgentId: string;
    atTurnId: string | null;
    case: 'A' | 'B' | undefined;
  }): vscode.TreeItem {
    const active = this.source.getActiveZone();
    const agent = active?.metadata?.zone?.agents?.[node.branchAgentId];
    const status = agent?.session?.runtime_status ?? 'idle';
    const item = new vscode.TreeItem(
      node.branchAgentId,
      vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon('git-branch', getAgentStatusBadgeColor(status));
    const lineage = formatLineageDescription(node);
    item.description = `${lineage} · ${status}`;
    item.tooltip =
      `${node.branchAgentId} (forked from ${node.sourceAgentId}` +
      `${node.atTurnId ? ` at ${shortTurnId(node.atTurnId)}` : ''}` +
      `${node.case ? `, case ${node.case}` : ''})`;
    item.contextValue = 'llmnb.sidebar.branchAgent';
    const firstCellId = firstTurnCellId(agent?.turns);
    if (firstCellId) {
      item.command = {
        command: REVEAL_CELL_COMMAND_ID,
        title: 'Jump to branch first cell',
        arguments: [{ cell_id: firstCellId }]
      };
    }
    return item;
  }
}

/** Format the branch row's lineage description. Reads `← <source>
 *  @ <short turn>` so the relationship is visible without expanding
 *  the row. */
function formatLineageDescription(record: {
  sourceAgentId: string;
  atTurnId: string | null;
  case: 'A' | 'B' | undefined;
}): string {
  const at = record.atTurnId ? ` @ ${shortTurnId(record.atTurnId)}` : '';
  const caseTag = record.case ? ` [${record.case}]` : '';
  return `← ${record.sourceAgentId}${at}${caseTag}`;
}

/** Short-form turn id for badge descriptions. Drops the `t_` prefix
 *  if present and truncates to 8 chars. */
function shortTurnId(turnId: string): string {
  const trimmed = turnId.startsWith('t_') ? turnId.slice(2) : turnId;
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

/** Pure helper — find the `cell_id` of the first turn an agent contributed.
 *  Exported so the test can verify the back-reference path without
 *  spinning up the provider. */
export function firstTurnCellId(
  turns: RawTurnRecord[] | undefined
): string | undefined {
  if (!Array.isArray(turns)) return undefined;
  for (const t of turns) {
    if (typeof t.cell_id === 'string' && t.cell_id.length > 0) {
      return t.cell_id;
    }
  }
  return undefined;
}
