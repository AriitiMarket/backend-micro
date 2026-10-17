'use strict';
// Delivery access control helper tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  actorRoles,
  hasActor,
  isAdmin,
  isSeller,
  isBuyer,
  isOperator,
  isOwnerless,
  sameId,
} = require('../access');

// ── actorRoles ──
test('actorRoles returns empty array for null user', () => {
  assert.deepEqual(actorRoles(null), []);
});

test('actorRoles returns empty array for undefined user', () => {
  assert.deepEqual(actorRoles(undefined), []);
});

test('actorRoles returns primary role only', () => {
  assert.deepEqual(actorRoles({ role: 'SELLER' }), ['SELLER']);
});

test('actorRoles includes capabilities', () => {
  assert.deepEqual(
    actorRoles({ role: 'BUYER', capabilities: ['SELLER', 'PROVIDER'] }),
    ['BUYER', 'SELLER', 'PROVIDER']
  );
});

test('actorRoles normalizes to uppercase', () => {
  assert.deepEqual(actorRoles({ role: 'seller' }), ['SELLER']);
});

// ── hasActor ──
test('hasActor returns true when user holds the role', () => {
  assert.equal(hasActor({ role: 'SELLER' }, 'SELLER'), true);
});

test('hasActor returns true when user holds any requested role', () => {
  assert.equal(hasActor({ role: 'BUYER', capabilities: ['SELLER'] }, 'SELLER', 'ADMIN'), true);
});

test('hasActor returns false when user holds none', () => {
  assert.equal(hasActor({ role: 'BUYER' }, 'SELLER', 'ADMIN'), false);
});

// ── isAdmin ──
test('isAdmin returns true for ADMIN', () => {
  assert.equal(isAdmin({ role: 'ADMIN' }), true);
});

test('isAdmin returns false for non-ADMIN', () => {
  assert.equal(isAdmin({ role: 'SELLER' }), false);
});

// ── isSeller ──
test('isSeller returns true for SELLER', () => {
  assert.equal(isSeller({ role: 'SELLER' }), true);
});

test('isSeller returns false for non-SELLER', () => {
  assert.equal(isSeller({ role: 'BUYER' }), false);
});

// ── isBuyer ──
test('isBuyer returns true for BUYER', () => {
  assert.equal(isBuyer({ role: 'BUYER' }), true);
});

test('isBuyer returns true for legacy CUSTOMER', () => {
  assert.equal(isBuyer({ role: 'CUSTOMER' }), true);
});

test('isBuyer returns false for SELLER', () => {
  assert.equal(isBuyer({ role: 'SELLER' }), false);
});

// ── isOperator ──
test('isOperator returns true for PROVIDER', () => {
  assert.equal(isOperator({ role: 'PROVIDER' }), true);
});

test('isOperator returns false for non-PROVIDER', () => {
  assert.equal(isOperator({ role: 'SELLER' }), false);
});

// ── isOwnerless ──
test('isOwnerless returns true for SELLER', () => {
  assert.equal(isOwnerless({ role: 'SELLER' }), true);
});

test('isOwnerless returns true for BUYER', () => {
  assert.equal(isOwnerless({ role: 'BUYER' }), true);
});

test('isOwnerless returns false for ADMIN', () => {
  assert.equal(isOwnerless({ role: 'ADMIN' }), false);
});

// ── sameId ──
test('sameId returns true for matching string ids', () => {
  assert.equal(sameId('abc-123', 'abc-123'), true);
});

test('sameId returns true for matching mixed types', () => {
  assert.equal(sameId('507f1f77bcf86cd799439011', 507), false);
  assert.equal(sameId('123', 123), true);
});

test('sameId returns false for null/undefined', () => {
  assert.equal(sameId(null, 'abc'), false);
  assert.equal(sameId('abc', null), false);
  assert.equal(sameId(undefined, undefined), false);
});
