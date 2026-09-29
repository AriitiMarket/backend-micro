'use strict';
// Service-to-service contract, verified FROM INSIDE a backend container.
//
// The services publish no ports, so this is the only place the private network
// can be exercised as a service actually sees it. Run it with
// `tests/integration/service-to-service.sh` (which copies this file into the
// commerce container and executes it there).
//
// Exits non-zero if any assertion fails, so it is usable as a CI gate.
const assert = require('node:assert');

const TOKENS = JSON.parse(process.env.INTERNAL_SERVICE_TOKENS || '{}');
const SELF = process.env.INTERNAL_SERVICE_NAME || 'commerce';
const IDENTITY = (process.env.IDENTITY_SERVICE_URL || '').replace(/\/+$/, '');
const DELIVERY = (process.env.DELIVERY_SERVICE_URL || '').replace(/\/+$/, '');

const results = [];

function authHeaders(caller, token) {
  const headers = { Accept: 'application/json' };
  if (caller) headers['x-internal-service'] = caller;
  if (token) headers['x-internal-token'] = token;
  return headers;
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (err) {
    results.push({ ok: false, name, error: err.message });
  }
}

async function main() {
  assert.ok(IDENTITY, 'IDENTITY_SERVICE_URL must be set');
  assert.ok(DELIVERY, 'DELIVERY_SERVICE_URL must be set');
  assert.ok(TOKENS.commerce && TOKENS.identity && TOKENS.delivery, 'INTERNAL_SERVICE_TOKENS must define every caller');

  await check('liveness is reachable with no credential (restart policy probe)', async () => {
    const res = await fetch(DELIVERY + '/health/live');
    assert.equal(res.status, 200, 'status ' + res.status);
  });

  await check('readiness is reachable with no credential (routing probe)', async () => {
    const res = await fetch(DELIVERY + '/health/ready');
    assert.equal(res.status, 200, 'status ' + res.status);
  });

  await check(`${SELF} -> delivery internal read with its own credential`, async () => {
    const res = await fetch(DELIVERY + '/internal/delivery/location/hierarchy', {
      headers: authHeaders(SELF, TOKENS[SELF]),
    });
    assert.equal(res.status, 200, 'expected 200, got ' + res.status);
  });

  await check(`${SELF} -> identity internal read with its own credential`, async () => {
    const res = await fetch(IDENTITY + '/internal/users/count', {
      headers: authHeaders(SELF, TOKENS[SELF]),
    });
    assert.equal(res.status, 200, 'expected 200, got ' + res.status);
  });

  await check('a peer presenting ANOTHER service\'s credential is refused', async () => {
    // Claim to be delivery while presenting commerce's secret.
    const res = await fetch(DELIVERY + '/internal/delivery/locations/counts', {
      headers: authHeaders('delivery', TOKENS.commerce),
    });
    assert.equal(res.status, 403, 'expected 403, got ' + res.status);
  });

  await check('a peer may only use the internal namespace, never a user-facing route', async () => {
    const res = await fetch(DELIVERY + '/delivery/location/hierarchy', {
      headers: authHeaders(SELF, TOKENS[SELF]),
    });
    assert.equal(res.status, 403, 'expected 403, got ' + res.status);
  });

  await check('a peer with no credential is refused', async () => {
    const res = await fetch(DELIVERY + '/internal/delivery/operations/dashboard', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 403, 'expected 403, got ' + res.status);
  });

  await check('a peer with a forged caller name is refused', async () => {
    const res = await fetch(IDENTITY + '/internal/users/count', {
      headers: authHeaders('unknown-container', TOKENS[SELF]),
    });
    assert.equal(res.status, 403, 'expected 403, got ' + res.status);
  });

  await check('a peer cannot reach identity\'s public auth surface', async () => {
    const res = await fetch(IDENTITY + '/auth/token', {
      method: 'POST',
      headers: Object.assign(authHeaders(SELF, TOKENS[SELF]), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    assert.equal(res.status, 403, 'expected 403, got ' + res.status);
  });

  const failed = results.filter((entry) => !entry.ok);
  for (const entry of results) {
    console.log((entry.ok ? 'ok   ' : 'FAIL ') + entry.name + (entry.ok ? '' : ' :: ' + entry.error));
  }
  console.log(`\n${results.length - failed.length}/${results.length} service-to-service checks passed from inside ${SELF}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('service-to-service checks could not run:', err.message);
  process.exit(1);
});
