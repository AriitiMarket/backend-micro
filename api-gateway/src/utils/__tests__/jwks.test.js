'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwks = require('../jwks');

test('jwks: verifyToken verifies token with valid key and rejects invalid token', async () => {
  jwks._resetCache();

  // Generate an RSA keypair for testing
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const kid = 'test-kid-1';
  const pem = publicKey.export({ type: 'spki', format: 'pem' });

  // Pre-seed cache
  jwks._setPemCache({ [kid]: pem });

  const token = jwt.sign(
    { sub: 'user-jwks-1', email: 'test@example.com', role: 'BUYER', type: 'access' },
    privateKey,
    { algorithm: 'RS256', keyid: kid, issuer: process.env.ISSUER || 'aritii-identity', audience: process.env.AUDIENCE || 'aritii-market' }
  );

  const payload = await jwks.verifyToken(token);
  assert.equal(payload.sub, 'user-jwks-1');
  assert.equal(payload.email, 'test@example.com');
  assert.equal(payload.role, 'BUYER');
});

test('jwks: anti-DoS cooldown window prevents repeated refetching on unknown kid', async () => {
  jwks._resetCache();

  // Unknown token with non-existent kid
  const fakeToken = jwt.sign(
    { sub: 'attacker', type: 'access' },
    'secret',
    { header: { alg: 'none', kid: 'unknown-malicious-kid-1' } }
  );

  // First verification fails
  await assert.rejects(
    async () => {
      await jwks.verifyToken(fakeToken);
    },
    /Unknown signing key/
  );

  // Second immediate attempt with another unknown kid should hit cooldown
  const fakeToken2 = jwt.sign(
    { sub: 'attacker-2', type: 'access' },
    'secret',
    { header: { alg: 'none', kid: 'unknown-malicious-kid-2' } }
  );

  await assert.rejects(
    async () => {
      await jwks.verifyToken(fakeToken2);
    },
    /Unknown signing key/
  );
});

test('jwks: stale keys serve during temporary identity service downtime', async () => {
  jwks._resetCache();

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const kid = 'stale-kid-1';
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  jwks._setPemCache({ [kid]: pem });

  // Token signed by stale key
  const token = jwt.sign(
    { sub: 'user-stale-1', email: 'stale@example.com', role: 'SELLER', type: 'access' },
    privateKey,
    { algorithm: 'RS256', keyid: kid, issuer: process.env.ISSUER || 'aritii-identity', audience: process.env.AUDIENCE || 'aritii-market' }
  );

  // Even if identity-service is unreachable (fallback), stale cached keys still verify existing active sessions
  const payload = await jwks.verifyToken(token);
  assert.equal(payload.sub, 'user-stale-1');
  assert.equal(payload.role, 'SELLER');
});
