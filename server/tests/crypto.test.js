import test from 'node:test';
import assert from 'node:assert/strict';

const { canonicalize, sha256 } = await import('../src/crypto.js');

test('canonicalize is key-order independent', () => {
  const a = canonicalize({ b: 1, a: { z: 2, y: [3, 4] } });
  const b = canonicalize({ a: { y: [3, 4], z: 2 }, b: 1 });
  assert.equal(a, b);
});

test('canonicalize distinguishes types and nesting', () => {
  assert.notEqual(canonicalize({ a: 1, b: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('sha256 output format', () => {
  assert.match(sha256('zemen'), /^[0-9a-f]{64}$/);
  assert.equal(sha256('zemen'), sha256('zemen'));
  assert.notEqual(sha256('zemen'), sha256('zemen!'));
});
