'use strict';
// Mongo id guard tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const { isValidObjectId } = require('../mongoId');

test('isValidObjectId returns true for a valid 24-char hex id', () => {
  assert.equal(isValidObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(isValidObjectId('000000000000000000000000'), true);
});

test('isValidObjectId returns false for null/undefined', () => {
  assert.equal(isValidObjectId(null), false);
  assert.equal(isValidObjectId(undefined), false);
});

test('isValidObjectId returns false for non-string/non-object', () => {
  assert.equal(isValidObjectId(123), false);
  assert.equal(isValidObjectId(true), false);
});

test('isValidObjectId returns false for wrong length', () => {
  assert.equal(isValidObjectId('507f1f77bcf86cd79943901'), false); // 23 chars
  assert.equal(isValidObjectId('507f1f77bcf86cd7994390111'), false); // 25 chars
});

test('isValidObjectId returns false for non-hex characters', () => {
  assert.equal(isValidObjectId('zzzzzzzzzzzzzzzzzzzzzzzz'), false);
});

test('isValidObjectId returns false for empty string', () => {
  assert.equal(isValidObjectId(''), false);
});
