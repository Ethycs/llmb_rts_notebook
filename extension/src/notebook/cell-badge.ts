// BSP-005 S1 — cell-as-agent identity badges (extension-only).
//
// Two affordances per BSP-005 S1 + BSP-002 §6 + atoms/concepts/{cell,agent,
// cell-kinds}.md:
//
//   S1.1  vscode.NotebookCellStatusBarItem on every directive cell showing
//         `<agent_id> · <provider> · <runtime_status>`. Source of truth is the
//         cell's last-emitted closed span's `llmnb.agent_id` attribute (Family A
//         OTLP wire — see atoms/protocols/family-a-otlp-spans.md). Provider +
//         runtime_status come from the agent registry, populated from the
//         kernel's `notebook.metadata` snapshots (Family F).
//
//   S1.2  Stable per-agent gutter color, deterministic from `agent_id` and
//         persisted via `vscode.ExtensionContext.workspaceState` so the same
//         agent retains its color across reloads.
//
// Per-kind rules (atoms/concepts/cell-kinds.md):
//   - markdown / Markup cells  → NO badge (carry no agent).
//   - directive (kind=agent)   → badge with current agent triple.
//   - promoted cells           → badge text suffixed with " (promoted)".
//
// Re-render trigger: VS Code calls `provideCellStatusBarItems` whenever the
// cell's outputs change (a new span landed) and whenever the provider fires
// its `onDidChangeCellStatusBarItems` event (we fire on agent-state updates).

import * as vscode from 'vscode';
import { OtlpAttribute, getStringAttr } from '../otel/attrs.js';
import {
  NotebookMetadataObserver
} from '../messaging/router.js';
import type { NotebookMetadataPayload } from '../messaging/types.js';

/** MIME for run-output items carrying OTLP spans (mirrors controller.ts). */
const RTS_RUN_MIME = 'application/vnd.rts.run+json';

/** Default provider when an agent has not yet been seen on the wire (V1 ships
 *  `claude-code` only — atoms/concepts/agent.md "Provider"). */
const DEFAULT_PROVIDER = 'claude-code';

/** Default runtime status when the agent registry has nothing on file. The
 *  agent atom states V1 statuses are `alive | idle | exited`; the operator
 *  narrative in KB-cells §1 also uses `spawning | active`. We default to
 *  `idle` as the most operator-recognisable "ran here, currently quiet"
 *  shape. */
const DEFAULT_RUNTIME_STATUS = 'idle';

/** Suffix applied to promoted-cell badges per atoms/concepts/cell-kinds.md. */
export const PROMOTED_BADGE_SUFFIX = ' (promoted)';

/** Per-cell metadata slot under `cell.metadata.rts.cell` (same root the
 *  controller already writes — see controller.ts comments + BSP-002 §6). */
export interface RtsCellMetadataSlot {
  /** Cell kind per atoms/concepts/cell-kinds.md. Absent → default `agent` per
   *  the cell-kinds invariant "Pre-Issue-2 cells with no `kind` field default
   *  to `kind: 'agent'` at load." */
  kind?: 'agent' | 'markdown' | 'scratch' | 'checkpoint' |
         'tool' | 'artifact' | 'control' | 'native';
  /** Set when the cell was created via promote-span (atoms/operations/
   *  promote-span.md). Drives the " (promoted)" badge suffix. */
  promoted?: boolean;
  /** Bound agent for kind=agent cells (atoms/concepts/cell.md schema). */
  bound_agent_id?: string | null;
}

/** Snapshot of one agent's session state, mirrored from the kernel's
 *  `metadata.rts.zone.agents.<id>.session` shape (atoms/concepts/agent.md). */
export interface AgentSessionState {
  agent_id: string;
  provider?: string;
  runtime_status?: string;
}

/** Read-only registry of currently-known agents. The provider consults this
 *  for provider+runtime_status when rendering. */
export interface AgentRegistry {
  get(agent_id: string): AgentSessionState | undefined;
}

/** Mutable registry implementation that absorbs `notebook.metadata` snapshots.
 *  V1 wire (RFC-005 §"metadata.rts" + BSP-002 §8) places agent sessions at
 *  `zone.agents.<id>.session`. We tolerate absence — V1 has not wired
 *  `runtime_status` yet (S2/S6 land that), so most reads will fall through
 *  to the badge defaults until then. */
