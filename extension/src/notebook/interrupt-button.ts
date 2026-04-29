// BSP-005 S9 — cell-toolbar interrupt button (extension half).
//
// Adds a sibling vscode.NotebookCellStatusBarItem provider to cell-badge.ts's
// identity badge. On every directive cell whose bound agent is currently
// "active" or "spawning" we render an `■ interrupt` button; clicking it posts
// an `operator.action` envelope with `action_type: "agent_interrupt"` so the
// kernel can route to `AgentSupervisor.interrupt(agent_id)` (a SIGINT to the
// agent's PID).
//
// Spec references:
//   atoms/concepts/agent.md                 — agent schema, runtime_status
//   atoms/operations/stop-agent.md          — stop vs interrupt distinction
//   atoms/protocols/operator-action.md      — outer envelope shape
//   docs/notebook/BSP-005-cell-roadmap.md §S9 — slice scope
//
// Visibility rule (§S9):
//   runtime_status ∈ { "active", "spawning" }   → show button
//   runtime_status ∈ { "idle", "exited" }       → hide button
//   anything else                                → hide button
//
// Optimistic UI: after click we set a transient `interrupting` row in the
// registry override so the button hides immediately. The real status update
// arrives when the kernel responds with the next `notebook.metadata` snapshot
// and AgentRegistryImpl absorbs it.
//
// We deliberately keep this module focused on the interrupt affordance — the
// existing identity badge in cell-badge.ts is the sibling that owns
// runtime_status display; we just READ runtime_status here.

import * as vscode from 'vscode';
import {
  AgentRegistry,
  badgeIsApplicable,
  lastClosedAgentIdFromCell,
  readCellMetadataSlot
} from './cell-badge.js';
import type { MessageRouter } from '../messaging/router.js';
import type { OperatorActionPayload, RtsV2Envelope } from '../messaging/types.js';

/** Command id registered in extension.ts activation; the cell-toolbar status
 *  bar item points at this command, and clicking the button invokes it with
 *  the bound agent_id (and originating cell id) as arguments. */
export const INTERRUPT_COMMAND_ID = 'llmnb.interruptCell';

/** Button text. The leading `■` is a unicode "stop" glyph; reads cleanly in
 *  both light and dark VS Code themes and does not require a codicon
 *  resource bundle. */
export const INTERRUPT_BUTTON_TEXT = '■ interrupt';

/** Runtime statuses that mean "the agent is mid-flight; an interrupt makes
 *  sense." BSP-005 §S9 calls out `active` and `spawning`. The agent atom's
 *  schema is `alive | idle | exited` but the operator narrative (KB-cells)
 *  also uses `active | spawning`; we recognize both `alive` and `active` as
 *  the "currently running a turn" state for forward-compat. */
export const INTERRUPTIBLE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'alive',
  'spawning'
]);

/** Transient optimistic-UI status set by `markInterrupting`. The button MUST
 *  hide while we wait for the kernel's real status update to arrive. */
export const TRANSIENT_INTERRUPTING_STATUS = 'interrupting';

/** Shape returned by the pure compute function. Tests poke this directly. */
export interface InterruptButton {
  agent_id: string;
  /** Final rendered text (currently constant `INTERRUPT_BUTTON_TEXT`). */
  text: string;
  /** Command id wired to the click. */
  command: string;
  /** Optimistic UI hint: the originating cell id, used by the click handler
   *  to mark the cell as `interrupting` immediately. */
  cell_id: string;
}

/** Read-only override store. The provider consults this BEFORE the agent
 *  registry; if the override has a row for the agent_id, it wins. We use
 *  this to shadow the real registry with a transient `interrupting` status
 *  after the operator clicks. */
export interface OptimisticOverrideStore {
  /** Returns the override status for `agent_id`, or `undefined` if no
   *  override is active. */
  get(agent_id: string): string | undefined;
}

/** Mutable optimistic-override store. Production code uses `LocalOverrideStore`;
 *  tests can pass any conformant implementation. */
export class LocalOverrideStore implements OptimisticOverrideStore {
  private readonly byId = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever an override is set or cleared so the provider can
   *  re-render. */
  public readonly onDidChange = this.changeEmitter.event;

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public get(agent_id: string): string | undefined {
    return this.byId.get(agent_id);
  }

  /** Mark `agent_id` as `interrupting` (or any transient status). */
  public set(agent_id: string, status: string): void {
    const prev = this.byId.get(agent_id);
    if (prev === status) {
      return;
    }
    this.byId.set(agent_id, status);
    this.changeEmitter.fire();
  }

  /** Clear the override; subsequent reads fall through to the real registry. */
  public clear(agent_id: string): void {
    if (this.byId.delete(agent_id)) {
      this.changeEmitter.fire();
    }
  }
}

/** Resolve the cell's bound agent id, mirroring cell-badge.ts's preference
 *  order: explicit `metadata.rts.cell.bound_agent_id` first, then fall back
 *  to the most-recent OTLP span's `llmnb.agent_id`. Exported for tests. */
