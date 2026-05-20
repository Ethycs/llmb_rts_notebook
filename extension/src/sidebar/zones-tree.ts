// PLAN-S7 §3.2 — Zones TreeDataProvider.
//
// Root nodes  : one per open .llmnb (read from SidebarMetadataSource.getAllZones).
// Children    : Agents virtual node + Sections virtual node per zone.
// Grandchildren of Agents:   agents[<id>] entries from that zone.
// Grandchildren of Sections: sections[<id>] entries from that zone.
//
// Read-only — no mutations. Operator mutations flow through the magic
// vocabulary / section-ops commands per PLAN-S5.5.

import * as vscode from 'vscode';
import type { ZonesNode, RawAgentSession, RawSection } from './types.js';
import type { SidebarMetadataSource, NotebookSnapshot } from './metadata-source.js';
import { ZONES_EMPTY, ZONE_NO_AGENTS, ZONE_NO_SECTIONS } from './empty-states.js';
import {
  getAgentStatusBadgeColor,
  getSectionStatusBadgeColor
} from './badge-style.js';

export class ZonesTreeProvider
  implements vscode.TreeDataProvider<ZonesNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ZonesNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private readonly subscription: vscode.Disposable;

  public constructor(private readonly source: SidebarMetadataSource) {
    this.subscription = this.source.onChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public getTreeItem(node: ZonesNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(
          node.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'zone': {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon('notebook');
        item.contextValue = 'llmnb.sidebar.zone';
        item.resourceUri = node.uri;
        item.description = node.uri.fsPath;
        return item;
      }
      case 'agents-root': {
        const item = new vscode.TreeItem(
          'Agents',
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.iconPath = new vscode.ThemeIcon('person');
        item.contextValue = 'llmnb.sidebar.agentsRoot';
        return item;
      }
      case 'sections-root': {
        const item = new vscode.TreeItem(
          'Sections',
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'llmnb.sidebar.sectionsRoot';
        return item;
      }
      case 'zone-agent': {
        const snapshot = this.findZone(node.parentUri);
        const session = snapshot?.metadata?.zone?.agents?.[node.agentId]?.session;
        return this.buildAgentItem(node.agentId, session);
      }
      case 'zone-section': {
        const snapshot = this.findZone(node.parentUri);
        const section = snapshot?.metadata?.zone?.sections?.[node.sectionId];
        return this.buildSectionItem(node.sectionId, section);
      }
    }
  }

  public getChildren(node?: ZonesNode): ZonesNode[] {
    if (!node) {
      const zones = this.source.getAllZones();
      if (zones.length === 0) {
        return [{ kind: 'empty', message: ZONES_EMPTY }];
      }
      return zones.map((z): ZonesNode => ({
        kind: 'zone',
        uri: z.uri,
        label: z.label
      }));
    }
    switch (node.kind) {
      case 'zone':
        return [
          { kind: 'agents-root', parentUri: node.uri },
          { kind: 'sections-root', parentUri: node.uri }
        ];
      case 'agents-root': {
        const snapshot = this.findZone(node.parentUri);
        const agents = snapshot?.metadata?.zone?.agents;
        if (!agents || Object.keys(agents).length === 0) {
          return [{ kind: 'empty', message: ZONE_NO_AGENTS }];
        }
        return Object.keys(agents)
          .sort()
          .map((agentId): ZonesNode => ({
            kind: 'zone-agent',
            parentUri: node.parentUri,
            agentId
          }));
      }
      case 'sections-root': {
        const snapshot = this.findZone(node.parentUri);
        const sections = snapshot?.metadata?.zone?.sections;
        if (!sections || Object.keys(sections).length === 0) {
          return [{ kind: 'empty', message: ZONE_NO_SECTIONS }];
        }
        return Object.keys(sections)
          .sort()
          .map((sectionId): ZonesNode => ({
            kind: 'zone-section',
            parentUri: node.parentUri,
            sectionId
          }));
      }
      default:
        return [];
    }
  }

  private findZone(uri: vscode.Uri): NotebookSnapshot | undefined {
    const target = uri.toString();
    return this.source.getAllZones().find((z) => z.uri.toString() === target);
  }

  private buildAgentItem(
    agentId: string,
    session: RawAgentSession | undefined
  ): vscode.TreeItem {
    const status = session?.runtime_status ?? 'idle';
    const item = new vscode.TreeItem(agentId, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('person', getAgentStatusBadgeColor(status));
    item.description = status;
    item.contextValue = 'llmnb.sidebar.zoneAgent';
    return item;
  }

  private buildSectionItem(
    sectionId: string,
    section: RawSection | undefined
  ): vscode.TreeItem {
    const title = section?.title ?? sectionId;
    const status = section?.status ?? 'open';
    const memberCount = section?.cell_range?.length ?? 0;
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      'symbol-namespace',
      getSectionStatusBadgeColor(status)
    );
    item.description = `${status} · ${memberCount} cells`;
    item.contextValue = 'llmnb.sidebar.zoneSection';
    return item;
  }
}