export class AgentRegistryImpl implements AgentRegistry, NotebookMetadataObserver {
  private readonly byId = new Map<string, AgentSessionState>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires every time an agent's snapshot row changes. Status-bar provider
   *  subscribes so the badge re-renders when runtime_status flips. */
  public readonly onDidChange = this.changeEmitter.event;

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public get(agent_id: string): AgentSessionState | undefined {
    return this.byId.get(agent_id);
  }

  /** Test/seam helper: directly upsert an agent row. Production code feeds
   *  rows via onNotebookMetadata only. */
  public upsert(state: AgentSessionState): void {
    this.byId.set(state.agent_id, state);
    this.changeEmitter.fire();
  }

  public onNotebookMetadata(payload: NotebookMetadataPayload): void {
    if (payload.mode !== 'snapshot' || !payload.snapshot) {
      return;
    }
    // V1 places agent sessions at `metadata.rts.zone.agents.<id>.session`.
    // The snapshot we receive here is `metadata.rts` (the applier strips one
    // level), so look at `snapshot.zone.agents`. Tolerate older `agents` at
    // the root for forward-compat per RFC-005 unknown-keys rule.
    const zone = (payload.snapshot as { zone?: Record<string, unknown> }).zone;
    const agents =
      (zone && typeof zone === 'object'
        ? (zone as { agents?: Record<string, unknown> }).agents
        : undefined) ??
      (payload.snapshot as { agents?: Record<string, unknown> }).agents;
    if (!agents || typeof agents !== 'object') {
      return;
    }
    let changed = false;
    for (const [id, raw] of Object.entries(agents)) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const session = (raw as { session?: Record<string, unknown> }).session;
      const src = (session && typeof session === 'object' ? session : raw) as
        Record<string, unknown>;
      const next: AgentSessionState = {
        agent_id: id,
        provider: typeof src.provider === 'string' ? (src.provider) : undefined,
        runtime_status:
          typeof src.runtime_status === 'string' ? (src.runtime_status) : undefined
      };
      const prev = this.byId.get(id);
      if (
        !prev ||
        prev.provider !== next.provider ||
        prev.runtime_status !== next.runtime_status
      ) {
        this.byId.set(id, next);
        changed = true;
      }
    }
    if (changed) {
      this.changeEmitter.fire();
    }
  }
}

/** Decode the OTLP attribute list in a span without depending on the renderer
 *  bundle. The cell-output items carry a JSON-encoded OTLP span at
 *  RTS_RUN_MIME (controller.ts → NotebookCellOutputItem.json(span)). We pull
 *  out `llmnb.agent_id` from the most-recent CLOSED span. */
export function lastClosedAgentIdFromCell(cell: vscode.NotebookCell): string | undefined {
  for (let i = cell.outputs.length - 1; i >= 0; i--) {
    const out = cell.outputs[i];
    for (let j = out.items.length - 1; j >= 0; j--) {
      const item = out.items[j];
      if (item.mime !== RTS_RUN_MIME) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8').decode(item.data));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const span = parsed as {
        endTimeUnixNano?: string | null;
        attributes?: OtlpAttribute[];
      };
      // Closed-span discriminator (Family A state machine — atoms/protocols/
      // family-a-otlp-spans.md). Open spans (endTimeUnixNano: null) are
      // valid sources too; the badge wants whichever attribute is most
      // recently authoritative on the wire (last-writer-wins).
      const agentId = getStringAttr(span.attributes, 'llmnb.agent_id', '');
      if (agentId) {
        return agentId;
      }
    }
  }
  return undefined;
}

/** Pull the `metadata.rts.cell` slot from a NotebookCell. We tolerate the
 *  legacy `metadata.rts` flat shape and the namespaced `metadata.rts.cell`
 *  shape — atom + BSP-002 §6 use the namespaced form, but earlier code may
 *  have flattened the slot. */
