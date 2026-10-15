'use strict';
// Password utility tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const { hashPassword, comparePassword, validatePasswordStrength } = require('../password');

test('validatePasswordStrength accepts a strong password', () => {
  const errors = validatePasswordStrength('SecurePass123!');
  assert.deepEqual(errors, []);
});

test('validatePasswordStrength rejects empty password', () => {
  const errors = validatePasswordStrength('');
  assert.ok(errors.includes('Password is required'));
});

test('validatePasswordStrength rejects password shorter than 8 chars', () => {
  const errors = validatePasswordStrength('Ab1!');
  assert.ok(errors.some((e) => e.includes('8 characters')));
});

test('validatePasswordStrength rejects missing uppercase', () => {
  const errors = validatePasswordStrength('securepass123!');
  assert.ok(errors.some((e) => e.includes('uppercase')));
});

test('validatePasswordStrength rejects missing lowercase', () => {
  const errors = validatePasswordStrength('SECUREPASS123!');
  assert.ok(errors.some((e) => e.includes('lowercase')));
});

test('validatePasswordStrength rejects missing digit', () => {
  const errors = validatePasswordStrength('SecurePass!');
  assert.ok(errors.some((e) => e.includes('digit')));
});

test('validatePasswordStrength rejects missing special character', () => {
  const errors = validatePasswordStrength('SecurePass123');
  assert.ok(errors.some((e) => e.includes('special character')));
});

test('hashPassword produces a bcrypt hash that comparePassword verifies', async () => {
  const hash = await hashPassword('SecurePass123!');
  assert.ok(hash.startsWith('$2'), 'hash must be a bcrypt hash');
  assert.equal(await comparePassword('SecurePass123!', hash), true);
  assert.equal(await comparePassword('WrongPass123!', hash), false);
});

test('hashPassword rejects weak password', async () => {
  await assert.rejects(
    () => hashPassword('weak'),
    (err) => {
      assert.equal(err.code, 'WEAK_PASSWORD');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test('hashPassword rejects empty password', async () => {
  await assert.rejects(
    () => hashPassword(''),
    /Password is required/
  );
});

test('comparePassword rejects wrong password', async () => {
  const hash = await hashPassword('CorrectPass123!');
  assert.equal(await comparePassword('IncorrectPass123!', hash), false);
});

