// Contract tests for PLAN-S5.0.2 §3.2 — provenance chip component.
// Pure-DOM exercise; no live kernel required.
//
// Spec references:
//   docs/notebook/PLAN-S5.0.2-magic-code-generators.md §3.2 (extension-side UI)
//   docs/atoms/concepts/magic-code-generator.md ("provenance chip" guidance)

import * as assert from 'node:assert/strict';
import {
  renderProvenanceChip,
  bindProvenanceChipHandlers,
  formatProvenanceChipText,
  formatProvenanceChipTooltip,
  firstNonBlankLine,
  PROVENANCE_CHIP_CLASS,
  PROVENANCE_CHIP_BUTTON_CLASS,
  PROVENANCE_CHIP_PREFIX,
  REVEAL_DATA_ATTR,
  GENERATOR_TEXT_MAX_CHARS,
  SHORT_ID_LEN,
  type ProvenanceChipProps
} from '../../src/renderers/components/provenance-chip.js';
import {
  renderContaminationBadge,
  CONTAMINATION_BADGE_CLASS
} from '../../src/renderers/components/contamination-badge.js';

/** Minimal element-like stub for the click handler. Captures handlers so the
 *  test can fire synthetic events without a real DOM. */
class FakeRoot {
  public handlers: Array<(ev: Event) => void> = [];
  public addEventListener(type: string, h: (ev: Event) => void): void {
    if (type === 'click') this.handlers.push(h);
  }
  public click(target: { getAttribute: (n: string) => string | null; closest: (s: string) => unknown }): void {
    for (const h of this.handlers) {
      h({ target } as unknown as Event);
    }
  }
}

/** Build a minimal `target` stub matching either the chip button itself or a
 *  descendant. The `closest` lookup walks back to the carrier element. */
function targetWithRevealAttr(cellId: string): {
  getAttribute: (n: string) => string | null;
  closest: (s: string) => unknown;
} {
  const carrier = {
    getAttribute: (n: string): string | null =>
      n === REVEAL_DATA_ATTR ? cellId : null
  };
  return {
    getAttribute: (n: string): string | null =>
      n === REVEAL_DATA_ATTR ? cellId : null,
    closest: (sel: string): unknown =>
      sel === `[${REVEAL_DATA_ATTR}]` ? carrier : null
  };
}

