'use strict';
// Standard API response helper tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const { ok, created, fail } = require('../response');

test('ok returns 200 with success:true', () => {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  ok(res, { userId: 'abc' }, 'User fetched');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'User fetched');
  assert.equal(res.body.userId, 'abc');
});

test('created returns 201 with success:true', () => {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  created(res, { userId: 'abc' }, 'User created');
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'User created');
});

test('fail returns 500 with success:false by default', () => {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  fail(res, 'Something broke');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Something broke');
  assert.deepEqual(res.body.errors, []);
});

test('fail accepts custom status, code, and errors', () => {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  fail(res, 'Not found', 404, [], 'NOT_FOUND');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.equal(res.body.success, false);
});
