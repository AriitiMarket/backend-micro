'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUserResponse, SENSITIVE_FIELDS } = require('../../utils/user.mapper');

test('user.mapper: toUserResponse strips all sensitive authentication & credential fields', () => {
  const unsafeUser = {
    id: 'user-1234-uuid',
    name: 'Abebe Kebede',
    email: 'abebe@example.com',
    role: 'BUYER',
    password: 'PlaintextPassword123!',
    password_hash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890',
    two_factor_secret: 'enc:v1:0123456789abcdef:tag:ciphertext',
    twoFactorSecret: 'enc:v1:0123456789abcdef:tag:ciphertext',
    two_factor_pending_secret: 'enc:v1:0123456789abcdef:tag:pending',
    twoFactorPendingSecret: 'enc:v1:0123456789abcdef:tag:pending',
    two_factor_pending_otp: '654321',
    twoFactorPendingOtp: '654321',
    two_factor_pending_expires_at: new Date().toISOString(),
    twoFactorPendingExpiresAt: new Date().toISOString(),
    two_factor_pending_phone: '+251911223344',
    twoFactorPendingPhone: '+251911223344',
    backup_codes: ['HASHED_CODE_1', 'HASHED_CODE_2'],
    backupCodes: ['HASHED_CODE_1', 'HASHED_CODE_2'],
    reset_token: 'raw-reset-token-value',
    resetToken: 'raw-reset-token-value',
    token_hash: 'sha256-hash-value',
    tokenHash: 'sha256-hash-value',
    auth_tag: 'tag-value',
    iv: 'iv-value',
    status: 'active',
    capabilities: ['BUYER'],
  };

  const safe = toUserResponse(unsafeUser);

  // Assert all sensitive fields are stripped
  for (const field of SENSITIVE_FIELDS) {
    assert.equal(safe[field], undefined, `Field ${field} must NOT exist in serialized response`);
  }

  // Assert legitimate public/profile fields remain intact
  assert.equal(safe.id, 'user-1234-uuid');
  assert.equal(safe.name, 'Abebe Kebede');
  assert.equal(safe.email, 'abebe@example.com');
  assert.equal(safe.role, 'BUYER');
  assert.equal(safe.status, 'active');
  assert.deepEqual(safe.capabilities, ['BUYER']);
});

test('user.mapper: toUserResponse handles array of users and nested user objects', () => {
  const users = [
    { id: 'u1', name: 'User 1', password_hash: 'hash1', role: 'BUYER' },
    { id: 'u2', name: 'User 2', password_hash: 'hash2', role: 'SELLER' },
  ];

  const safeList = toUserResponse(users);
  assert.equal(safeList.length, 2);
  assert.equal(safeList[0].password_hash, undefined);
  assert.equal(safeList[1].password_hash, undefined);
  assert.equal(safeList[0].name, 'User 1');
  assert.equal(safeList[1].name, 'User 2');

  const nested = {
    success: true,
    user: { id: 'nested-u', name: 'Nested', two_factor_secret: 'secret-123' },
  };

  const safeNested = toUserResponse(nested);
  assert.equal(safeNested.user.two_factor_secret, undefined);
  assert.equal(safeNested.user.name, 'Nested');
});

test('user.mapper: toUserResponse handles null, undefined, or non-object gracefully', () => {
  assert.equal(toUserResponse(null), null);
  assert.equal(toUserResponse(undefined), null);
  assert.equal(toUserResponse('plain-string'), 'plain-string');
});