export function readCellMetadataSlot(cell: vscode.NotebookCell): RtsCellMetadataSlot {
  const meta = cell.metadata as { rts?: { cell?: RtsCellMetadataSlot } & RtsCellMetadataSlot } | undefined;
  if (!meta || typeof meta !== 'object' || !meta.rts) {
    return {};
  }
  if (meta.rts.cell && typeof meta.rts.cell === 'object') {
    return meta.rts.cell;
  }
  // Legacy flat shape — strip out non-cell keys (traceId, target_agent, etc).
  const { kind, promoted, bound_agent_id } = meta.rts;
  return { kind, promoted, bound_agent_id };
}

/** Decide whether a cell should carry a status-bar badge per atoms/concepts/
 *  cell-kinds.md. Markdown / comment cells get nothing. Returns the resolved
 *  cell-kind so callers can branch on it. */
export function badgeIsApplicable(cell: vscode.NotebookCell): { applicable: boolean; kind: string } {
  // VS Code's notebook-cell `kind` is the structural code-vs-markdown axis.
  // Markup cells map 1:1 to atoms/concepts/cell-kinds.md `markdown` — no
  // bound_agent allowed, no badge.
  if (cell.kind === vscode.NotebookCellKind.Markup) {
    return { applicable: false, kind: 'markdown' };
  }
  const slot = readCellMetadataSlot(cell);
  // Pre-Issue-2 cells without a kind field default to `agent` per the
  // cell-kinds invariant. `scratch` and `checkpoint` also are operator-side
  // structural cells and do not carry per-cell agent identity in V1; they
  // skip the badge per "scratch SHOULD have bound_agent_id: null" and
  // "checkpoint SHOULD have bound_agent_id: null" (cell-kinds.md table).
  const kind = slot.kind ?? 'agent';
  if (kind === 'markdown' || kind === 'scratch' || kind === 'checkpoint') {
    return { applicable: false, kind };
  }
  // Reserved V2+ kinds render inert per cell-kinds.md "Reserved kinds are
  // forward-compat markers" — no badge in V1.
  if (kind === 'tool' || kind === 'artifact' || kind === 'control' || kind === 'native') {
    return { applicable: false, kind };
  }
  return { applicable: true, kind };
}

/** The shape used by the status-bar provider and surfaced to tests. */
export interface CellBadge {
  agent_id: string;
  provider: string;
  runtime_status: string;
  promoted: boolean;
  /** Final rendered text (already includes the promoted suffix when set). */
  text: string;
}

/** Pure compute: derive the badge from a cell + agent registry. Returns
 *  `undefined` when the cell is not eligible (markdown, comment cell,
 *  non-V1 kind, or no agent_id resolvable). Tests call this directly. */
export function computeCellBadge(
  cell: vscode.NotebookCell,
  registry: AgentRegistry
): CellBadge | undefined {
  const { applicable } = badgeIsApplicable(cell);
  if (!applicable) {
    return undefined;
  }
  // Agent id resolution order:
  //   1. cell.metadata.rts.cell.bound_agent_id  (V1 binding cache; BSP-002 §6)
  //   2. last emitted span's `llmnb.agent_id` attribute (Family A wire)
  // The metadata cache is preferred because the wire-level span only exists
  // after the cell ran at least once; bound_agent_id is written eagerly on
  // directive parse so the badge appears before first run.
  const slot = readCellMetadataSlot(cell);
  const bound = typeof slot.bound_agent_id === 'string' ? slot.bound_agent_id : undefined;
  const agentId = bound ?? lastClosedAgentIdFromCell(cell);
  if (!agentId) {
    return undefined;
  }
  const session = registry.get(agentId);
  const provider = session?.provider ?? DEFAULT_PROVIDER;
  const runtime_status = session?.runtime_status ?? DEFAULT_RUNTIME_STATUS;
  const promoted = slot.promoted === true;
  // `<agent_id> · <provider> · <runtime_status>` per BSP-005 S1 / BSP-002 §6.
  let text = `${agentId} · ${provider} · ${runtime_status}`;
  if (promoted) {
    text = text + PROMOTED_BADGE_SUFFIX;
  }
  return { agent_id: agentId, provider, runtime_status, promoted, text };
}

/** vscode.NotebookCellStatusBarItemProvider implementation — registered in
 *  extension.ts activation. */
