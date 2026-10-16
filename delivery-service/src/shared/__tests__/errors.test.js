'use strict';
// Delivery error factory tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const { AppError, validationError, badRequest, notFound, conflict, forbidden, unauthorized } = require('../errors');

// ── AppError ──
test('AppError stores message, status, code, and errors', () => {
  const err = new AppError('Something broke', 400, 'BAD_REQUEST', ['field x']);
  assert.equal(err.message, 'Something broke');
  assert.equal(err.status, 400);
  assert.equal(err.code, 'BAD_REQUEST');
  assert.deepEqual(err.errors, ['field x']);
  assert.equal(err.name, 'AppError');
});

test('AppError defaults status to 500 and code to null', () => {
  const err = new AppError('Server error');
  assert.equal(err.status, 500);
  assert.equal(err.code, null);
  assert.deepEqual(err.errors, []);
});

// ── validationError ──
test('validationError returns AppError with status 400', () => {
  const err = validationError(['email required'], 'Validation failed', 'VALIDATION_ERROR');
  assert.equal(err.status, 400);
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.deepEqual(err.errors, ['email required']);
});

// ── badRequest ──
test('badRequest returns AppError with status 400', () => {
  const err = badRequest('Bad input');
  assert.equal(err.status, 400);
  assert.equal(err.code, 'BAD_REQUEST');
  assert.equal(err.message, 'Bad input');
});

// ── notFound ──
test('notFound returns AppError with status 404', () => {
  const err = notFound('Delivery not found');
  assert.equal(err.status, 404);
  assert.equal(err.code, 'NOT_FOUND');
  assert.equal(err.message, 'Delivery not found');
});

// ── conflict ──
test('conflict returns AppError with status 409', () => {
  const err = conflict('Tracking closed', 'TRACKING_CLOSED');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'TRACKING_CLOSED');
  assert.equal(err.message, 'Tracking closed');
});

// ── forbidden ──
test('forbidden returns AppError with status 403', () => {
  const err = forbidden('No access');
  assert.equal(err.status, 403);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.message, 'No access');
});

// ── unauthorized ──
test('unauthorized returns AppError with status 401', () => {
  const err = unauthorized('Missing token');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'UNAUTHORIZED');
  assert.equal(err.message, 'Missing token');
});