suite('contract: PLAN-S5.0.2 §3.2 — provenance chip', () => {

  // --------------------------------------------------------------------------
  // Pure helpers
  // --------------------------------------------------------------------------

  test('test_first_non_blank_line_returns_first_meaningful_line', () => {
    assert.equal(firstNonBlankLine('  \n\n@@bind code_writer\nrest'), '@@bind code_writer');
    assert.equal(firstNonBlankLine('@@spawn task'), '@@spawn task');
    assert.equal(firstNonBlankLine(''), '');
    assert.equal(firstNonBlankLine('   '), '');
    assert.equal(firstNonBlankLine(undefined as unknown as string), '');
  });

  test('test_format_chip_text_with_generator_magic_text', () => {
    const out = formatProvenanceChipText('@@bind code_writer', 'abcdef1234567890');
    // First 6 chars of `generated_by` form the short id.
    assert.match(out, /c_abcdef$/);
    assert.match(out, /from `@@bind code_writer`/);
    assert.ok(out.startsWith(PROVENANCE_CHIP_PREFIX));
  });

  test('test_format_chip_text_truncates_long_generator_text', () => {
    const longText = '@@dispatch ' + 'x'.repeat(80);
    const out = formatProvenanceChipText(longText, 'shortid12345678');
    // Body containing the truncated text must include the ellipsis sentinel.
    assert.match(out, /…/);
    // The truncated portion (the part between backticks) must obey the cap.
    const m = out.match(/`([^`]+)`/);
    assert.ok(m, 'chip text MUST contain a backtick-delimited body');
    assert.equal(m![1].length, GENERATOR_TEXT_MAX_CHARS);
  });

  test('test_format_chip_text_falls_back_to_short_id_when_no_text', () => {
    const out = formatProvenanceChipText(null, 'fffeeed1234567');
    assert.equal(out, `${PROVENANCE_CHIP_PREFIX} from c_fffeee`);
    const out2 = formatProvenanceChipText('   ', 'fffeeed1234567');
    assert.equal(out2, `${PROVENANCE_CHIP_PREFIX} from c_fffeee`);
  });

  test('test_format_tooltip_includes_generated_at_or_unknown_time', () => {
    assert.match(
      formatProvenanceChipTooltip('2026-04-29T01:02:03Z'),
      /Generated at 2026-04-29T01:02:03Z\. Click to jump to source\./
    );
    assert.match(
      formatProvenanceChipTooltip(null),
      /unknown time/
    );
  });

  test('test_short_id_len_constant_is_6', () => {
    assert.equal(SHORT_ID_LEN, 6);
  });

  // --------------------------------------------------------------------------
  // Render visibility
  // --------------------------------------------------------------------------

  test('test_chip_renders_only_when_generated_by_is_non_null', () => {
    const baseProps: ProvenanceChipProps = {
      cellId: 'cell-out',
      generatedBy: null,
      generatedAt: '2026-04-29T01:00:00Z',
      generatorMagicText: '@@bind x'
    };
    assert.equal(renderProvenanceChip(baseProps), '', 'null generatedBy MUST yield empty render');
    assert.equal(
      renderProvenanceChip({ ...baseProps, generatedBy: undefined }),
      '',
      'undefined generatedBy MUST yield empty render'
    );
    assert.equal(
      renderProvenanceChip({ ...baseProps, generatedBy: '' }),
      '',
      'empty generatedBy MUST yield empty render'
    );
    const html = renderProvenanceChip({ ...baseProps, generatedBy: 'g0001' });
    assert.notEqual(html, '');
    assert.match(html, new RegExp(PROVENANCE_CHIP_CLASS));
    assert.match(html, new RegExp(PROVENANCE_CHIP_BUTTON_CLASS));
  });

  test('test_chip_includes_reveal_data_attr_with_generated_by', () => {
    const html = renderProvenanceChip({
      cellId: 'out-cell',
      generatedBy: 'parent-1234567890',
      generatedAt: '2026-04-29T00:00:00Z',
      generatorMagicText: '@@bind agent'
    });
    assert.match(
      html,
      new RegExp(`${REVEAL_DATA_ATTR}="parent-1234567890"`)
    );
  });

  test('test_chip_html_includes_truncation_marker_for_long_text', () => {
    const html = renderProvenanceChip({
      cellId: 'out-cell',
      generatedBy: 'parentid',
      generatedAt: '2026-04-29T00:00:00Z',
      generatorMagicText: 'x'.repeat(200)
    });
    // The HTML-escaped ellipsis would appear as `…` (no entity needed).
    assert.match(html, /…/);
  });

  test('test_chip_tooltip_carries_generated_at', () => {
    const html = renderProvenanceChip({
      cellId: 'out-cell',
      generatedBy: 'gid-001',
      generatedAt: '2026-04-29T12:34:56Z',
      generatorMagicText: '@@bind w'
    });
    assert.match(html, /title="[^"]*2026-04-29T12:34:56Z[^"]*"/);
    // aria-label mirrors the title for screen readers.
    assert.match(html, /aria-label="[^"]*2026-04-29T12:34:56Z[^"]*"/);
  });

  test('test_chip_falls_back_to_short_id_when_no_text', () => {
    const html = renderProvenanceChip({
      cellId: 'out-cell',
      generatedBy: 'aabbccddeeff112233',
      generatedAt: null,
      generatorMagicText: null
    });
    assert.match(html, /c_aabbcc/);
    assert.match(html, /unknown time/);
  });

  // --------------------------------------------------------------------------
  // Click handler → command dispatch
  // --------------------------------------------------------------------------

  test('test_click_handler_invokes_reveal_cell_with_generated_by', () => {
    const root = new FakeRoot();
    const calls: Array<{ command: string; payload: { cellId: string } }> = [];
    bindProvenanceChipHandlers(root, (command, payload) => {
      calls.push({ command, payload });
    });
    root.click(targetWithRevealAttr('parent-cell-id-xyz'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'llmnb.revealCell');
    assert.deepEqual(calls[0].payload, { cellId: 'parent-cell-id-xyz' });
  });

  test('test_click_handler_skips_when_no_carrier_attr', () => {
    const root = new FakeRoot();
    let fired = 0;
    bindProvenanceChipHandlers(root, () => {
      fired += 1;
    });
    root.click({
      getAttribute: () => null,
      closest: () => null
    });
    assert.equal(fired, 0);
  });

  test('test_click_handler_does_not_fire_for_empty_cell_id', () => {
    const root = new FakeRoot();
    let fired = 0;
    bindProvenanceChipHandlers(root, () => {
      fired += 1;
    });
    root.click(targetWithRevealAttr(''));
    assert.equal(fired, 0);
  });

  // --------------------------------------------------------------------------
  // Coexistence with contamination badge — both render together
  // --------------------------------------------------------------------------

  test('test_chip_and_contamination_badge_can_coexist', () => {
    // PLAN-S5.0.2 §3.2: when a cell is BOTH contaminated and generated, both
    // chips render — provenance first, contamination second. We synthesize
    // the concatenation the run-renderer would produce and verify both
    // class hooks survive in the resulting markup.
    const provenance = renderProvenanceChip({
      cellId: 'cell-shared',
      generatedBy: 'parent-id-9999',
      generatedAt: '2026-04-29T00:00:00Z',
      generatorMagicText: '@@bind w'
    });
    const contamination = renderContaminationBadge({
      cellId: 'cell-shared',
      contaminated: true,
      contamination_log: [
        { line: '@@spawn x', source: 'stdout', ts: 't1', layer: 'always_on_plain' }
      ]
    });
    const combined = provenance + contamination;
    assert.match(combined, new RegExp(PROVENANCE_CHIP_CLASS));
    assert.match(combined, new RegExp(CONTAMINATION_BADGE_CLASS));
    // Provenance MUST appear before contamination so visual order matches
    // the spec.
    const idxP = combined.indexOf(PROVENANCE_CHIP_CLASS);
    const idxC = combined.indexOf(CONTAMINATION_BADGE_CLASS);
    assert.ok(idxP >= 0 && idxC >= 0);
    assert.ok(idxP < idxC, 'provenance chip MUST render before contamination badge');
  });
});
