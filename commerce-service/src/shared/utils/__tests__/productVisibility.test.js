'use strict';
// Product visibility utility tests — availableUnits is pure (no DB).
const { test } = require('node:test');
const assert = require('node:assert');

const { availableUnits } = require('../productVisibility');

// ── availableUnits ──
test('availableUnits returns stock minus reserved', () => {
  assert.equal(availableUnits({ stock: 100, reserved: 30 }), 70);
});

test('availableUnits clamps at 0 when reserved exceeds stock', () => {
  assert.equal(availableUnits({ stock: 5, reserved: 20 }), 0);
});

test('availableUnits treats missing fields as 0', () => {
  assert.equal(availableUnits({}), 0);
  assert.equal(availableUnits({ stock: 10 }), 10);
  assert.equal(availableUnits({ reserved: 5 }), 0);
});

test('availableUnits returns 0 for null product', () => {
  assert.equal(availableUnits(null), 0);
});

test('availableUnits handles decimal stock/reserved', () => {
  assert.equal(availableUnits({ stock: 10.5, reserved: 3 }), 7.5);
});
