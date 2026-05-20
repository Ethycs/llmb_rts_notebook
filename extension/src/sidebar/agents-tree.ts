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
      const session = active?.metadata?.zone?.agents?.[node.agentId]?.session;
      return this.buildSessionDetails(node.agentId, session);
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
