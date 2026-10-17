'use strict';
// Commerce role helper tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  LEGACY_ROLE_ALIASES,
  normalizeRole,
  actorRoles,
  hasRole,
  isBuyer,
  isSeller,
  isAdmin,
  isProvider,
} = require('../roles');

// ── normalizeRole ──
test('normalizeRole returns null for empty role', () => {
  assert.equal(normalizeRole(null), null);
  assert.equal(normalizeRole(undefined), null);
  assert.equal(normalizeRole(''), null);
});

test('normalizeRole canonicalizes known roles', () => {
  assert.equal(normalizeRole('BUYER'), 'BUYER');
  assert.equal(normalizeRole('SELLER'), 'SELLER');
  assert.equal(normalizeRole('PROVIDER'), 'PROVIDER');
  assert.equal(normalizeRole('AGENT'), 'AGENT');
  assert.equal(normalizeRole('ADMIN'), 'ADMIN');
});

test('normalizeRole maps legacy CUSTOMER to BUYER', () => {
  assert.equal(normalizeRole('CUSTOMER'), 'BUYER');
});

test('normalizeRole maps legacy PARTNER to PROVIDER', () => {
  assert.equal(normalizeRole('PARTNER'), 'PROVIDER');
});

test('normalizeRole is case-insensitive', () => {
  assert.equal(normalizeRole('buyer'), 'BUYER');
  assert.equal(normalizeRole('Seller'), 'SELLER');
  assert.equal(normalizeRole('Admin'), 'ADMIN');
});

// ── actorRoles ──
test('actorRoles returns primary role when no capabilities', () => {
  assert.deepEqual(actorRoles({ role: 'SELLER' }), ['SELLER']);
});

test('actorRoles includes capabilities as additional roles', () => {
  assert.deepEqual(
    actorRoles({ role: 'BUYER', capabilities: ['SELLER', 'PROVIDER'] }),
    ['BUYER', 'SELLER', 'PROVIDER']
  );
});

test('actorRoles normalizes legacy role spellings', () => {
  assert.deepEqual(actorRoles({ role: 'CUSTOMER' }), ['BUYER']);
  assert.deepEqual(actorRoles({ role: 'PARTNER' }), ['PROVIDER']);
});

test('actorRoles handles a plain string actor', () => {
  assert.deepEqual(actorRoles('ADMIN'), ['ADMIN']);
});

// ── hasRole ──
test('hasRole returns true when actor holds the role', () => {
  assert.equal(hasRole({ role: 'SELLER' }, 'SELLER'), true);
});

test('hasRole returns true when actor holds any of the requested roles', () => {
  assert.equal(hasRole({ role: 'BUYER', capabilities: ['SELLER'] }, 'SELLER', 'ADMIN'), true);
});

test('hasRole returns false when actor holds none of the requested roles', () => {
  assert.equal(hasRole({ role: 'BUYER' }, 'SELLER', 'ADMIN'), false);
});

// ── isBuyer ──
test('isBuyer returns true for BUYER role', () => {
  assert.equal(isBuyer({ role: 'BUYER' }), true);
});

test('isBuyer returns false for non-BUYER', () => {
  assert.equal(isBuyer({ role: 'SELLER' }), false);
});

// ── isSeller ──
test('isSeller returns true for SELLER role', () => {
  assert.equal(isSeller({ role: 'SELLER' }), true);
});

test('isSeller returns true when SELLER is a capability', () => {
  assert.equal(isSeller({ role: 'BUYER', capabilities: ['SELLER'] }), true);
});

test('isSeller returns false for non-SELLER', () => {
  assert.equal(isSeller({ role: 'BUYER' }), false);
});

// ── isAdmin ──
test('isAdmin returns true for ADMIN role', () => {
  assert.equal(isAdmin({ role: 'ADMIN' }), true);
});

test('isAdmin returns false for non-ADMIN', () => {
  assert.equal(isAdmin({ role: 'SELLER' }), false);
});

// ── isProvider ──
test('isProvider returns true for PROVIDER role', () => {
  assert.equal(isProvider({ role: 'PROVIDER' }), true);
});

test('isProvider returns false for non-PROVIDER', () => {
  assert.equal(isProvider({ role: 'SELLER' }), false);
});

// ── LEGACY_ROLE_ALIASES ──
test('LEGACY_ROLE_ALIASES maps CUSTOMER to BUYER', () => {
  assert.equal(LEGACY_ROLE_ALIASES.CUSTOMER, 'BUYER');
});

test('LEGACY_ROLE_ALIASES maps PARTNER to PROVIDER', () => {
  assert.equal(LEGACY_ROLE_ALIASES.PARTNER, 'PROVIDER');
});
