// PLAN-S7 §6 — Shared status-badge color helper.
//
// Single source of color choices for agent `runtime_status` and
// section `status` badges so the sidebar trees, the cell decoration
// in `cell-badge.ts` (S1), and the section header in
// `sections/section-header-provider.ts` (S5.5) can stay visually
// consistent. PLAN-S7 §6 lists "Section status badges drift from cell
// decorations" as a risk; this helper is the mitigation.

import * as vscode from 'vscode';

/** Maps an agent `runtime_status` to a VS Code ThemeColor. The
 *  fallback handles unknown values (e.g. a future status the kernel
 *  adds before the extension knows about it) — keeps the badge
 *  rendering without flashing white. */
export function getAgentStatusBadgeColor(
  runtimeStatus: string | undefined
): vscode.ThemeColor {
  switch (runtimeStatus) {
    case 'alive':
      return new vscode.ThemeColor('charts.green');
    case 'idle':
      return new vscode.ThemeColor('charts.blue');
    case 'exited':
      return new vscode.ThemeColor('charts.gray');
    case 'terminated':
      return new vscode.ThemeColor('charts.red');
    default:
      return new vscode.ThemeColor('foreground');
  }
}

/** Maps a section `status` to a VS Code ThemeColor. Same fallback
 *  semantics as the agent variant. */
export function getSectionStatusBadgeColor(
  status: string | undefined
): vscode.ThemeColor {
  switch (status) {
    case 'open':
      return new vscode.ThemeColor('charts.blue');
    case 'in_progress':
      return new vscode.ThemeColor('charts.yellow');
    case 'complete':
      return new vscode.ThemeColor('charts.green');
    case 'frozen':
      return new vscode.ThemeColor('charts.purple');
    default:
      return new vscode.ThemeColor('foreground');
  }
}

/** Maps an activity entry type to a codicon id. The Tree API uses
 *  `iconPath` for visual disambiguation in the activity list. */
export function getActivityIconId(entryType: string): string {
  switch (entryType) {
    case 'agent_spawn':
      return 'play';
    case 'agent_branch':
      return 'source-control';
    case 'agent_revert':
      return 'discard';
    case 'agent_stop':
      return 'debug-stop';
    case 'ref_move':
      return 'arrow-right';
    case 'run_start':
      return 'play-circle';
    case 'run_end':
      return 'pass';
    default:
      return 'circle-small';
  }
}
