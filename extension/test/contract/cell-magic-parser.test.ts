// PLAN-S5.0 §5 — extension parser tests for the IPython-style magic
// vocabulary.
//
// Covers the `@@<cell_magic>` and `@<line_magic>` grammar plus the
// legacy `/spawn` and `@<id>:` aliases that PLAN §3.9 requires to keep
// working.
//
// The wire-envelope layer (action_type=agent_spawn / agent_continue /
// set_cell_metadata) is exercised in `cell-directive-continue.test.ts`
// (continue) and the existing controller / pty-kernel-client tests
// (spawn) — this file focuses on the pure parser.
//
// Spec references:
//   docs/notebook/PLAN-S5.0-cell-magic-vocabulary.md  — grammar
//   docs/atoms/concepts/magic.md (S5.0 NEW atom)      — design
//   docs/atoms/protocols/operator-action.md           — wire envelope
//
// FSP-003 Pillar C — runs in the T2 stub-integration tier (no live
// kernel needed; pure parser).

import * as assert from 'node:assert/strict';
import { parseCellDirective } from '../../src/notebook/controller.js';

suite('cell-magic parser (PLAN-S5.0)', () => {
  test('@@spawn ships an agent_spawn-shaped directive', () => {
    const d = parseCellDirective('@@spawn alpha task:"design recipe schema"');
    assert.deepEqual(d, {
      kind: 'spawn',
      agent_id: 'alpha',
      task: 'design recipe schema'
    });
  });

  test('@@spawn with endpoint:<name> threads through', () => {
    const d = parseCellDirective(
      '@@spawn alpha endpoint:cheap task:"audit"'
    );
    assert.deepEqual(d, {
      kind: 'spawn',
      agent_id: 'alpha',
      task: 'audit',
      endpoint: 'cheap'
    });
  });

  test('@@agent <id> with body parses to a continue directive', () => {
    const d = parseCellDirective(
      '@@agent alpha\noptimize for read perf'
    );
    assert.deepEqual(d, {
      kind: 'continue',
      agent_id: 'alpha',
      text: 'optimize for read perf'
    });
  });

  test('@@agent with a body-line plus a line-magic preserves agent binding', () => {
    // The line magic ``@pin`` lives in the body; the parser captures
    // the cell-magic head and the kernel's parse_cell handles the
    // line-magic side. The extension parser's structured shape only
    // needs to carry agent_id + body verbatim.
    const d = parseCellDirective('@@agent alpha\n@pin\nbody text');
    assert.equal(d?.kind, 'continue');
    if (d?.kind === 'continue') {
      assert.equal(d.agent_id, 'alpha');
      assert.match(d.text, /body text/);
    }
  });

  test('@pin is a line_magic directive carrying flags.set=[pinned]', () => {
    const d = parseCellDirective('@pin');
    assert.deepEqual(d, {
      kind: 'line_magic',
      magic: 'pin',
      args: '',
      flags: { set: ['pinned'] }
    });
  });

  test('@unpin is a line_magic with flags.unset=[pinned]', () => {
    const d = parseCellDirective('@unpin');
    assert.deepEqual(d, {
      kind: 'line_magic',
      magic: 'unpin',
      args: '',
      flags: { unset: ['pinned'] }
    });
  });

  test('@exclude → flags.set=[excluded]', () => {
    const d = parseCellDirective('@exclude');
    assert.deepEqual(d, {
      kind: 'line_magic',
      magic: 'exclude',
      args: '',
      flags: { set: ['excluded'] }
    });
  });

  test('@affinity primary,cheap → line_magic with empty flags + args', () => {
    const d = parseCellDirective('@affinity primary,cheap');
    assert.deepEqual(d, {
      kind: 'line_magic',
      magic: 'affinity',
      args: 'primary,cheap',
      flags: {}
    });
  });

  test('@@markdown ships a cell_magic directive', () => {
    const d = parseCellDirective('@@markdown\n# heading\nbody');
    assert.deepEqual(d, {
      kind: 'cell_magic',
      magic: 'markdown',
      args: '',
      cell_kind: 'markdown'
    });
  });

  test('@@scratch ships a cell_magic directive', () => {
    const d = parseCellDirective('@@scratch\nlocal notes');
    assert.deepEqual(d, {
      kind: 'cell_magic',
      magic: 'scratch',
      args: '',
      cell_kind: 'scratch'
    });
  });

  test('@@endpoint with named args ships a cell_magic directive', () => {
    const d = parseCellDirective(
      '@@endpoint cheap provider:openai model:gpt-4o-mini'
    );
    assert.equal(d?.kind, 'cell_magic');
    if (d?.kind === 'cell_magic') {
      assert.equal(d.magic, 'endpoint');
      assert.equal(d.cell_kind, 'endpoint');
      assert.match(d.args, /provider:openai/);
      assert.match(d.args, /model:gpt-4o-mini/);
    }
  });

  test('@@break is not a directive (handled by splitter)', () => {
    assert.equal(parseCellDirective('@@break'), null);
    assert.equal(parseCellDirective('  @@break  '), null);
  });

  test('legacy /spawn still parses (PLAN §3.9 alias)', () => {
    const d = parseCellDirective('/spawn beta task:"audit"');
    assert.deepEqual(d, {
      kind: 'spawn',
      agent_id: 'beta',
      task: 'audit'
    });
  });

  test('legacy @<id>: still parses (PLAN §3.9 alias)', () => {
    const d = parseCellDirective('@beta: review compliance');
    assert.deepEqual(d, {
      kind: 'continue',
      agent_id: 'beta',
      text: 'review compliance'
    });
  });

  test('unknown @@<x> at the kind position returns null (kernel will K31)', () => {
    // The extension parser is permissive here — the kernel's parser
    // is the source of truth for K31. We return null so the cell
    // ships as a ``cell_edit`` no-op and the kernel's per-cell
    // ``parse_cell`` produces the K31 error span on actual run.
    assert.equal(parseCellDirective('@@xyzzy something'), null);
  });

  test('email-like @user mid-cell does not dispatch as a magic', () => {
    // The parser only inspects the first non-blank line. ``@user`` is
    // not a recognized line magic, so the cell falls through to
    // legacy continuation matching, which fails on the missing colon
    // → null.
    assert.equal(parseCellDirective('@user is not a magic'), null);
  });
});
