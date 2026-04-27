// Contract tests for BlobResolver — RFC-005 §"metadata.rts.blobs".
//
// Spec references:
//   RFC-005 §"metadata.rts.blobs"   — sentinel format, encoding, hash key
//   RFC-005 §"Blob garbage collection" — content-addressed integrity
//
// The resolver runs in two environments:
//   1. Extension host (Node) — full hash verification via node:crypto.
//   2. Renderer (browser bundle) — sentinel-shape + presence checks; the
//      crypto path is gracefully skipped.
// Tests run in Node so the full verification path is exercised.

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { BlobResolver } from '../../src/llmnb/blob-resolver.js';
import type { BlobEntry } from '../../src/llmnb/blob-resolver.js';

function makeBlob(data: string, contentType = 'text/plain'): { hash: string; entry: BlobEntry } {
  const hash = crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
  return {
    hash: `sha256:${hash}`,
    entry: {
      content_type: contentType,
      encoding: 'utf-8',
      size_bytes: Buffer.byteLength(data, 'utf-8'),
      data
    }
  };
}

interface RecordingLogger {
  warnings: string[];
  warn(message: string): void;
}

function recordingLogger(): RecordingLogger {
  const out: RecordingLogger = {
    warnings: [],
    warn(m): void { this.warnings.push(m); }
  };
  return out;
}

suite('contract: BlobResolver (RFC-005 §metadata.rts.blobs)', () => {
  test('resolves a $blob:sha256:<hex> sentinel to its content', () => {
    const big = 'x'.repeat(70_000);
    const { hash, entry } = makeBlob(big);
    const resolver = new BlobResolver({ [hash]: entry });
    const out = resolver.resolve(`$blob:${hash}`);
    assert.equal(out, big);
  });

  test('passes plain (non-blob) strings through unchanged', () => {
    const resolver = new BlobResolver({});
    assert.equal(resolver.resolve('hello world'), 'hello world');
    assert.equal(resolver.resolve(''), '');
  });

  test('returns a placeholder when the hash is missing from the table', () => {
    const log = recordingLogger();
    const resolver = new BlobResolver({}, log);
    const out = resolver.resolve(
      '$blob:sha256:0000000000000000000000000000000000000000000000000000000000000000'
    );
    assert.match(String(out), /^\[unresolved blob:/);
    assert.equal(log.warnings.length, 1);
  });

  test('returns a placeholder when the stored data does not match the hash key', () => {
    const log = recordingLogger();
    const { hash, entry } = makeBlob('the original data');
    // Tamper: keep the hash key but change the data.
    const tampered: BlobEntry = { ...entry, data: 'tampered data' };
    const resolver = new BlobResolver({ [hash]: tampered }, log);
    const out = resolver.resolve(`$blob:${hash}`);
    assert.match(String(out), /^\[corrupt blob:/);
    assert.equal(log.warnings.length, 1);
  });

  test('rejects non-utf-8 encodings (V1 supports utf-8 only)', () => {
    const log = recordingLogger();
    const data = 'whatever';
    const hash = `sha256:${crypto.createHash('sha256').update(data, 'utf-8').digest('hex')}`;
    const entry: BlobEntry = {
      content_type: 'image/png',
      encoding: 'base64',
      size_bytes: data.length,
      data
    };
    const resolver = new BlobResolver({ [hash]: entry }, log);
    const out = resolver.resolve(`$blob:${hash}`);
    assert.match(String(out), /^\[unsupported blob encoding:/);
    assert.equal(log.warnings.length, 1);
  });

  test('recurses into objects so nested $blob: refs resolve', () => {
    const a = makeBlob('alpha-content');
    const b = makeBlob('beta-content');
    const resolver = new BlobResolver({ [a.hash]: a.entry, [b.hash]: b.entry });
    const input = {
      input: {
        prompt: `$blob:${a.hash}`,
        nested: { tail: `$blob:${b.hash}` }
      },
      tags: ['static', 'no-blob']
    };
    const out = resolver.resolve(input) as Record<string, unknown>;
    const inner = out['input'] as Record<string, unknown>;
    assert.equal(inner['prompt'], 'alpha-content');
    const nested = inner['nested'] as Record<string, unknown>;
    assert.equal(nested['tail'], 'beta-content');
    assert.deepEqual(out['tags'], ['static', 'no-blob']);
  });

  test('recurses into arrays', () => {
    const a = makeBlob('one');
    const b = makeBlob('two');
    const resolver = new BlobResolver({ [a.hash]: a.entry, [b.hash]: b.entry });
    const out = resolver.resolve([
      `$blob:${a.hash}`,
      'untouched',
      [`$blob:${b.hash}`]
    ]);
    assert.deepEqual(out, ['one', 'untouched', ['two']]);
  });

  test('isBlobRef detects sentinel strings', () => {
    assert.equal(
      BlobResolver.isBlobRef('$blob:sha256:abc123'),
      true
    );
    assert.equal(BlobResolver.isBlobRef('hello'), false);
    assert.equal(BlobResolver.isBlobRef(42), false);
    assert.equal(BlobResolver.isBlobRef(undefined), false);
  });

  test('handles primitives without crashing', () => {
    const resolver = new BlobResolver({});
    assert.equal(resolver.resolve(null), null);
    assert.equal(resolver.resolve(undefined), undefined);
    assert.equal(resolver.resolve(42), 42);
    assert.equal(resolver.resolve(true), true);
  });
});