export function resolveAgentIdForInterrupt(cell: vscode.NotebookCell): string | undefined {
  const slot = readCellMetadataSlot(cell);
  const bound = typeof slot.bound_agent_id === 'string' ? slot.bound_agent_id : undefined;
  return bound ?? lastClosedAgentIdFromCell(cell);
}

/** Pure compute: return the interrupt-button descriptor for a cell, or
 *  `undefined` if the button MUST NOT render. The override store wins over
 *  the registry; this is what implements the optimistic-hide behaviour
 *  after a click. Tests call this directly to assert visibility rules
 *  without going through VS Code's status-bar pipeline. */
export function computeInterruptButton(
  cell: vscode.NotebookCell,
  registry: AgentRegistry,
  overrides?: OptimisticOverrideStore
): InterruptButton | undefined {
  const { applicable } = badgeIsApplicable(cell);
  if (!applicable) {
    return undefined;
  }
  const agentId = resolveAgentIdForInterrupt(cell);
  if (!agentId) {
    return undefined;
  }
  // Optimistic override wins so a freshly-clicked button hides immediately.
  const overrideStatus = overrides?.get(agentId);
  if (typeof overrideStatus === 'string') {
    if (!INTERRUPTIBLE_STATUSES.has(overrideStatus)) {
      return undefined;
    }
    // (override saying "still active" is unusual but honored)
  }
  // Effective status: override > registry. Either may be undefined.
  const effective = overrideStatus ?? registry.get(agentId)?.runtime_status;
  if (typeof effective !== 'string' || !INTERRUPTIBLE_STATUSES.has(effective)) {
    return undefined;
  }
  return {
    agent_id: agentId,
    text: INTERRUPT_BUTTON_TEXT,
    command: INTERRUPT_COMMAND_ID,
    cell_id: cell.document.uri.toString()
  };
}

/** Build the RFC-006 `operator.action` envelope for an interrupt. The wire
 *  shape is locked by BSP-005 §S9:
 *
 *   {
 *     "type": "operator.action",
 *     "payload": {
 *       "action_type": "agent_interrupt",
 *       "agent_id": "<id>"
 *     }
 *   }
 *
 *  We additionally fill `parameters` (the standard operator-action payload
 *  shape per atoms/protocols/operator-action.md) and `originating_cell_id`
 *  so kernel-side dispatchers and UI feedback routing both work. The
 *  agent_id is duplicated at the payload root for the locked-shape minimum
 *  contract; downstream consumers reading `parameters.agent_id` continue to
 *  work. */
export function buildInterruptEnvelope(
  agent_id: string,
  cell_id: string
): RtsV2Envelope<OperatorActionPayload & { agent_id: string }> {
  return {
    type: 'operator.action',
    payload: {
      action_type: 'agent_interrupt',
      // Locked shape per BSP-005 S9 brief: agent_id at payload root.
      agent_id,
      parameters: { agent_id, cell_id },
      originating_cell_id: cell_id
    }
  };
}

/** Status-bar provider implementation. Sibling to CellBadgeStatusBarProvider
 *  in cell-badge.ts; both are registered against the same `llmnb` notebook
 *  type so VS Code merges their items per cell. */
export class InterruptButtonStatusBarProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** VS Code calls this when our event fires to re-collect items per cell. */
  public readonly onDidChangeCellStatusBarItems = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly registry: AgentRegistry & { onDidChange?: vscode.Event<void> },
    private readonly overrides: LocalOverrideStore
  ) {
    if (this.registry.onDidChange) {
      this.subscriptions.push(this.registry.onDidChange(() => this.emitter.fire()));
    }
    this.subscriptions.push(this.overrides.onDidChange(() => this.emitter.fire()));
  }

  public dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
    this.emitter.dispose();
  }

  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem[] {
    const desc = computeInterruptButton(cell, this.registry, this.overrides);
    if (!desc) {
      return [];
    }
    const item = new vscode.NotebookCellStatusBarItem(
      desc.text,
      vscode.NotebookCellStatusBarAlignment.Right
    );
    item.tooltip = `Interrupt agent ${desc.agent_id} (SIGINT)`;
    item.command = {
      command: desc.command,
      title: 'Interrupt agent',
      arguments: [{ agent_id: desc.agent_id, cell_id: desc.cell_id }]
    };
    return [item];
  }
}

/** Click-handler argument shape passed via the status-bar item's `command`. */
export interface InterruptCommandArgs {
  agent_id: string;
  cell_id: string;
}

/** Posts the `agent_interrupt` envelope through the router and sets the
 *  optimistic transient status. Exported for tests so they can drive the
 *  click path without spinning up VS Code's command registry. */
export function postAgentInterrupt(
  router: MessageRouter,
  overrides: LocalOverrideStore,
  args: InterruptCommandArgs
): void {
  const env = buildInterruptEnvelope(args.agent_id, args.cell_id);
  // Optimistically mark the agent so the button hides before the kernel
  // confirms. The real status flip lands via notebook.metadata snapshots.
  overrides.set(args.agent_id, TRANSIENT_INTERRUPTING_STATUS);
  router.enqueueOutbound(env);
}
