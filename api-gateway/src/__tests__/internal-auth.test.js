'use strict';
// Unit tests for the service-to-service trust boundary (shared/internal-auth).
//
// This module is the ONLY thing standing between "any container on the private
// network" and every /internal/* endpoint, so the negative cases matter more than
// the positive one.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  canonicalServiceName,
  parseTokenMap,
  loadCredentials,
  outboundCredentials,
  sharedFallbackAllowed,
  verifyInternalRequest,
} = require('../shared/internal-auth');

/** Minimal Express-like request stand-in (case-insensitive header lookup). */
function fakeRequest(headers) {
  const lower = {};
  for (const key of Object.keys(headers || {})) lower[key.toLowerCase()] = headers[key];
  return {
    headers: lower,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

const CREDENTIALS = loadCredentials({
  INTERNAL_SERVICE_NAME: 'gateway',
  INTERNAL_SERVICE_TOKENS: JSON.stringify({
    gateway: 'gw-secret',
    identity: 'id-secret',
    commerce: 'co-secret',
    delivery: 'dl-secret',
  }),
}, 'gateway');

test('canonicalServiceName normalises legacy long names onto canonical ones', () => {
  assert.equal(canonicalServiceName('commerce-service'), 'commerce');
  assert.equal(canonicalServiceName('delivery-service'), 'delivery');
  assert.equal(canonicalServiceName('identity-service'), 'identity');
  assert.equal(canonicalServiceName('api-gateway'), 'gateway');
  assert.equal(canonicalServiceName('  DELIVERY '), 'delivery');
  assert.equal(canonicalServiceName(''), '');
  assert.equal(canonicalServiceName(null), '');
});

test('parseTokenMap accepts JSON and the compact form, and fails closed on garbage', () => {
  assert.deepEqual(
    { ...parseTokenMap('{"gateway":"a","commerce":"b"}') },
    { gateway: 'a', commerce: 'b' }
  );
  assert.deepEqual(
    { ...parseTokenMap('gateway:a, commerce : b') },
    { gateway: 'a', commerce: 'b' }
  );
  assert.deepEqual({ ...parseTokenMap('not json at all') }, {});
  assert.deepEqual({ ...parseTokenMap('') }, {});
  assert.deepEqual({ ...parseTokenMap('{"gateway":""}') }, {});
});

test('outboundCredentials prefers the caller\'s own secret', () => {
  assert.deepEqual(outboundCredentials(CREDENTIALS), { service: 'gateway', token: 'gw-secret' });

  // Shared-token deployment: no map configured, so the shared value is used.
  const legacy = loadCredentials({ INTERNAL_SERVICE_NAME: 'delivery', INTERNAL_SERVICE_TOKEN: 'shared' }, 'delivery');
  assert.deepEqual(outboundCredentials(legacy), { service: 'delivery', token: 'shared' });

  // Per-service map present but this service is not in it: never fall back
  // silently to another service's secret.
  const missing = loadCredentials({ INTERNAL_SERVICE_NAME: 'billing', INTERNAL_SERVICE_TOKENS: '{"gateway":"gw"}' }, 'billing');
  assert.deepEqual(outboundCredentials(missing), { service: 'billing', token: '' });
});

test('verifyInternalRequest accepts a caller presenting its own credential', () => {
  const verdict = verifyInternalRequest(
    fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'co-secret' }),
    CREDENTIALS
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.caller, 'commerce');
  assert.equal(verdict.shared, false);
});

test('verifyInternalRequest rejects an unidentified caller', () => {
  const verdict = verifyInternalRequest(fakeRequest({ 'x-internal-token': 'co-secret' }), CREDENTIALS);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.equal(verdict.code, 'FORBIDDEN');
});

test('verifyInternalRequest rejects an unknown calling service', () => {
  const verdict = verifyInternalRequest(
    fakeRequest({ 'x-internal-service': 'some-other-container', 'x-internal-token': 'co-secret' }),
    CREDENTIALS
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /Unknown calling service/);
});

test('verifyInternalRequest rejects a caller presenting ANOTHER service\'s credential', () => {
  // The core least-privilege assertion: holding commerce's secret must not let a
  // caller claim to be delivery.
  const verdict = verifyInternalRequest(
    fakeRequest({ 'x-internal-service': 'delivery', 'x-internal-token': 'co-secret' }),
    CREDENTIALS
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'FORBIDDEN');
});

test('verifyInternalRequest rejects a missing or empty credential', () => {
  assert.equal(verifyInternalRequest(fakeRequest({ 'x-internal-service': 'commerce' }), CREDENTIALS).ok, false);
  assert.equal(
    verifyInternalRequest(fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': '' }), CREDENTIALS).ok,
    false
  );
});

test('the legacy shared credential is refused once per-service credentials exist', () => {
  assert.equal(sharedFallbackAllowed(CREDENTIALS), false);

  const withSharedTokenConfigured = loadCredentials({
    INTERNAL_SERVICE_TOKENS: '{"gateway":"gw-secret"}',
    INTERNAL_SERVICE_TOKEN: 'the-old-shared-secret',
  }, 'identity');

  const stale = verifyInternalRequest(
    fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'the-old-shared-secret' }),
    withSharedTokenConfigured
  );
  assert.equal(stale.ok, false, 'a stale shared secret must not bypass the per-service map');

  // ... unless re-enabled explicitly — the documented migration escape hatch.
  const reEnabled = verifyInternalRequest(
    fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'the-old-shared-secret' }),
    loadCredentials({
      INTERNAL_SERVICE_TOKENS: '{"gateway":"gw-secret"}',
      INTERNAL_SERVICE_TOKEN: 'the-old-shared-secret',
      INTERNAL_ALLOW_SHARED_TOKEN: 'true',
    }, 'identity')
  );
  assert.equal(reEnabled.ok, true);
  assert.equal(reEnabled.shared, true);
});

test('the shared credential still works where it is the only credential (bare metal)', () => {
  const bareMetal = loadCredentials(
    { INTERNAL_SERVICE_NAME: 'commerce', INTERNAL_SERVICE_TOKEN: 'shared-dev-token' },
    'commerce'
  );
  assert.equal(sharedFallbackAllowed(bareMetal), true);

  const verdict = verifyInternalRequest(
    fakeRequest({ 'X-Internal-Service': 'delivery-service', 'X-Internal-Token': 'shared-dev-token' }),
    bareMetal
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.caller, 'delivery', 'legacy long names are normalised');
  assert.equal(verdict.shared, true);
});

test('no credential configured means every internal request is refused (fail closed)', () => {
  const none = loadCredentials({}, 'identity');
  assert.equal(none.shared, '');
  assert.deepEqual({ ...none.tokens }, {});
  assert.equal(
    verifyInternalRequest(fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'anything' }), none).ok,
    false
  );
});
