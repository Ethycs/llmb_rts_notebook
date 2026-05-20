// PLAN-S7 §3.4 — Activity TreeDataProvider.
//
// Synthesizes the seven entry types PLAN-S7 names (`agent_spawn`,
// `agent_branch`, `agent_revert`, `agent_stop`, `ref_move`,
// `run_start`, `run_end`) from the shipped kernel data:
//
//   - Legacy `agent_ref_move` entries in `zone.event_log[]`
//     (`reason: operator_revert | operator_branch`).
//   - Post-S6.0 captured envelopes in `zone.event_log[]`
//     (filtered by `payload.action_type` and `payload.parameters.intent_kind`).
//   - `zone.run_frames[*]` `started_at` / `ended_at` timestamps —
//     Family A `run.start` / `run.complete` envelopes are explicitly
//     excluded from the event_log by the writer
//     (metadata_writer.py:645-647), so the RunFrame is the canonical
//     source for `run_start` / `run_end`.
//
// Sorted most-recent first; capped at MAX_VISIBLE_ENTRIES (500) with
// a "Load more" affordance per PLAN-S7 §6 risk row.

import * as vscode from 'vscode';
import type {
  ActivityNode,
  RtsSnapshot,
  RawEventLogEntry,
  RawRunFrame,
  SynthesizedActivityEntry,
  SynthesizedEntryType,
  EnvelopeEventLogEntry,
  LegacyEventLogEntry
} from './types.js';
import type { SidebarMetadataSource } from './metadata-source.js';
import { ACTIVITY_EMPTY } from './empty-states.js';
import { getActivityIconId } from './badge-style.js';
import { REVEAL_CELL_COMMAND_ID } from '../notebook/commands/reveal-cell.js';

/** Hard cap on the number of entries the activity tree shows at once.
 *  PLAN-S7 §6 mitigates UI-thread blocking by capping the visible set
 *  and offering "Load more" for the long tail. */
export const DEFAULT_MAX_VISIBLE_ENTRIES = 500;

/** Step size for each "Load more" click — 200 keeps the tree
 *  responsive on bursty zones. */
export const LOAD_MORE_STEP = 200;

