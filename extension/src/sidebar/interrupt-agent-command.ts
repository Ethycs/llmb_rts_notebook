// PLAN-V2-sidebar-glanceability §3.3 — sidebar interrupt command.
//
// Thin resolver between the Agents-tree inline stop button and the S9
// interrupt path. The `view/item/context` menu invokes the command with
// the selected tree node (our `AgentsNode`); we resolve the agent's
// active cell from the run-frame substrate and delegate to the existing
// `llmnb.interruptCell` command — no new kernel surface. Interrupting a
// run that already completed no-ops with a logger warning (the tree's
// contextValue gating makes that a narrow race, not a normal path).

import * as vscode from 'vscode';
import type { SidebarMetadataSource } from './metadata-source.js';
import { getActiveRunFrame } from './agent-run-state.js';
import { resolveInterruptTarget } from './interrupt-agent-resolver.js';
import { INTERRUPT_COMMAND_ID } from '../notebook/interrupt-button.js';

export const SIDEBAR_INTERRUPT_COMMAND_ID = 'llmnb.sidebar.interruptAgent';

export function registerSidebarInterruptCommand(
  source: SidebarMetadataSource,
  logger: Pick<vscode.LogOutputChannel, 'warn'>
): vscode.Disposable {
  return vscode.commands.registerCommand(
    SIDEBAR_INTERRUPT_COMMAND_ID,
    async (node: { kind?: string; agentId?: string } | undefined) => {
      const agentId = node?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        logger.warn('[llmnb.sidebar.interruptAgent] no agent node; ignoring');
        return;
      }
      // Re-resolve at click time — the run the operator saw spinning may
      // have completed between render and click.
      const snapshot = source.getActiveZone()?.metadata;
      const target = resolveInterruptTarget(agentId, snapshot, getActiveRunFrame);
      if (!target) {
        logger.warn(
          `[llmnb.sidebar.interruptAgent] ${agentId} has no in-flight run; no-op`
        );
        return;
      }
      await vscode.commands.executeCommand(INTERRUPT_COMMAND_ID, {
        agent_id: agentId,
        cell_id: target.cellId
      });
    }
  );
}
