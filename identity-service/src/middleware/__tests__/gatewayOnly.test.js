'use strict';
// The Identity Service's gateway gate.
//
// Identity publishes no port, so its browser-facing surface (/auth, /user,
// /admin, ...) must only ever be reached through the API Gateway. Before this
// gate existed, any container on the private network could call it directly.
const { test, before } = require('node:test');
const assert = require('node:assert');

let gatewayOnly;

function fakeRequest(path, headers) {
  const lower = {};
  for (const key of Object.keys(headers || {})) lower[key.toLowerCase()] = headers[key];
  return {
    path,
    headers: lower,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

function fakeResponse() {
  const captured = { statusCode: 0, body: null };
  return {
    captured,
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; },
  };
}

function run(path, headers) {
  const req = fakeRequest(path, headers);
  const res = fakeResponse();
  let nexted = false;
  gatewayOnly(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

before(() => {
  process.env.INTERNAL_SERVICE_NAME = 'identity';
  process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify({
    gateway: 'gw-secret', identity: 'id-secret', commerce: 'co-secret', delivery: 'dl-secret',
  });
  delete process.env.INTERNAL_SERVICE_TOKEN;
  gatewayOnly = require('../gatewayOnly');
});

test('probe and public discovery paths stay open (no credential required)', () => {
  for (const path of ['/', '/health', '/health/live', '/health/ready', '/.well-known/openid-configuration']) {
    assert.equal(run(path).nexted, true, path + ' must be reachable for probes');
  }
});

test('static media stays open for the gateway uploads proxy, which sends no service headers', () => {
  assert.equal(run('/uploads/avatar.png').nexted, true);
});

test('gateway traffic is trusted and marked as coming from the edge', () => {
  const { req, nexted } = run('/auth/token', { 'x-internal-service': 'gateway', 'x-internal-token': 'gw-secret' });
  assert.equal(nexted, true);
  assert.equal(req.fromGateway, true);
  assert.equal(req.internalCaller, 'gateway');
});

test('a peer service is confined to the internal namespace', () => {
  // It may reach /internal/* ...
  const internal = run('/internal/users/count', { 'x-internal-service': 'commerce', 'x-internal-token': 'co-secret' });
  assert.equal(internal.nexted, true);
  assert.equal(internal.req.fromGateway, undefined, 'a service call is not a user identity');

  // ... but never a user-facing route.
  const publicRoute = run('/auth/token', { 'x-internal-service': 'commerce', 'x-internal-token': 'co-secret' });
  assert.equal(publicRoute.nexted, false);
  assert.equal(publicRoute.res.captured.statusCode, 403);
  assert.match(publicRoute.res.captured.body.message, /internal API/);
});

test('a direct call with no credential is refused', () => {
  const { res, nexted } = run('/auth/token', {});
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
});

test('a forged gateway identity is refused (wrong credential)', () => {
  const { res, nexted } = run('/admin/users', { 'x-internal-service': 'gateway', 'x-internal-token': 'not-the-gateway-secret' });
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
});
