// PLAN-V2-sidebar-glanceability §3.4 — FileDecorationProvider host.
//
// The vscode-bound half of the A4 decoration surface. All condition
// logic lives in `agent-decoration-logic.ts` (pure, unit-tested); this
// class only adapts it to the `vscode.FileDecorationProvider` contract:
//   - tree rows carry `resourceUri` on the `llmnb-agent://` scheme,
//   - VS Code calls `provideFileDecoration` per URI,
//   - we re-fire `onDidChangeFileDecorations` when the sidebar source
//     signals a snapshot change, but only for agents whose DERIVED
//     condition actually changed (memoized per URI) — decoration churn
//     on every 200ms-throttled snapshot would flicker otherwise.

import * as vscode from 'vscode';
import type { SidebarMetadataSource } from './metadata-source.js';
import {
  AGENT_RESOURCE_SCHEME,
  agentResourceUriString,
  conditionToDecoration,
  deriveAgentCondition,
  parseAgentResourceUriPath,
  type AgentCondition
} from './agent-decoration-logic.js';

export class AgentDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;

  private readonly subscription: vscode.Disposable;
  /** uri.toString() → last condition emitted for it (null = no badge). */
  private readonly lastCondition = new Map<string, AgentCondition | null>();

  public constructor(private readonly source: SidebarMetadataSource) {
    this.subscription = this.source.onChange(() => this.fireChanged());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideFileDecoration(
    uri: vscode.Uri
  ): vscode.FileDecoration | undefined {
    if (uri.scheme !== AGENT_RESOURCE_SCHEME) return undefined;
    const parsed = parseAgentResourceUriPath(uri.path);
    if (!parsed) return undefined;
    const snapshot = this.source.getActiveZone()?.metadata;
    const condition = deriveAgentCondition(parsed.agentId, snapshot);
    if (condition === null) return undefined;
    const spec = conditionToDecoration(condition);
    const deco = new vscode.FileDecoration(
      spec.badge,
      undefined,
      new vscode.ThemeColor(spec.colorId)
    );
    deco.propagate = spec.propagate;
    return deco;
  }

  /** Diff every known agent's condition against the memo and fire only
   *  the changed URIs. New agents fire on first sight (memo miss). */
  private fireChanged(): void {
    const snapshot = this.source.getActiveZone()?.metadata;
    const zoneId = snapshot?.zone?.zone_id ?? 'zone';
    const agents = snapshot?.zone?.agents ?? {};
    const changed: vscode.Uri[] = [];
    for (const agentId of Object.keys(agents)) {
      const uri = vscode.Uri.parse(agentResourceUriString(zoneId, agentId));
      const key = uri.toString();
      const condition = deriveAgentCondition(agentId, snapshot);
      if (this.lastCondition.get(key) !== condition) {
        this.lastCondition.set(key, condition);
        changed.push(uri);
      }
    }
    if (changed.length > 0) {
      this.emitter.fire(changed);
    }
  }
}
