'use strict';
// The Identity Service's /internal/* gate.
//
// Identity owns the credentials, the roles and the audit log, so this gate is the
// highest-value one in the platform: it must accept exactly the callers that are
// entitled to provision identities, and nothing else.
const { test, before } = require('node:test');
const assert = require('node:assert');

let internalOnly;

function fakeRequest(headers) {
  const lower = {};
  for (const key of Object.keys(headers || {})) lower[key.toLowerCase()] = headers[key];
  return {
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

function run(req) {
  const res = fakeResponse();
  let nexted = false;
  internalOnly(req, res, () => { nexted = true; });
  return { res, nexted };
}

before(() => {
  process.env.INTERNAL_SERVICE_NAME = 'identity';
  process.env.INTERNAL_SERVICE_TOKENS = JSON.stringify({
    gateway: 'gw-secret', identity: 'id-secret', commerce: 'co-secret', delivery: 'dl-secret',
  });
  delete process.env.INTERNAL_SERVICE_TOKEN;
  internalOnly = require('../internalOnly');
});

test('accepts a peer service presenting its own credential', () => {
  const req = fakeRequest({ 'x-internal-service': 'commerce', 'x-internal-token': 'co-secret' });
  const { nexted } = run(req);

  assert.equal(nexted, true);
  assert.equal(req.internalCaller, 'commerce');
  assert.equal(req.fromGateway, undefined, 'a peer service must never be treated as the gateway');
});

test('accepts the gateway presenting its own credential and marks it as the edge', () => {
  const req = fakeRequest({ 'x-internal-service': 'gateway', 'x-internal-token': 'gw-secret' });
  const { nexted } = run(req);

  assert.equal(nexted, true);
  assert.equal(req.internalCaller, 'gateway');
  assert.equal(req.fromGateway, true);
});

test('rejects an anonymous request', () => {
  const { res, nexted } = run(fakeRequest({ 'x-internal-token': 'co-secret' }));
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
  assert.equal(res.captured.body.code, 'FORBIDDEN');
});

test('rejects a request with no credential at all', () => {
  const { res, nexted } = run(fakeRequest({ 'x-internal-service': 'commerce' }));
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
});

test('rejects a caller presenting another service\'s credential', () => {
  // A compromised Delivery must not be able to provision sellers by relabelling
  // itself as Commerce.
  const { res, nexted } = run(fakeRequest({ 'x-internal-service': 'delivery', 'x-internal-token': 'co-secret' }));
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
});

test('rejects an unknown caller even with a valid secret', () => {
  const { res, nexted } = run(fakeRequest({ 'x-internal-service': 'unknown-container', 'x-internal-token': 'co-secret' }));
  assert.equal(nexted, false);
  assert.equal(res.captured.statusCode, 403);
});

test('a legacy long caller name is still recognised', () => {
  const req = fakeRequest({ 'x-internal-service': 'commerce-service', 'x-internal-token': 'co-secret' });
  const { nexted } = run(req);
  assert.equal(nexted, true);
  assert.equal(req.internalCaller, 'commerce');
});
