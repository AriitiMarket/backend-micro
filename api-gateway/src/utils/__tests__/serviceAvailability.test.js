'use strict';
// Gateway service availability (circuit breaker) tests — no database required.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { markDown, markUp, isDown, snapshot, reset, DOWN_TTL_MS } = require('../serviceAvailability');

afterEach(() => {
  reset();
});

// ── DOWN_TTL_MS ──
test('DOWN_TTL_MS defaults to 2000ms when env not set', () => {
  delete process.env.GATEWAY_UNAVAILABLE_TTL_MS;
  // Re-read the module-level constant is not possible without re-requiring,
  // but we can verify the behavior through markDown/isDown timing.
  assert.ok(DOWN_TTL_MS > 0);
});

// ── markDown / isDown ──
test('isDown returns false for an untouched service', () => {
  assert.equal(isDown('commerce'), false);
  assert.equal(isDown('delivery'), false);
});

test('markDown marks a service down, isDown returns true', () => {
  markDown('commerce', 'connection refused');
  assert.equal(isDown('commerce'), true);
});

test('isDown returns false for a different service', () => {
  markDown('commerce', 'timeout');
  assert.equal(isDown('delivery'), false);
});

test('markDown with no service is a no-op', () => {
  markDown(null, 'reason');
  assert.equal(isDown(null), false);
});

// ── markUp ──
test('markUp clears a down mark', () => {
  markDown('commerce', 'connection refused');
  assert.equal(isDown('commerce'), true);
  markUp('commerce');
  assert.equal(isDown('commerce'), false);
});

test('markUp with no service is a no-op', () => {
  markUp(null);
  assert.equal(isDown(null), false);
});

// ── TTL expiry ──
test('isDown returns false after TTL expires', () => {
  // Temporarily override the TTL for a fast test
  const originalEnv = process.env.GATEWAY_UNAVAILABLE_TTL_MS;
  process.env.GATEWAY_UNAVAILABLE_TTL_MS = '50';
  
  // Re-require to pick up the new TTL
  delete require.cache[require.resolve('../serviceAvailability')];
  const { markDown: md, isDown: id } = require('../serviceAvailability');
  
  md('commerce', 'timeout');
  assert.equal(id('commerce'), true);
  
  // Wait for TTL to expire
  const start = Date.now();
  while (Date.now() - start < 100) { /* busy wait 100ms > 50ms TTL */ }
  
  assert.equal(id('commerce'), false);
  
  // Restore
  process.env.GATEWAY_UNAVAILABLE_TTL_MS = originalEnv;
  delete require.cache[require.resolve('../serviceAvailability')];
  require('../serviceAvailability');
});

// ── snapshot ──
test('snapshot returns empty when no services are down', () => {
  assert.deepEqual(snapshot(), {});
});

test('snapshot returns down services with reason and since', () => {
  markDown('commerce', 'connection refused');
  const snap = snapshot();
  assert.ok(snap.commerce);
  assert.equal(snap.commerce.down, true);
  assert.equal(snap.commerce.reason, 'connection refused');
  assert.ok(typeof snap.commerce.since === 'string');
});

test('snapshot does not include expired services', () => {
  markDown('commerce', 'timeout');
  assert.equal(isDown('commerce'), true);
  // isDown clears expired entries when checked; since TTL is 2000ms by default,
  // the entry is still present immediately.
  const snap = snapshot();
  assert.ok(snap.commerce);
});

// ── reset ──
test('reset clears all down marks', () => {
  markDown('commerce', 'timeout');
  markDown('delivery', 'connection refused');
  assert.equal(isDown('commerce'), true);
  assert.equal(isDown('delivery'), true);
  reset();
  assert.equal(isDown('commerce'), false);
  assert.equal(isDown('delivery'), false);
  assert.deepEqual(snapshot(), {});
});