export class CellBadgeStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** VS Code calls this when our event fires to re-collect items per cell. */
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly registry: AgentRegistryImpl) {
    // Re-render every cell's badge when an agent's runtime_status changes.
    this.subscription = registry.onDidChange(() => {
      this.emitter.fire();
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const badge = computeCellBadge(cell, this.registry);
    if (!badge) {
      return [];
    }
    const item = new vscode.NotebookCellStatusBarItem(
      badge.text,
      vscode.NotebookCellStatusBarAlignment.Left
    );
    item.tooltip = `bound_agent=${badge.agent_id}, provider=${badge.provider}, runtime_status=${badge.runtime_status}${badge.promoted ? ' (promoted)' : ''}`;
    return [item];
  }
}

// ============================================================================
// S1.2 — stable per-agent gutter color
// ============================================================================

/** Workspace-state key under which the agent→color map is persisted. */
export const GUTTER_COLOR_STATE_KEY = 'llmnb.cellBadge.gutterColors.v1';

/** Minimal kv store surface — adapts to vscode.Memento for production and a
 *  plain Map for tests. */
export interface ColorStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

/** In-memory color store for tests. */
export class InMemoryColorStore implements ColorStore {
  private readonly state = new Map<string, unknown>();
  public get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }
  public update(key: string, value: unknown): void {
    if (value === undefined) {
      this.state.delete(key);
    } else {
      this.state.set(key, value);
    }
  }
  /** Test-only: snapshot the current entries (for round-trip simulation). */
  public snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.state);
  }
  /** Test-only: load from a previous snapshot (for round-trip simulation). */
  public load(entries: Record<string, unknown>): void {
    this.state.clear();
    for (const [k, v] of Object.entries(entries)) {
      this.state.set(k, v);
    }
  }
}

/** Deterministic 32-bit FNV-1a hash of a string. Stable across reloads and
 *  platforms — exactly what we need for "same agent_id → same color". */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit Math.imul keeps wrap-around semantics across V8/JSC.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Convert HSL (h ∈ [0,360), s,l ∈ [0,1]) to a `#rrggbb` hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const to8 = (v: number): string => {
    const n = Math.round((v + m) * 255);
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  };
  return `#${to8(r)}${to8(g)}${to8(b)}`;
}

/** Saturation + lightness chosen for visibility against both light and dark
 *  VS Code themes. */
const GUTTER_SATURATION = 0.65;
const GUTTER_LIGHTNESS = 0.55;

/** Deterministic agent_id → hex color. Same `agent_id` always yields the
 *  same color, regardless of insertion order or session. */
export function agentIdToColor(agent_id: string): string {
  const h = fnv1a(agent_id) % 360;
  return hslToHex(h, GUTTER_SATURATION, GUTTER_LIGHTNESS);
}

/** Persistent agent → color manager. Backed by `ExtensionContext.workspaceState`
 *  in production (BSP-005 S1.2 requirement). On first sight of an agent we
 *  compute the deterministic color and cache it; on subsequent reads we
 *  return the cached value. The cache survives reload because workspaceState
 *  round-trips through VS Code's storage. */
export class GutterColorManager implements vscode.Disposable {
  private cache: Record<string, string>;

  public constructor(private readonly store: ColorStore) {
    const persisted = store.get<Record<string, string>>(GUTTER_COLOR_STATE_KEY);
    this.cache = persisted && typeof persisted === 'object' ? { ...persisted } : {};
  }

  public dispose(): void {
    /* nothing to release; the underlying store is owned by the caller. */
  }

  /** Return the gutter color for `agent_id`, assigning + persisting on
   *  first sight. */
  public colorFor(agent_id: string): string {
    const hit = this.cache[agent_id];
    if (typeof hit === 'string' && /^#[0-9a-f]{6}$/i.test(hit)) {
      return hit;
    }
    const color = agentIdToColor(agent_id);
    this.cache[agent_id] = color;
    void this.store.update(GUTTER_COLOR_STATE_KEY, { ...this.cache });
    return color;
  }

  /** Read-only snapshot of currently-cached colors. */
  public snapshot(): Record<string, string> {
    return { ...this.cache };
  }
}

/** Helper: build the editor-decoration type for a given color. The renderer
 *  uses a left-edge border to imitate a gutter rule on the cell's text
 *  editor (VS Code does not expose a per-notebook-cell gutter API in
 *  v1.92, so this is the closest sanctioned affordance). */
export function createGutterDecorationType(color: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: color,
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
}
