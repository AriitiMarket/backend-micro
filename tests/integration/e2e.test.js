'use strict';
// End-to-end checks against a RUNNING stack.
//
//   docker compose up -d --build      # from the repository root
//   ARITII_E2E=1 npm run test:integration
//
// Skipped by default so `npm test` never needs Docker. Only the public edge is
// reachable from the host (the services publish no ports), so everything here
// goes through the gateway; the in-network service-to-service assertions live in
// tests/integration/service-to-service.checks.js, which runs inside a container.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENABLED = process.env.ARITII_E2E === '1';
const GATEWAY = (process.env.GATEWAY_URL || 'http://localhost:8000').replace(/\/+$/, '');

/** Read INTERNAL_SERVICE_TOKENS from the environment or the root .env. */
function credentialMap() {
  let raw = process.env.INTERNAL_SERVICE_TOKENS || '';
  if (!raw) {
    try {
      const envFile = fs.readFileSync(path.resolve(__dirname, '..', '..', '.env'), 'utf8');
      const line = /^\s*INTERNAL_SERVICE_TOKENS\s*=\s*(.+)$/m.exec(envFile);
      if (line) raw = line[1].trim().replace(/^['"]|['"]$/g, '');
    } catch (_err) { /* no root .env */ }
  }
  try { return JSON.parse(raw); } catch (_err) { return null; }
}

const TOKENS = credentialMap();

async function call(pathname, options) {
  const opts = options || {};
  const res = await fetch(GATEWAY + pathname, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch (_err) { body = text; }
  return { status: res.status, headers: res.headers, body };
}

test('the gateway is alive and reports every downstream service', { skip: !ENABLED }, async () => {
  const live = await call('/health/live');
  assert.equal(live.status, 200, 'liveness must not depend on a downstream service');
  assert.equal(live.body.status, 'alive');

  const ready = await call('/health/ready');
  assert.ok([200, 503].includes(ready.status));
  for (const service of ['identity', 'commerce', 'delivery']) {
    assert.ok(ready.body.services[service], service + ' must be reported');
    assert.equal(ready.body.services[service].ready, true, service + ' should be ready');
  }
  assert.equal(ready.status, 200, 'the gateway is ready when every service is');
});

test('the gateway routes to each service over the private network', { skip: !ENABLED }, async () => {
  // Commerce: a genuinely public read (no user identity required).
  const products = await call('/api/product/public/all');
  assert.equal(products.status, 200, 'commerce must be reachable through the gateway');
  assert.equal(products.body.success, true);

  // Identity: OIDC discovery at the issuer root.
  const discovery = await call('/.well-known/openid-configuration');
  assert.equal(discovery.status, 200, 'identity must be reachable through the gateway');
  assert.ok(discovery.body.issuer, 'discovery must advertise the issuer');

  // Delivery: every /delivery/* path is privilege-gated at the edge (asserted
  // below), so the observable proof that the gateway reaches Delivery is its
  // internal surface with a named caller.
  if (!TOKENS || !TOKENS.delivery) return;
  const dashboard = await call('/api/internal/delivery/operations/dashboard', {
    headers: { 'x-internal-service': 'delivery', 'x-internal-token': TOKENS.delivery },
  });
  assert.equal(dashboard.status, 200, 'delivery must be reachable through the gateway');
  assert.ok(dashboard.body.dashboard, 'delivery answered with its operations dashboard');
});

test('a privilege-gated route is stopped at the edge before it reaches a service', { skip: !ENABLED }, async () => {
  const res = await call('/api/delivery/location/hierarchy');
  assert.equal(res.status, 401, 'the edge must demand a token before proxying this path');
});

test('an unrouted path is answered by the gateway, not by a service', { skip: !ENABLED }, async () => {
  const res = await call('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ROUTE_NOT_FOUND');
});

test('the internal surface cannot be reached without a service credential', { skip: !ENABLED }, async () => {
  const anonymous = await call('/api/internal/users/count');
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.body.code, 'FORBIDDEN');

  const wrongToken = await call('/api/internal/users/count', {
    headers: { 'x-internal-service': 'commerce', 'x-internal-token': 'not-a-real-credential' },
  });
  assert.equal(wrongToken.status, 403);

  const unknownCaller = await call('/api/internal/users/count', {
    headers: { 'x-internal-service': 'unknown-container', 'x-internal-token': (TOKENS && TOKENS.commerce) || 'x' },
  });
  assert.equal(unknownCaller.status, 403);
});

test('client-supplied identity headers never authenticate a request', { skip: !ENABLED }, async () => {
  // The gateway rebuilds x-user-* from a VERIFIED token, so forged headers must
  // not be enough to reach an admin route.
  const res = await call('/api/admin/users', {
    headers: { 'x-user-id': 'attacker', 'x-user-role': 'ADMIN', 'x-user-email': 'attacker@example.com' },
  });
  assert.notEqual(res.status, 200, 'forged x-user-* headers must not be accepted');
  assert.ok([401, 403].includes(res.status), 'expected 401/403, got ' + res.status);
});

test('a valid service credential is accepted at the edge (documented caller model)', { skip: !ENABLED || !TOKENS }, async () => {
  const res = await call('/api/internal/users/count', {
    headers: { 'x-internal-service': 'commerce', 'x-internal-token': TOKENS.commerce },
  });
  assert.equal(res.status, 200, 'a named caller with its own credential must be accepted');
  assert.equal(res.body.success, true);
});

test('every response carries a trace id', { skip: !ENABLED }, async () => {
  const res = await call('/api/delivery/location/hierarchy', { headers: { 'x-request-id': 'e2e-trace-1' } });
  assert.equal(res.headers.get('x-request-id'), 'e2e-trace-1', 'the edge trace id is echoed back');
});
