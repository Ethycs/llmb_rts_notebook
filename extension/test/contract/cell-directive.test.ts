// Unit tests for parseCellDirective — the V1 cell-input grammar.
// Pure function, no VS Code API. Validates the directive parser feeds
// PtyKernelClient.executeCell with the right structured shape.

import * as assert from 'node:assert/strict';
import { parseCellDirective } from '../../src/notebook/controller.js';

suite('parseCellDirective', () => {
  test('matches /spawn <agent> task:"..."', () => {
    const d = parseCellDirective('/spawn alpha task:"emit a notify"');
    assert.deepEqual(d, { kind: 'spawn', agent_id: 'alpha', task: 'emit a notify' });
  });

  test('tolerates leading/trailing whitespace', () => {
    const d = parseCellDirective('  /spawn beta task:"x"  \n');
    assert.deepEqual(d, { kind: 'spawn', agent_id: 'beta', task: 'x' });
  });

  test('agent_id may be a path-like or namespaced identifier', () => {
    const d = parseCellDirective('/spawn zone-1/alpha task:"do thing"');
    assert.deepEqual(d, { kind: 'spawn', agent_id: 'zone-1/alpha', task: 'do thing' });
  });

  test('task may contain spaces and punctuation but not embedded double quotes', () => {
    const d = parseCellDirective('/spawn x task:"do thing, then; report."');
    assert.deepEqual(d, { kind: 'spawn', agent_id: 'x', task: 'do thing, then; report.' });
  });

  test('returns null when the cell does not start with /spawn', () => {
    assert.equal(parseCellDirective('echo hello'), null);
    assert.equal(parseCellDirective('# comment'), null);
    assert.equal(parseCellDirective(''), null);
    assert.equal(parseCellDirective('   '), null);
  });

  test('returns null when /spawn is malformed (missing task)', () => {
    assert.equal(parseCellDirective('/spawn alpha'), null);
    assert.equal(parseCellDirective('/spawn alpha task:'), null);
    assert.equal(parseCellDirective('/spawn alpha task:"unterminated'), null);
  });

  test('returns null when /spawn has no agent_id', () => {
    assert.equal(parseCellDirective('/spawn task:"x"'), null);
  });

  test('does not match other directives (V1 grammar is /spawn only)', () => {
    assert.equal(parseCellDirective('/echo hello'), null);
    assert.equal(parseCellDirective('@agent foo'), null);
    assert.equal(parseCellDirective('/Spawn alpha task:"x"'), null);  // case-sensitive
  });
});
