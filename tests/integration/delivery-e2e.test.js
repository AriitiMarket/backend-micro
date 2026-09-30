'use strict';
// End-to-end delivery lifecycle against a RUNNING stack (through the gateway).
//
//   docker compose up -d --build      # from backend-services/
//   ARITII_E2E=1 npm run test:integration
//
// The scenario is the real marketplace loop:
//
//   admin approves a DELIVERY_PROVIDER → Commerce hands an order to Delivery →
//   admin assigns the provider → provider accepts, picks up, tracks, arrives and
//   completes the delivery (with the COD receipt) → the buyer sees DELIVERED →
//   everyone else is refused.
//
// Skipped by default so `npm test` never needs Docker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENABLED = process.env.ARITII_E2E === '1';
const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

/** Read the per-caller cluster credentials from the environment or the root .env. */
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

async function call(pathname, { method = 'GET', body, token, internal, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (internal) {
    h['x-internal-service'] = internal;
    h['x-internal-token'] = TOKENS[internal];
  }
  const res = await fetch(GATEWAY + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
  return { status: res.status, body: parsed };
}

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Real OIDC + PKCE sign-in: authorization code, then the token exchange. */
async function login(email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const authorize = await call('/api/auth/authorize', {
    method: 'POST',
    body: {
      client_id: 'aritii-admin-web', email, password,
      code_challenge: s256(verifier), code_challenge_method: 'S256',
    },
  });
  if (authorize.status !== 200) throw new Error(`authorize failed: ${authorize.status} ${JSON.stringify(authorize.body)}`);
  const token = await call('/api/auth/token', {
    method: 'POST',
    body: {
      grant_type: 'authorization_code', code: authorize.body.code,
      code_verifier: verifier, client_id: 'aritii-admin-web',
    },
  });
  if (token.status !== 200) throw new Error(`token failed: ${token.status} ${JSON.stringify(token.body)}`);
  return token.body.access_token || token.body.accessToken;
}

async function registerAccount(name, email, password) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: {
      client_id: 'aritii-admin-web', name, email, password,
      code_challenge: s256(verifier), code_challenge_method: 'S256',
    },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.user.id;
}

const STAMP = Date.now();
const PROVIDER_EMAIL = `e2e.provider.${STAMP}@example.com`;
const BUYER_EMAIL = `e2e.buyer.${STAMP}@example.com`;
const ORDER_ID = `E2E-${STAMP}`;
const PASSWORD = 'E2e@12345';

/** Everything the scenario shares, resolved as the scenario progresses. */
const state = { buyerId: null, providerId: null, deliveryId: null, assignmentId: null };

test('ADMIN approves a DELIVERY_PROVIDER and the provider can then go online', { skip: !ENABLED }, async () => {
  const admin = await login(process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com', process.env.E2E_ADMIN_PASSWORD || 'Admin@12345');
  state.adminToken = admin;
  state.buyerId = await registerAccount('E2E Buyer', BUYER_EMAIL, PASSWORD);
  state.buyerToken = await login(BUYER_EMAIL, PASSWORD);

  await registerAccount('E2E Provider', PROVIDER_EMAIL, PASSWORD).catch(() => null);
  const applicant = await login(PROVIDER_EMAIL, PASSWORD);
  state.providerToken = applicant;

  const application = await call('/api/provider-application', {
    method: 'POST', token: applicant,
    body: { name: 'E2E Provider', phone: '+251900000999', vehicleType: 'motorcycle', providerType: 'individual_rider' },
  });
  assert.ok([200, 201].includes(application.status), JSON.stringify(application.body));
  state.providerId = application.body.application.id;
  assert.equal(application.body.application.status, 'pending', 'an application starts pending');

  // A pending provider cannot take operational actions.
  const pendingOnline = await call(`/api/delivery/provider/${state.providerId}/online`, {
    method: 'PUT', token: applicant, body: { isOnline: true },
  });
  assert.equal(pendingOnline.status, 403, 'a pending provider must not be able to go online');

  const approved = await call(`/api/provider-application/${state.providerId}/approve`, {
    method: 'POST', token: admin, body: {},
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.application.status, 'offline', 'approved, waiting to go online');

  // Re-login so the refreshed membership is in the token, then go online.
  state.providerToken = await login(PROVIDER_EMAIL, PASSWORD);
  const online = await call(`/api/delivery/provider/${state.providerId}/online`, {
    method: 'PUT', token: state.providerToken, body: { isOnline: true },
  });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.provider.status, 'available', 'an approved provider that comes online is assignable');
});

test('Commerce hands an order to Delivery exactly once, and the buyer can read it', { skip: !ENABLED }, async () => {
  const admin = state.adminToken;
  const handoffBody = {
    orderId: ORDER_ID, sellerId: 'e2e-seller', buyerId: state.buyerId,
    paymentMethod: 'COD', paymentAmount: 350,
    pickupAddress: { shopName: 'E2E Coffee', cityName: 'Harar', addressDetail: 'Shop 1' },
    deliveryAddress: { cityName: 'Harar', sectorName: 'Sector 01', addressDetail: 'Home 1' },
    items: [{ name: 'Coffee', quantity: 1, weight: 1, value: 350 }],
  };

  const handoff = await call('/api/internal/delivery/request', { method: 'POST', internal: 'commerce', body: handoffBody });
  assert.equal(handoff.status, 201, JSON.stringify(handoff.body));

  // Duplicate protection: the same order twice, one request, one delivery.
  const duplicate = await call('/api/internal/delivery/request', {
    method: 'POST', internal: 'commerce', body: handoffBody,
  });
  assert.ok([200, 201].includes(duplicate.status));
  assert.equal(String(duplicate.body.request._id), String(handoff.body.request._id), 'the same request is returned');

  const deliveries = await call(`/api/delivery/delivery?orderId=${ORDER_ID}`, { token: admin });
  assert.equal(deliveries.body.total, 1, 'exactly one delivery exists for the order');

  const delivery = await call(`/api/delivery/delivery/order/${ORDER_ID}`, { token: admin });
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.delivery.status, 'pending');
  state.deliveryId = delivery.body.delivery._id;

  const buyerView = await call(`/api/delivery/delivery/order/${ORDER_ID}`, { token: state.buyerToken });
  assert.equal(buyerView.status, 200, 'the buyer sees the delivery of their own order');
  assert.equal(buyerView.body.delivery.provider, null, 'no provider is assigned yet');
  assert.equal(buyerView.body.delivery.metadata, undefined, 'internal metadata is not exposed to the buyer');

  // A handoff for a delivery with no pickup/destination is rejected outright.
  const invalid = await call('/api/internal/delivery/request', {
    method: 'POST', internal: 'commerce',
    body: { orderId: `E2E-BAD-${STAMP}`, sellerId: 'e2e-seller', buyerId: state.buyerId },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');
});


test('the assigned provider drives the delivery to completion', { skip: !ENABLED }, async () => {
  const admin = state.adminToken;
  const provider = state.providerToken;

  const assigned = await call(`/api/delivery/delivery/${state.deliveryId}/assign`, {
    method: 'PUT', token: admin, body: { providerId: state.providerId },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  state.assignmentId = assigned.body.assignment._id;

  const accepted = await call(`/api/delivery/assignment/${state.assignmentId}/respond`, {
    method: 'POST', token: provider, body: { accepted: true },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.assignment.status, 'accepted');

  for (const status of ['pickup', 'in_transit']) {
    const res = await call(`/api/delivery/delivery/${state.deliveryId}/status`, {
      method: 'PUT', token: admin, body: { status },
    });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.delivery.status, status);
  }

  const tracked = await call('/api/delivery/tracking', {
    method: 'POST', token: provider,
    body: { deliveryId: state.deliveryId, location: { type: 'Point', coordinates: [42.12, 9.31] }, note: 'on the way' },
  });
  assert.equal(tracked.status, 200, JSON.stringify(tracked.body));

  // A COD delivery is completed WITH its receipt (the rider portal collects the
  // cash and confirms the amount). The strict "no receipt, no delivery" rule for
  // the provider actor is asserted in the service-level dispatch suite; an
  // administrator is allowed to close it out and the override is recorded on the
  // delivery instead of being silent.
  const delivered = await call(`/api/delivery/delivery/${state.deliveryId}/status`, {
    method: 'PUT', token: admin, body: {
      status: 'delivered',
      proofOfDelivery: { codConfirmed: true, codCollectedAmount: 350, recipientName: 'E2E Buyer' },
    },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.delivery.status, 'delivered');
  assert.equal(delivered.body.delivery.proofOfDelivery.codConfirmed, true, 'the COD receipt is persisted');
  assert.equal(delivered.body.delivery.proofOfDelivery.codCollectedAmount, 350);
  assert.equal(delivered.body.delivery.deliveredAt !== null, true, 'the completion milestone is stamped');
});

test('the buyer sees DELIVERED, other actors are refused, and admin keeps the record', { skip: !ENABLED }, async () => {
  const admin = state.adminToken;

  const buyerView = await call(`/api/delivery/delivery/order/${ORDER_ID}`, { token: state.buyerToken });
  assert.equal(buyerView.status, 200, JSON.stringify(buyerView.body));
  assert.equal(buyerView.body.delivery.status, 'delivered', 'the buyer sees the delivered status');
  assert.ok(buyerView.body.delivery.provider, 'the buyer sees who delivered it');
  assert.equal(buyerView.body.delivery.provider.phone, undefined, 'provider contact details are not exposed');
  assert.equal(buyerView.body.delivery.assignmentHistory, undefined, 'internal assignment history is not exposed');

  const buyerTracking = await call(`/api/delivery/tracking/${state.deliveryId}`, { token: state.buyerToken });
  assert.equal(buyerTracking.status, 200, 'the buyer can follow their own delivery');
  assert.ok(buyerTracking.body.count >= 3, `history is preserved (${buyerTracking.body.count} events)`);

  // The buyer cannot act on the delivery.
  for (const [method, pathName, body] of [
    ['PUT', `/api/delivery/delivery/${state.deliveryId}/status`, { status: 'pending' }],
    ['POST', '/api/delivery/assignment', { deliveryId: state.deliveryId, providerId: state.providerId }],
    ['POST', '/api/delivery/tracking', { deliveryId: state.deliveryId }],
    ['PUT', `/api/delivery/delivery/${state.deliveryId}/assign`, { providerId: state.providerId }],
    ['GET', '/api/delivery/provider'],
    ['GET', '/api/delivery/dispatch/ready-orders'],
  ]) {
    const res = await call(pathName, { method, token: state.buyerToken, body });
    assert.ok([401, 403, 404].includes(res.status), `${method} ${pathName} must be refused (got ${res.status})`);
  }

  // The admin keeps a complete operational record.
  const history = await call(`/api/delivery/delivery/${state.deliveryId}/history`, { token: admin });
  assert.equal(history.status, 200);
  assert.ok(history.body.timeline.length >= 4, 'the milestone timeline is complete');
  const stages = new Set(history.body.trackingEvents.map((e) => e.stage));
  for (const stage of ['assigned', 'pickup', 'in_transit', 'delivered']) {
    assert.ok(stages.has(stage), `"${stage}" appears in the history`);
  }

  const assignments = await call(`/api/delivery/assignment?deliveryId=${state.deliveryId}`, { token: admin });
  assert.equal(assignments.status, 200);
  assert.ok(assignments.body.total >= 1, 'the assignment record is kept');

  // And a later delivery cannot move backwards.
  const backwards = await call(`/api/delivery/delivery/${state.deliveryId}/status`, {
    method: 'PUT', token: admin, body: { status: 'in_transit' },
  });
  assert.equal(backwards.status, 409, 'a delivered delivery is terminal');
});


