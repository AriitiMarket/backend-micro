'use strict';
// Delivery-provider (rider) portal contract suite.
//
//   docker compose up -d --build
//   ARITII_E2E=1 npm run test:integration
//
// Every request is the one the rider portal actually makes
// (`customer-frontend/src/features/delivery-provider/services/providerDeliveryApi.js`
// and `src/services/delivery.service.js`), executed through the API Gateway with a
// DELIVERY_PROVIDER token: onboarding, the profile/availability screens, available
// work, my deliveries, my batches and every batch button, tracking, and the
// location reads the address picker depends on.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { call, login, registerAccount } = require('./support/gateway');

const ENABLED = process.env.ARITII_E2E === '1';
const STAMP = Date.now();
const PASSWORD = 'E2e@12345';

const state = {
  admin: null,
  applicant: null,
  provider: null,
  providerToken: null,
  providerId: null,
  batchId: null,
  orderIds: [],
  deliveryIds: [],
};

async function handoff(orderId, { sellerId = 'portal-seller', paymentMethod = 'PREPAID', amount = 0 } = {}) {
  return call('/api/internal/delivery/request', {
    method: 'POST', internal: 'commerce',
    body: {
      orderId, sellerId, buyerId: 'portal-buyer', paymentMethod, paymentAmount: amount,
      pickupAddress: { shopName: 'Portal Shop', cityName: 'Harar', addressDetail: 'Shop 1' },
      deliveryAddress: { cityName: 'Harar', sectorName: 'Sector 01', addressDetail: 'Home 1' },
      items: [{ name: 'Coffee', quantity: 1, weight: 1, value: 500 }],
    },
  });
}

const asProvider = (path, options = {}) => call(`/api${path}`, { ...options, token: state.providerToken });
const asAdmin = (path, options = {}) => call(`/api${path}`, { ...options, token: state.admin });

