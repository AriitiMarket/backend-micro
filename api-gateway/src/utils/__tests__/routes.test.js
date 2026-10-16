'use strict';
// Gateway route matching tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

// Re-implement the segment-aware match used by routes.js to test it directly.
// (routes.js requires express and proxy modules, which we don't need here.)
function matches(path, prefix) {
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

// ── matches ──
test('matches returns true for exact path', () => {
  assert.equal(matches('/product', '/product'), true);
});

test('matches returns true for sub-path', () => {
  assert.equal(matches('/product/42/reviews', '/product'), true);
});

test('matches returns false for longer sibling prefix', () => {
  assert.equal(matches('/products', '/product'), false);
});

test('matches returns false for unrelated path', () => {
  assert.equal(matches('/delivery/location', '/product'), false);
});

test('matches returns false for empty path', () => {
  assert.equal(matches('', '/product'), false);
});

test('matches handles root path', () => {
  assert.equal(matches('/', '/'), true);
});

test('matches is case-sensitive', () => {
  assert.equal(matches('/Product', '/product'), false);
});
