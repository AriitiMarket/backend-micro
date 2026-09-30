'use strict';
// Gateway dispatch table + the /internal/* edge gate.
const { test, before } = require('node:test');
const assert = require('node:assert');

let routes;
let requireInternalToken;

/** Minimal Express-like request stand-in. */
function fakeRequest(headers) {
  const lower = {};
  for (const key of Object.keys(headers || {})) lower[key.toLowerCase()] = headers[key];
  return {
    headers: lower,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

/** Minimal Express-like response stand-in capturing the status and body. */
function fakeResponse() {
  const captured = { statusCode: 0, body: null };
  return {
    captured,
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; },
  };
}

before(() => {
  process.env.INTERNAL_SERVICE_NAME = 'gateway';
  process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify({
    gateway: 'gw-secret', identity: 'id-secret', commerce: 'co-secret', delivery: 'dl-secret',
  });
  delete process.env.INTERNAL_SERVICE_TOKEN;

  routes = require('../routes');
  requireInternalToken = require('../middleware/requireInternalToken');
});

test('routing is segment-aware, so a prefix never swallows a longer sibling', () => {
  assert.equal(routes.matchTarget('/product'), 'commerce');
  assert.equal(routes.matchTarget('/product/42/reviews'), 'commerce');
  assert.equal(routes.matchTarget('/products'), null, '/product must not match /products');
  assert.equal(routes.matchTarget('/delivery/location/hierarchy'), 'delivery');
  assert.equal(routes.matchTarget('/.well-known/openid-configuration'), 'identity');
  assert.equal(routes.matchTarget('/uploads/x.png'), 'uploads');
});

test('the most specific admin prefix wins over the generic /admin entry', () => {
  assert.equal(routes.matchTarget('/admin/platform/hierarchy'), 'commerce');
  assert.equal(routes.matchTarget('/admin/shops'), 'commerce');
  assert.equal(routes.matchTarget('/admin/users'), 'identity');
  assert.equal(routes.matchTarget('/admin/roles'), 'identity');
});

test('an unrouted path is not dispatched to a service', () => {
  assert.equal(routes.matchTarget('/definitely-not-a-route'), null);
  assert.equal(routes.matchTarget('/internal'), null);
});

test('internal paths resolve to the owning service', () => {
  assert.equal(routes.matchInternalTarget('/internal/delivery/request'), 'delivery');
  assert.equal(routes.matchInternalTarget('/internal/commerce/delivery-webhook/status'), 'commerce');
  assert.equal(routes.matchInternalTarget('/internal/users/count'), 'identity');
  assert.equal(routes.matchInternalTarget('/internal/audit-log'), 'identity');
  assert.equal(routes.matchInternalTarget('/delivery/location'), null);
});

test('the edge gate rejects an internal call with no credential', () => {
  const req = fakeRequest({});
  const res = fakeResponse();
  let nextCalled = false;

  requireInternalToken(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 403);
  assert.equal(res.captured.body.code, 'FORBIDDEN');
});

test('the edge gate rejects an unauthenticated but named caller', () => {
  const res = fakeResponse();
  let nextCalled = false;

  requireInternalToken(fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'wrong' }), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 403);
});

test('the edge gate accepts a named caller with its own credential', () => {
  const req = fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'co-secret' });
  const res = fakeResponse();
  let nextCalled = false;

  requireInternalToken(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.internalCaller, 'commerce', 'the caller is recorded for auditability');
});

// ── Authorization table ──────────────────────────────────────────────────────
// Regression: the location tree is reference data every actor needs (address
// pickers), and Delivery serves those reads without an identity. A BUYER token
// used to be stopped at the edge with `403 PERMISSION_DENIED:
// locations.view`, so the customer-facing address picker could never load.
test('the location tree is a shared actor read, not an admin-only surface', () => {
  const authorizeRequest = require('../middleware/authorizeRequest');

  assert.equal(authorizeRequest.requiredPermission('GET', '/delivery/location/hierarchy'), 'locations.view');
  assert.equal(authorizeRequest.isActorSharedPath('/delivery/location/hierarchy'), true);
  assert.equal(authorizeRequest.isActorSharedPath('/delivery/location/search'), true);
  assert.equal(authorizeRequest.isActorSharedPath('/delivery/location'), true);

  // The rest of the network configuration stays admin-only at the edge.
  for (const path of ['/delivery/zone', '/delivery/hub', '/delivery/route', '/delivery/operation/dashboard']) {
    assert.equal(authorizeRequest.isActorSharedPath(path), false, `${path} must stay admin-gated at the edge`);
  }
});

