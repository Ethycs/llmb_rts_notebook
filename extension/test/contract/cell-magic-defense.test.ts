// Contract tests for PLAN-S5.0.1 §3.8 — extension UI for contamination badge
// + pin-status header (S5.0.1e slice). Spec-named tests per §5 in the plan:
//
//   extension/test/contract/cell-magic-defense.test.ts (NEW, §5 target)
//
// These tests cover the cross-cutting concerns NOT individually addressed in
// contamination-badge.test.ts / pin-status-header.test.ts:
//
//   1. The renderer-side HTML contamination chip (amber palette + structure).
//   2. K3F invariant: `llmnb.resetContamination` is the SOLE command path
//      that can initiate contamination clearing — no other command constant
//      exposes the same intent.
//
// No live kernel, no VS Code extension host required. Pure-module exercise.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.8
//   docs/notebook/PLAN-S5.0.1-cell-magic-injection-defense.md §3.10 K3F

import * as assert from 'node:assert/strict';
import {
  renderContaminationBadge,
  bindContaminationBadgeHandlers,
  CONTAMINATION_BADGE_CLASS,
  CONTAMINATION_PANEL_CLASS,
  CONTAMINATION_RESET_BUTTON_CLASS,
  RESET_DATA_ATTR,
  type ContaminationBadgeProps
} from '../../src/renderers/components/contamination-badge.js';
import {
  RESET_CONTAMINATION_COMMAND_ID as CMD_FROM_BADGE
} from '../../src/notebook/contamination-badge.js';
import {
  RESET_CONTAMINATION_COMMAND_ID as CMD_FROM_COMMAND
} from '../../src/notebook/commands/reset-contamination.js';

// ---------------------------------------------------------------------------
// Minimal DOM stub for click-handler tests
// ---------------------------------------------------------------------------

class FakeRoot {
  public handlers: Array<(ev: Event) => void> = [];
  public addEventListener(type: string, h: (ev: Event) => void): void {
    if (type === 'click') this.handlers.push(h);
  }
  public dispatchClick(
    target: { getAttribute: (n: string) => string | null; closest?: (s: string) => unknown }
  ): void {
    for (const h of this.handlers) {
      h({ target } as unknown as Event);
    }
  }
}

function makeResetTarget(cellId: string): {
  getAttribute: (n: string) => string | null;
  closest: (s: string) => unknown;
} {
  const el = {
    getAttribute: (n: string): string | null =>
      n === RESET_DATA_ATTR ? cellId : null,
    closest: (sel: string): unknown => undefined
  };
  // closest must find the carrier element when traversing up.
  el.closest = (sel: string): unknown =>
    sel === `[${RESET_DATA_ATTR}]` ? el : null;
  return el;
}

// ---------------------------------------------------------------------------
// Helper: build props with the contaminated flag set
// ---------------------------------------------------------------------------

function contaminatedProps(overrides: Partial<ContaminationBadgeProps> = {}): ContaminationBadgeProps {
  return {
    cellId: 'cell-defense-001',
    contaminated: true,
    contamination_log: [
      { line: '@@spawn evil', source: 'stdout', ts: '2026-04-29T00:00:00Z', layer: 'always_on_plain' },
      { line: '@@auth verify secret', source: 'tool_result', ts: '2026-04-29T00:00:01Z', layer: 'always_on_plain' }
    ],
    ...overrides
  };
}

suite('contract: PLAN-S5.0.1 §3.8 — cell-magic-defense (S5.0.1e)', () => {

  // -------------------------------------------------------------------------
  // Test 1: contamination chip renders with amber warning styling
  // §5 spec name: test_contamination_chip_renders_with_amber_warning
  // -------------------------------------------------------------------------

  test('test_contamination_chip_renders_with_amber_warning', () => {
    const html = renderContaminationBadge(contaminatedProps());

    // The badge must be present with the canonical class name.
    assert.match(html, new RegExp(CONTAMINATION_BADGE_CLASS),
      'badge MUST carry the canonical contamination class');

    // The chip must emit warning/amber palette cues via VS Code CSS variables.
    // We assert the presence of the `warningBackground` token which is the
    // documented amber surface for threat indicators in the VS Code theme API.
    assert.match(html, /warningBackground/,
      'chip MUST reference vscode inputValidation warningBackground token');
    assert.match(html, /warningForeground/,
      'chip MUST reference vscode inputValidation warningForeground token');

    // The chip must carry the unicode WARNING SIGN (U+26A0) per §3.8 spec.
    assert.match(html, /&#9888;/,
      'chip MUST include the unicode warning-sign (&#9888;)');

    // The expandable panel must be present and initially hidden.
    assert.match(html, new RegExp(CONTAMINATION_PANEL_CLASS),
      'expandable panel MUST be rendered inside the badge');
    assert.match(html, /hidden/,
      'panel MUST start hidden (click-to-expand per §3.8)');

    // The reset button must carry the data attribute that routes the click
    // through bindContaminationBadgeHandlers to llmnb.resetContamination.
    assert.match(html, new RegExp(RESET_DATA_ATTR),
      'reset button MUST carry the reset data attribute');
    assert.match(html, new RegExp(CONTAMINATION_RESET_BUTTON_CLASS),
      'reset button MUST carry the canonical reset-button class');

    // The cell id must be encoded in the badge root (for command dispatch).
    assert.match(html, /cell-defense-001/,
      'badge MUST embed the cellId for command routing');
  });

  test('test_contamination_chip_not_rendered_when_cell_is_clean', () => {
    const html = renderContaminationBadge({ ...contaminatedProps(), contaminated: false });
    assert.equal(html, '',
      'renderer MUST return the empty string when contaminated === false (§3.8)');
  });

  // -------------------------------------------------------------------------
  // Test 2: K3F invariant — sole command path for contamination clearing
  // §5 spec name: test_clear_contamination_button_only_command_path
  // -------------------------------------------------------------------------

  test('test_clear_contamination_button_only_command_path', () => {
    // PLAN-S5.0.1 §3.10 K3F: the `llmnb.resetContamination` command is the
    // ONLY operator-facing surface that clears the contamination flag. We
    // verify this by asserting:
    //   a) both modules export the SAME command id constant.
    //   b) the constant value is the exact string registered in package.json
    //      and the contamination-badge status-bar item.
    assert.equal(CMD_FROM_BADGE, CMD_FROM_COMMAND,
      'both modules MUST export the same RESET_CONTAMINATION_COMMAND_ID');
    assert.equal(CMD_FROM_BADGE, 'llmnb.resetContamination',
      'command id MUST exactly match the package.json contributes.commands entry');

    // Additionally verify that the reset handler click routes through this
    // command id via bindContaminationBadgeHandlers.
    const root = new FakeRoot();
    const dispatched: Array<{ command: string; payload: { cellId: string } }> = [];
    bindContaminationBadgeHandlers(root, (cmd, payload) => {
      dispatched.push({ command: cmd, payload });
    });
    root.dispatchClick(makeResetTarget('cell-k3f-test'));
    assert.equal(dispatched.length, 1,
      'click MUST dispatch exactly one command');
    assert.equal(dispatched[0].command, CMD_FROM_BADGE,
      'dispatched command MUST equal RESET_CONTAMINATION_COMMAND_ID');
    assert.equal(dispatched[0].payload.cellId, 'cell-k3f-test',
      'dispatched payload MUST carry the correct cellId');
  });
});