test('a delivery provider onboards and reaches the state the portal needs', { skip: !ENABLED }, async () => {
  state.admin = await login(process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com', process.env.E2E_ADMIN_PASSWORD || 'Admin@12345');
  const email = `portal.provider.${STAMP}@example.com`;
  await registerAccount('Portal Provider', email, PASSWORD);
  state.applicant = email;

  // Apply (any authenticated account may) → pending.
  const applied = await call('/api/provider-application', {
    method: 'POST', token: await login(email, PASSWORD),
    body: { name: 'Portal Provider', phone: `+2519${String(STAMP).slice(-8)}`, vehicleType: 'motorcycle' },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.application.status, 'pending');
  state.providerId = applied.body.application.id;

  // Admin approves, then the provider comes online (the portal's toggle).
  const approved = await asAdmin(`/provider-application/${state.providerId}/approve`, { method: 'POST', body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  state.providerToken = await login(email, PASSWORD);

  // The portal resolves its own record first (it cannot know the Provider _id).
  const me = await asProvider('/delivery/provider/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(String(me.body.provider._id), String(state.providerId));
  state.provider = me.body.provider;

  const online = await asProvider(`/delivery/provider/${state.providerId}/online`, {
    method: 'PUT', body: { isOnline: true },
  });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.provider.status, 'available', 'an approved, online provider is assignable');

  const refreshed = await asProvider('/delivery/provider/me');
  assert.equal(refreshed.body.provider.availability.isOnline, true);
});

test('the portal screens read: available work, my deliveries, my batches', { skip: !ENABLED }, async () => {
  // Available work: the provider's own offers (the service scopes it for them).
  const offers = await asProvider('/delivery/assignment?status=pending&page=1&limit=50');
  assert.equal(offers.status, 200, JSON.stringify(offers.body));
  assert.ok(Array.isArray(offers.body.assignments), 'portal reads `assignments`');

  // My deliveries: only the ones assigned to this provider.
  const deliveries = await asProvider('/delivery/delivery?page=1&limit=50');
  assert.equal(deliveries.status, 200, JSON.stringify(deliveries.body));
  assert.ok(Array.isArray(deliveries.body.deliveries), 'portal reads `deliveries`');
  const foreign = deliveries.body.deliveries.filter((d) => String(d.providerId || '') !== String(state.providerId));
  assert.equal(foreign.length, 0, 'a provider never sees another provider\'s deliveries');

  // My batches.
  const batches = await asProvider('/delivery/dispatch/mine?page=1&limit=50');
  assert.equal(batches.status, 200, JSON.stringify(batches.body));
  assert.ok(Array.isArray(batches.body.assignments), 'portal reads `assignments` (batches)');
  assert.ok(Array.isArray(batches.body.deliveries) || batches.body.assignments !== undefined);

  // Address picker (location reads) must work for a provider as for any actor.
  const hierarchy = await asProvider('/delivery/location/hierarchy');
  assert.equal(hierarchy.status, 200, JSON.stringify(hierarchy.body));
  assert.ok(Array.isArray(hierarchy.body.hierarchy), 'portal reads `hierarchy`');
  const search = await asProvider('/delivery/location/search?q=Harar');
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.locations), 'portal reads `locations`');
});

test('every batch button works for the assigned provider, end to end', { skip: !ENABLED }, async () => {
  // Two orders from two sellers → a real multi-order batch.
  state.orderIds = [`PORTAL-1-${STAMP}`, `PORTAL-2-${STAMP}`];
  for (const [index, orderId] of state.orderIds.entries()) {
    const res = await handoff(orderId, { sellerId: `portal-seller-${index}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const ready = await asAdmin('/delivery/dispatch/ready-orders?page=1&limit=100');
  const deliveryIds = ready.body.orders
    .filter((o) => state.orderIds.includes(o.orderId))
    .map((o) => o.id);
  assert.equal(deliveryIds.length, 2, 'both portal orders are ready for dispatch');
  state.deliveryIds = deliveryIds;

  const created = await asAdmin('/delivery/dispatch/batches', {
    method: 'POST', body: { deliveryIds, providerId: state.providerId },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  state.batchId = created.body.assignment._id;
  const stops = created.body.assignment.pickupPlan || [];
  assert.equal(stops.length, 2, 'one pickup stop per seller');

  const accept = await asProvider(`/delivery/dispatch/batches/${state.batchId}/respond`, {
    method: 'POST', body: { accepted: true },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.assignment.status, 'accepted', 'portal reads `assignment`');

  const detail = await asProvider(`/delivery/dispatch/batches/${state.batchId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(String(detail.body.assignment.providerId), String(state.providerId), 'the batch is the provider\'s own');

  // The button sequence, exactly as the portal fires it.
  const pickup = await asProvider(`/delivery/dispatch/batches/${state.batchId}/pickup/start`, { method: 'POST', body: {} });
  assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
  assert.equal(pickup.body.assignment.status, 'picking_up');

  for (const stop of stops) {
    const confirmed = await asProvider(`/delivery/dispatch/batches/${state.batchId}/pickup/${stop.sellerId}/confirm`, {
      method: 'POST', body: {},
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  }
  const allPicked = await asProvider(`/delivery/dispatch/batches/${state.batchId}`);
  assert.equal(allPicked.body.assignment.status, 'picked_up', 'the batch waits for every seller stop');

  const transit = await asProvider(`/delivery/dispatch/batches/${state.batchId}/transit/start`, { method: 'POST', body: {} });
  assert.equal(transit.status, 200, JSON.stringify(transit.body));

  // The rider's own tracking update, then the history the portal renders.
  const tracked = await asProvider('/delivery/tracking', {
    method: 'POST',
    body: { deliveryId: state.deliveryIds[0], location: { type: 'Point', coordinates: [42.12, 9.31] }, note: 'on the way' },
  });
  assert.equal(tracked.status, 200, JSON.stringify(tracked.body));

  const history = await asProvider(`/delivery/tracking/${state.deliveryIds[0]}`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.ok(Array.isArray(history.body.events), 'portal reads `events`');
  const latest = await asProvider(`/delivery/tracking/${state.deliveryIds[0]}/latest`);
  assert.equal(latest.status, 200);

  // Per-order completion, the last button on the screen.
  for (const orderId of state.orderIds) {
    const done = await asProvider(`/delivery/dispatch/batches/${state.batchId}/orders/${orderId}/deliver`, {
      method: 'POST', body: { note: 'Handed to the buyer' },
    });
    assert.equal(done.status, 200, `${orderId}: ${JSON.stringify(done.body)}`);
  }
  const finished = await asProvider(`/delivery/dispatch/batches/${state.batchId}`);
  assert.equal(finished.body.assignment.status, 'completed', 'the batch completes when every order is delivered');
  const me = await asProvider('/delivery/provider/me');
  assert.equal(me.body.provider.activeDeliveries, 0, 'capacity is released');
});


test('the portal cannot reach another provider\'s work, and admin surfaces stay closed', { skip: !ENABLED }, async () => {
  // A second provider (approved + online) that owns nothing.
  const email = `portal.stranger.${STAMP}@example.com`;
  await registerAccount('Portal Stranger', email, PASSWORD);
  const applied = await call('/api/provider-application', {
    method: 'POST', token: await login(email, PASSWORD),
    body: { name: 'Portal Stranger', phone: `+2518${String(STAMP).slice(-8)}` },
  });
  await asAdmin(`/provider-application/${applied.body.application.id}/approve`, { method: 'POST', body: {} });
  const token = await login(email, PASSWORD);
  const strangerId = applied.body.application.id;
  await call(`/api/delivery/provider/${strangerId}/online`, { method: 'PUT', token, body: { isOnline: true } });

  const mine = await call('/api/delivery/provider/me', { token });
  assert.equal(mine.status, 200, 'a provider can read its own record');
  assert.equal(String(mine.body.provider._id), String(strangerId));

  const cases = [
    // The batch cases only apply when the flow above produced a batch id; without
    // one these would fail for the wrong reason (a `null` id is a 400).
    ...(state.batchId ? [
      ['GET', `/api/delivery/dispatch/batches/${state.batchId}`, undefined],
      ['POST', `/api/delivery/dispatch/batches/${state.batchId}/pickup/start`, {}],
    ] : []),
    ...(state.deliveryIds.length ? [
      ['GET', `/api/delivery/delivery/${state.deliveryIds[0]}`, undefined],
      ['GET', `/api/delivery/tracking/${state.deliveryIds[0]}`, undefined],
      ['POST', '/api/delivery/tracking', { deliveryId: state.deliveryIds[0] }],
    ] : []),
  ];
  for (const [method, path, body] of cases) {
    const res = await call(path, { method, body, token });
    assert.ok([403, 404].includes(res.status), `a stranger must not ${method} ${path} (got ${res.status})`);
  }

  // ...and the admin-only surfaces stay closed to a provider.
  const adminOnly = [
    ['GET', '/api/delivery/provider', undefined],
    ['GET', '/api/delivery/dispatch/ready-orders', undefined],
    ['POST', '/api/delivery/dispatch/batches', { deliveryIds: [], providerId: state.providerId }],
    ['GET', '/api/delivery/operation/dashboard', undefined],
    ['GET', '/api/delivery/route', undefined],
    ['POST', '/api/delivery/zone', { name: 'x', code: `P-${STAMP}` }],
  ];
  for (const [method, path, body] of adminOnly) {
    const res = await call(path, { method, body, token });
    assert.ok([401, 403].includes(res.status), `a provider must not ${method} ${path} (got ${res.status})`);
  }
});

