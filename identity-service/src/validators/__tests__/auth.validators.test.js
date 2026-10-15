'use strict';
// Auth validator tests — no database required.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  validateAuthorize,
  validateRegister,
  validateLogin,
  validateUpdateProfile,
  validateUpdatePassword,
  validateUpdateAddress,
  validateRoleRegistration,
} = require('../auth.validators');

function fakeReq(body = {}, query = {}, params = {}) {
  return { body, query, params };
}

function fakeRes() {
  const captured = { statusCode: 0, body: null };
  return {
    captured,
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; },
  };
}

function run(validator, req, res) {
  let nexted = false;
  validator(req, res, () => { nexted = true; });
  return { res, nexted };
}

// ── validateAuthorize ──
test('validateAuthorize passes with valid PKCE challenge', () => {
  const crypto = require('crypto');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const req = fakeReq({ code_challenge: challenge, code_challenge_method: 'S256' });
  const res = fakeRes();
  const { nexted } = run(validateAuthorize, req, res);
  assert.equal(nexted, true);
});

test('validateAuthorize rejects missing code_challenge', () => {
  const req = fakeReq({ code_challenge_method: 'S256' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateAuthorize, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
  assert.equal(r.captured.body.success, false);
  assert.ok(r.captured.body.errors.some((e) => e.includes('code_challenge is required')));
});

test('validateAuthorize rejects non-S256 method', () => {
  const req = fakeReq({ code_challenge: 'abc', code_challenge_method: 'plain' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateAuthorize, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateRegister ──
test('validateRegister passes with valid input', () => {
  const req = fakeReq({ name: 'Alice', email: 'alice@example.com', password: 'SecurePass123!' });
  const res = fakeRes();
  const { nexted } = run(validateRegister, req, res);
  assert.equal(nexted, true);
  assert.equal(req.body.email, 'alice@example.com');
});

test('validateRegister rejects short name', () => {
  const req = fakeReq({ name: 'A', email: 'alice@example.com', password: 'SecurePass123!' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateRegister, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

test('validateRegister rejects invalid email', () => {
  const req = fakeReq({ name: 'Alice', email: 'not-an-email', password: 'SecurePass123!' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateRegister, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

test('validateRegister rejects short password', () => {
  const req = fakeReq({ name: 'Alice', email: 'alice@example.com', password: 'short' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateRegister, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateLogin ──
test('validateLogin passes with valid email and password', () => {
  const req = fakeReq({ email: 'alice@example.com', password: 'password123' });
  const res = fakeRes();
  const { nexted } = run(validateLogin, req, res);
  assert.equal(nexted, true);
});

test('validateLogin passes with valid phone and password', () => {
  const req = fakeReq({ email: '+251911223344', password: 'password123' });
  const res = fakeRes();
  const { nexted } = run(validateLogin, req, res);
  assert.equal(nexted, true);
});

test('validateLogin rejects missing password', () => {
  const req = fakeReq({ email: 'alice@example.com' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateLogin, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateUpdateProfile ──
test('validateUpdateProfile passes with valid email', () => {
  const req = fakeReq({ email: 'alice@example.com', name: 'Alice Smith' });
  const res = fakeRes();
  const { nexted } = run(validateUpdateProfile, req, res);
  assert.equal(nexted, true);
});

test('validateUpdateProfile rejects invalid email', () => {
  const req = fakeReq({ email: 'bad-email' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateUpdateProfile, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

test('validateUpdateProfile rejects short name', () => {
  const req = fakeReq({ name: 'A' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateUpdateProfile, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateUpdatePassword ──
test('validateUpdatePassword passes with old and new password', () => {
  const req = fakeReq({ oldPassword: 'OldPass123!', newPassword: 'NewPass123!' });
  const res = fakeRes();
  const { nexted } = run(validateUpdatePassword, req, res);
  assert.equal(nexted, true);
});

test('validateUpdatePassword rejects missing oldPassword', () => {
  const req = fakeReq({ newPassword: 'NewPass123!' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateUpdatePassword, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

test('validateUpdatePassword rejects short newPassword', () => {
  const req = fakeReq({ oldPassword: 'OldPass123!', newPassword: 'short' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateUpdatePassword, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateUpdateAddress ──
test('validateUpdateAddress passes with all fields', () => {
  const req = fakeReq({ country: 'Ethiopia', city: 'Addis Ababa', address1: 'Bole', addressType: 'home' });
  const res = fakeRes();
  const { nexted } = run(validateUpdateAddress, req, res);
  assert.equal(nexted, true);
});

test('validateUpdateAddress rejects missing country', () => {
  const req = fakeReq({ city: 'Addis Ababa', address1: 'Bole', addressType: 'home' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateUpdateAddress, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

// ── validateRoleRegistration ──
test('validateRoleRegistration passes with valid role', () => {
  const req = fakeReq({ name: 'Alice', email: 'alice@example.com', password: 'SecurePass123!' }, {}, { role: 'SELLER' });
  const res = fakeRes();
  const { nexted } = run(validateRoleRegistration, req, res);
  assert.equal(nexted, true);
});

test('validateRoleRegistration rejects invalid role', () => {
  const req = fakeReq({ name: 'Alice', email: 'alice@example.com', password: 'SecurePass123!' }, {}, { role: 'ADMIN' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateRoleRegistration, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});

test('validateRoleRegistration rejects short name', () => {
  const req = fakeReq({ name: 'A', email: 'alice@example.com', password: 'SecurePass123!' }, {}, { role: 'BUYER' });
  const res = fakeRes();
  const { res: r, nexted } = run(validateRoleRegistration, req, res);
  assert.equal(nexted, false);
  assert.equal(r.captured.statusCode, 400);
});