export class ActivityTreeProvider
  implements vscode.TreeDataProvider<ActivityNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ActivityNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private readonly subscription: vscode.Disposable;

  /** Tunable for tests — production wiring leaves this at the default. */
  public maxVisible: number = DEFAULT_MAX_VISIBLE_ENTRIES;

  public constructor(private readonly source: SidebarMetadataSource) {
    this.subscription = this.source.onChange(() => this.emitter.fire());
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public getTreeItem(node: ActivityNode): vscode.TreeItem {
    switch (node.kind) {
      case 'empty': {
        const item = new vscode.TreeItem(
          node.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'load-more': {
        const item = new vscode.TreeItem(
          `Load older entries (+${LOAD_MORE_STEP})`,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.contextValue = 'llmnb.sidebar.activityLoadMore';
        item.command = {
          command: 'llmnb.sidebar.activity.loadMore',
          title: 'Load more activity'
        };
        return item;
      }
      case 'entry': {
        const e = node.entry;
        const item = new vscode.TreeItem(
          e.label,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(getActivityIconId(e.entry_type));
        item.description = e.timestamp_ms > 0
          ? new Date(e.timestamp_ms).toISOString()
          : '';
        item.tooltip = `${e.entry_type} — ${e.label}`;
        item.contextValue = `llmnb.sidebar.activity.${e.entry_type}`;
        if (e.cell_id) {
          item.command = {
            command: REVEAL_CELL_COMMAND_ID,
            title: 'Reveal source cell',
            arguments: [{ cell_id: e.cell_id }]
          };
        }
        return item;
      }
    }
  }

  public getChildren(node?: ActivityNode): ActivityNode[] {
    if (node) return [];
    const active = this.source.getActiveZone();
    if (!active?.metadata) {
      return [{ kind: 'empty', message: ACTIVITY_EMPTY }];
    }
    const entries = synthesizeActivity(active.metadata);
    if (entries.length === 0) {
      return [{ kind: 'empty', message: ACTIVITY_EMPTY }];
    }
    const visible = entries.slice(0, this.maxVisible);
    const result: ActivityNode[] = visible.map((e): ActivityNode => ({
      kind: 'entry',
      entry: e
    }));
    if (entries.length > this.maxVisible) {
      result.push({ kind: 'load-more' });
    }
    return result;
  }

  /** Test seam — forces a tree refresh without waiting on the source. */
  public refresh(): void {
    this.emitter.fire();
  }

  /** Operator-driven "Load more" handler — bumps the visible cap by
   *  LOAD_MORE_STEP and refreshes. */
  public loadMore(): void {
    this.maxVisible += LOAD_MORE_STEP;
    this.emitter.fire();
  }
}

// ----------------------------------------------------------------------
// Synthesizer (pure functions, exported for tests)
// ----------------------------------------------------------------------

/** Top-level entry — turn a snapshot into a sorted activity list.
 *  Most-recent first; ties broken by source order. */
export function synthesizeActivity(
  snapshot: RtsSnapshot
): SynthesizedActivityEntry[] {
  const entries: SynthesizedActivityEntry[] = [];
  const log = snapshot.zone?.event_log ?? [];
  for (let i = 0; i < log.length; i += 1) {
    const e = classifyEventLogEntry(log[i]);
    if (e) entries.push(e);
  }
  const runFrames = snapshot.zone?.run_frames ?? {};
  for (const rf of Object.values(runFrames)) {
    for (const e of classifyRunFrame(rf)) entries.push(e);
  }
  entries.sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  return entries;
}

/** Classify one `zone.event_log[]` entry. Returns `undefined` when the
 *  entry doesn't map to any of the seven displayed types — V1 silently
 *  drops them; V1.5+ may add a generic "operator action" catch-all. */
export function classifyEventLogEntry(
  entry: RawEventLogEntry | undefined
): SynthesizedActivityEntry | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  // Legacy shape — pre-S6.0 agent_ref_move records.
  if ((entry as LegacyEventLogEntry).kind === 'agent_ref_move') {
    const legacy = entry as LegacyEventLogEntry;
    const ts = isoToMs(legacy.recorded_at);
    if (legacy.reason === 'operator_revert') {
      return {
        timestamp_ms: ts,
        entry_type: 'agent_revert',
        label: `revert ${legacy.agent_id ?? '?'} → ${shortTurn(legacy.to_turn_id)}`,
        source: 'event_log_legacy'
      };
    }
    if (legacy.reason === 'operator_branch') {
      return {
        timestamp_ms: ts,
        entry_type: 'agent_branch',
        label: `branch ${legacy.agent_id ?? '?'} @ ${shortTurn(legacy.from_turn_id)}`,
        source: 'event_log_legacy'
      };
    }
    return {
      timestamp_ms: ts,
      entry_type: 'ref_move',
      label: `ref-move ${legacy.agent_id ?? '?'}: ${legacy.reason ?? 'unknown'}`,
      source: 'event_log_legacy'
    };
  }
  // Envelope shape — post-S6.0. Filter by message_type + action_type.
  const env = entry as EnvelopeEventLogEntry;
  if (typeof env.message_type !== 'string') return undefined;
  if (env.message_type !== 'operator.action') return undefined;
  const actionType = env.payload?.action_type;
  const cellId = env.payload?.originating_cell_id;
  const ts = envelopeTimestampMs(env);
  if (actionType === 'agent_spawn') {
    const agentId =
      (env.payload?.parameters as { agent_id?: string } | undefined)?.agent_id ??
      '?';
    return {
      timestamp_ms: ts,
      entry_type: 'agent_spawn',
      label: `spawn ${agentId}`,
      cell_id: cellId,
      source: 'event_log_envelope'
    };
  }
  if (actionType === 'zone_mutate') {
    const intentKind = env.payload?.parameters?.intent_kind;
    if (intentKind === 'fork_agent') {
      return {
        timestamp_ms: ts,
        entry_type: 'agent_branch',
        label: 'branch (fork_agent)',
        cell_id: cellId,
        source: 'event_log_envelope'
      };
    }
    if (intentKind === 'move_agent_head') {
      const cause = (env.payload?.parameters as { cause?: string } | undefined)?.cause;
      return {
        timestamp_ms: ts,
        entry_type: cause === 'revert' ? 'agent_revert' : 'ref_move',
        label: cause === 'revert' ? 'revert (move_agent_head)' : 'ref-move (move_agent_head)',
        cell_id: cellId,
        source: 'event_log_envelope'
      };
    }
    return undefined;
  }
  return undefined;
}

/** Each RunFrame produces a `run_start` entry, plus a `run_end` entry
 *  if `ended_at` is populated. */
export function classifyRunFrame(
  rf: RawRunFrame | undefined
): SynthesizedActivityEntry[] {
  if (!rf || typeof rf !== 'object') return [];
  const out: SynthesizedActivityEntry[] = [];
  const startTs = isoToMs(rf.started_at);
  if (startTs > 0) {
    out.push({
      timestamp_ms: startTs,
      entry_type: 'run_start',
      label: `run start ${rf.run_id ?? '?'} (${rf.executor_id ?? '?'})`,
      cell_id: rf.cell_id,
      source: 'run_frames'
    });
  }
  const endTs = isoToMs(rf.ended_at);
  if (endTs > 0) {
    out.push({
      timestamp_ms: endTs,
      entry_type: 'run_end',
      label: `run end ${rf.run_id ?? '?'} → ${rf.status ?? '?'}`,
      cell_id: rf.cell_id,
      source: 'run_frames'
    });
  }
  return out;
}

/** Convert an ISO-8601 timestamp string into ms-since-epoch. Returns
 *  0 on missing / unparseable input so sort places it last (oldest). */
export function isoToMs(value: string | null | undefined): number {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Extract a sortable timestamp from a captured envelope. The post-S6.0
 *  shape uses `created_at` (ISO-8601) or `ts` (ms-since-epoch number). */
export function envelopeTimestampMs(env: EnvelopeEventLogEntry): number {
  if (typeof env.created_at === 'string') return isoToMs(env.created_at);
  if (typeof env.ts === 'number' && Number.isFinite(env.ts)) return env.ts;
  if (typeof env.ts === 'string') return isoToMs(env.ts);
  return 0;
}

/** Short-form turn id for badge labels. Truncates to the first 8 chars
 *  after a `t_` prefix (or just first 8 chars if no prefix). */
function shortTurn(turnId: string | null | undefined): string {
  if (typeof turnId !== 'string' || turnId.length === 0) return '?';
  const trimmed = turnId.startsWith('t_') ? turnId.slice(2) : turnId;
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

/** Type union of the synth entry types — useful when callers need to
 *  iterate the complete set (e.g. icon lookup tests). */
export const ALL_ENTRY_TYPES: ReadonlyArray<SynthesizedEntryType> = [
  'agent_spawn',
  'agent_branch',
  'agent_revert',
  'agent_stop',
  'ref_move',
  'run_start',
  'run_end'
];
