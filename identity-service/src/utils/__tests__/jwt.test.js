'use strict';
// JWT utility tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  signAccessToken,
  signIdToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  generateAuthCode,
  isValidCodeChallenge,
  isValidCodeVerifier,
  computeS256Challenge,
  verifyPKCE,
} = require('../jwt');
const { privateKey, publicKey } = require('../../config/keys');

test('signAccessToken and verifyAccessToken round-trip correctly', () => {
  const user = { id: 'user-1', email: 'alice@example.com', role: 'BUYER', primaryRole: 'BUYER', capabilities: [] };
  const token = signAccessToken(user);
  assert.ok(typeof token === 'string' && token.length > 0);
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.email, 'alice@example.com');
  assert.equal(payload.role, 'BUYER');
});

test('signAccessToken includes capabilities when provided', () => {
  const user = { id: 'user-2', email: 'bob@example.com', role: 'SELLER', primaryRole: 'BUYER', capabilities: ['SELLER', 'PROVIDER'] };
  const token = signAccessToken(user);
  const payload = verifyAccessToken(token);
  assert.deepEqual(payload.capabilities, ['SELLER', 'PROVIDER']);
});

test('signAccessToken includes admin authorization when provided', () => {
  const user = { id: 'user-3', email: 'admin@example.com', role: 'ADMIN', primaryRole: 'ADMIN', capabilities: [] };
  const authorization = { adminRoles: ['SUPER_ADMIN'], permissions: ['*'], adminScope: {} };
  const token = signAccessToken(user, authorization);
  const payload = verifyAccessToken(token);
  assert.deepEqual(payload.admin_roles, ['SUPER_ADMIN']);
  assert.deepEqual(payload.permissions, ['*']);
});

test('signIdToken round-trips correctly', () => {
  const user = { id: 'user-4', email: 'carol@example.com', name: 'Carol', role: 'BUYER' };
  const token = signIdToken(user);
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'user-4');
  assert.equal(payload.email, 'carol@example.com');
});

test('verifyAccessToken rejects a tampered token', () => {
  const user = { id: 'user-5', email: 'dave@example.com', role: 'BUYER', primaryRole: 'BUYER', capabilities: [] };
  const token = signAccessToken(user);
  const tampered = token.slice(0, -5) + 'XXXXX';
  assert.throws(() => verifyAccessToken(tampered));
});

test('generateRefreshToken produces high-entropy string', () => {
  const a = generateRefreshToken();
  const b = generateRefreshToken();
  assert.ok(typeof a === 'string' && a.length > 0);
  assert.notEqual(a, b);
});

test('hashToken produces a deterministic sha256 hex string', () => {
  const a = hashToken('token-value');
  const b = hashToken('token-value');
  assert.equal(a.length, 64);
  assert.equal(a, b);
});

test('generateAuthCode produces high-entropy string', () => {
  const a = generateAuthCode();
  const b = generateAuthCode();
  assert.ok(typeof a === 'string' && a.length > 0);
  assert.notEqual(a, b);
});

test('isValidCodeChallenge accepts valid S256 base64url', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  assert.equal(isValidCodeChallenge(challenge, 'S256'), true);
});

test('isValidCodeChallenge rejects non-S256 method', () => {
  assert.equal(isValidCodeChallenge('somechallenge', 'plain'), false);
});

test('isValidCodeChallenge rejects too-short challenge', () => {
  assert.equal(isValidCodeChallenge('short', 'S256'), false);
});

test('isValidCodeVerifier accepts valid base64url verifier', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  assert.equal(isValidCodeVerifier(verifier), true);
});

test('isValidCodeVerifier rejects empty string', () => {
  assert.equal(isValidCodeVerifier(''), false);
});

test('computeS256Challenge produces base64url SHA256', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  assert.ok(/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge));
});

test('verifyPKCE accepts matching verifier and challenge', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  assert.equal(verifyPKCE(verifier, challenge, 'S256'), true);
});

test('verifyPKCE rejects mismatched verifier', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const wrongVerifier = crypto.randomBytes(48).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  assert.equal(verifyPKCE(wrongVerifier, challenge, 'S256'), false);
});

test('verifyPKCE rejects non-S256 method', () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  assert.equal(verifyPKCE(verifier, challenge, 'plain'), false);
});
