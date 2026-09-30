'use strict';
// Admin console contract suite — every call the Aritii admin web makes against
// the Delivery Service, executed through the API Gateway with an ADMIN token.
//
//   docker compose up -d --build
//   ARITII_E2E=1 npm run test:integration
//
// It is the executable form of "the admin console works completely in its role":
// each request below is copied from `Aritii-admin-web/src/api/admin.ts` and
// `src/services/*.service.ts` — same method, same path, same body — and each
// assertion checks the envelope key the console actually reads. A screen that
// renders empty because a key was renamed fails here, not in production.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { call, login, registerAccount } = require('./support/gateway');

const ENABLED = process.env.ARITII_E2E === '1';
const STAMP = Date.now();
const PASSWORD = 'E2e@12345';
const BUYER_EMAIL = `e2e.console.buyer.${STAMP}@example.com`;

/** Everything the console flow needs; filled in as the suite progresses. */
const state = {
  admin: null,
  buyer: null,
  providerId: null,
  deliveryId: null,
  orderId: null,
  assignmentId: null,
  batchId: null,
  countryId: null,
  cityId: null,
  sectorId: null,
  zoneId: null,
  serviceId: null,
  hubId: null,
  routeId: null,
};

async function asAdmin(pathname, options = {}) {
  return call(`/api${pathname}`, { ...options, token: state.admin });
}

/** Commerce → Delivery handoff, so there is a real order to operate on. */
async function handoff(orderId) {
  return call('/api/internal/delivery/request', {
    method: 'POST', internal: 'commerce',
    body: {
      orderId, sellerId: 'console-seller', buyerId: 'console-buyer',
      paymentMethod: 'PREPAID', paymentAmount: 0,
      pickupAddress: { shopName: 'Console Shop', cityName: 'Harar', addressDetail: 'Shop 1' },
      deliveryAddress: { cityName: 'Harar', sectorName: 'Sector 01', addressDetail: 'Home 1' },
      items: [{ name: 'Coffee', quantity: 1, weight: 1, value: 500 }],
    },
  });
}

test('ADMIN sign-in and the buyer account used for the guard checks', { skip: !ENABLED }, async () => {
  state.admin = await login(process.env.E2E_ADMIN_EMAIL || 'admin@aritii.com', process.env.E2E_ADMIN_PASSWORD || 'Admin@12345');
  await registerAccount('Console Buyer', BUYER_EMAIL, PASSWORD);
  state.buyer = await login(BUYER_EMAIL, PASSWORD);
  assert.ok(state.admin && state.buyer);
});

test('provider roster: list, filters, detail, create, update, status, approve', { skip: !ENABLED }, async () => {
  const list = await asAdmin('/delivery/provider?page=1&limit=50');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(Array.isArray(list.body.providers), 'console reads `providers`');
  assert.equal(typeof list.body.total, 'number');

  const filtered = await asAdmin('/delivery/provider?page=1&limit=10&search=Ahmed');
  assert.equal(filtered.status, 200);
  assert.ok(Array.isArray(filtered.body.providers));

  const created = await asAdmin('/delivery/provider', {
    method: 'POST',
    body: {
      name: `Console Rider ${STAMP}`, phone: `+2519${String(STAMP).slice(-8)}`,
      email: `console.rider.${STAMP}@example.com`, vehicleType: 'bicycle',
      providerType: 'individual_rider', maxActiveAssignments: 2,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.provider, 'console reads `provider`');
  state.providerId = created.body.provider._id;

  const detail = await asAdmin(`/delivery/provider/${state.providerId}`);
  assert.equal(detail.status, 200);
  assert.equal(String(detail.body.provider._id), String(state.providerId));

  // The console's update facade now sends only whitelisted profile fields.
  const updated = await asAdmin(`/delivery/provider/${state.providerId}`, {
    method: 'PUT', body: { name: `Console Rider ${STAMP} v2`, vehicleType: 'motorcycle' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.provider.name, `Console Rider ${STAMP} v2`);

  // A field the service owns is refused with a clear code, not silently written.
  const refused = await asAdmin(`/delivery/provider/${state.providerId}`, {
    method: 'PUT', body: { status: 'available' },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'UNSUPPORTED_FIELD');

  for (const status of ['available', 'busy', 'offline', 'available']) {
    const res = await asAdmin(`/delivery/provider/${state.providerId}/status`, { method: 'PUT', body: { status } });
    assert.equal(res.status, 200, `status → ${status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.provider.status, status);
  }

  // Approval also provisions the account role in Identity; when Identity is not
  // reachable the service answers 502 rather than half-approving.
  const approve = await asAdmin(`/delivery/provider/${state.providerId}/approve`, { method: 'POST', body: {} });
  assert.ok([200, 502].includes(approve.status), `approve: ${JSON.stringify(approve.body)}`);
  if (approve.status === 200) assert.ok(approve.body.application || approve.body.provider);
});

test('deliveries workspace: list, filters, detail, history, assign, status', { skip: !ENABLED }, async () => {
  state.orderId = `CONSOLE-${STAMP}`;
  const handoffRes = await handoff(state.orderId);
  assert.equal(handoffRes.status, 201, JSON.stringify(handoffRes.body));

  const list = await asAdmin('/delivery/delivery?page=1&limit=50');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.deliveries), 'console reads `deliveries`');
  assert.equal(typeof list.body.total, 'number');

  for (const status of ['pending', 'assigned', 'in_transit', 'delivered']) {
    const filtered = await asAdmin(`/delivery/delivery?page=1&limit=10&status=${status}`);
    assert.equal(filtered.status, 200, `status filter ${status}: ${JSON.stringify(filtered.body)}`);
    assert.ok(Array.isArray(filtered.body.deliveries));
  }
  const byOrder = await asAdmin(`/delivery/delivery?orderId=${encodeURIComponent(state.orderId)}`);
  assert.equal(byOrder.body.total, 1, 'the order deep link used by the console resolves to one delivery');
  state.deliveryId = byOrder.body.deliveries[0]._id;

  const searched = await asAdmin(`/delivery/delivery?search=${encodeURIComponent(state.orderId)}`);
  assert.equal(searched.status, 200);

  const detail = await asAdmin(`/delivery/delivery/${state.deliveryId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.delivery, 'console reads `delivery`');

  const history = await asAdmin(`/delivery/delivery/${state.deliveryId}/history`);
  assert.equal(history.status, 200);
  for (const key of ['timeline', 'trackingEvents', 'assignmentHistory']) {
    assert.ok(Array.isArray(history.body[key]), `history.${key} is what the detail modal renders`);
  }

  // Dispatch-eligible providers picker.
  const eligible = await asAdmin(`/delivery/assignment/eligible-partners?deliveryId=${state.deliveryId}`);
  assert.equal(eligible.status, 200, JSON.stringify(eligible.body));
  assert.ok(Array.isArray(eligible.body.providers), 'console reads `providers`');

  // A provider must be online before the console may assign work to it.
  const online = await asAdmin(`/delivery/provider/${state.providerId}/online`, { method: 'PUT', body: { isOnline: true } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.provider.availability.isOnline, true);
  assert.equal(online.body.provider.status, 'available', 'coming online makes the provider assignable');

  // Assign from the delivery row.
  const assigned = await asAdmin(`/delivery/delivery/${state.deliveryId}/assign`, {
    method: 'PUT', body: { providerId: state.providerId },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.ok(assigned.body.assignment, 'console reads `assignment`');
  state.assignmentId = assigned.body.assignment._id;

  const afterAssign = await asAdmin(`/delivery/delivery/${state.deliveryId}`);
  assert.equal(afterAssign.body.delivery.status, 'assigned');

  // The transition buttons the console renders, driven exactly as the console does.
  for (const status of ['pickup', 'in_transit', 'out_for_delivery', 'delivered']) {
    const res = await asAdmin(`/delivery/delivery/${state.deliveryId}/status`, {
      method: 'PUT', body: { status, note: `console ${status}` },
    });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.delivery.status, status);
  }

  // Assignments workspace.
  const assignments = await asAdmin(`/delivery/assignment?page=1&limit=50&deliveryId=${state.deliveryId}`);
  assert.equal(assignments.status, 200);
  assert.ok(Array.isArray(assignments.body.assignments), 'console reads `assignments`');
  const one = await asAdmin(`/delivery/assignment/${state.assignmentId}`);
  assert.equal(one.status, 200);
  assert.ok(one.body.assignment);
});

test('delivery requests workspace (Commerce handoff queue)', { skip: !ENABLED }, async () => {
  const list = await asAdmin('/delivery/request?page=1&limit=50');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(Array.isArray(list.body.requests), 'console reads `requests`');
  const found = list.body.requests.find((r) => r.orderId === state.orderId);
  assert.ok(found, 'the order handed over from Commerce is listed for the console');
  assert.ok(found.deliveryId, 'the row links to its materialized delivery');

  const one = await asAdmin(`/delivery/request/${found._id}`);
  assert.equal(one.status, 200);
  assert.ok(one.body.request);
});


test('dispatch workspace: ready orders, batch create, list, detail, reassign, cancel', { skip: !ENABLED }, async () => {
  const ready = await asAdmin('/delivery/dispatch/ready-orders?page=1&limit=50');
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.ok(Array.isArray(ready.body.orders), 'console reads `orders`');

  // Two fresh orders: the one driven in the previous test is already delivered
  // and therefore no longer in the ready pool.
  const batchOrders = [`CONSOLE-B1-${STAMP}`, `CONSOLE-B2-${STAMP}`];
  for (const orderId of batchOrders) assert.equal((await handoff(orderId)).status, 201);
  const readyAgain = await asAdmin('/delivery/dispatch/ready-orders?page=1&limit=50');
  const ids = readyAgain.body.orders
    .filter((o) => batchOrders.includes(o.orderId))
    .map((o) => o.id);
  assert.equal(ids.length, 2, 'both console orders are ready for dispatch');

  const batch = await asAdmin('/delivery/dispatch/batches', {
    method: 'POST', body: { deliveryIds: ids, providerId: state.providerId },
  });
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  assert.ok(batch.body.assignment, 'console reads `assignment`');
  assert.ok(batch.body.assignment.reference, 'the human reference the console shows');
  state.batchId = batch.body.assignment._id;

  const list = await asAdmin('/delivery/dispatch/batches?page=1&limit=50');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.assignments), 'console reads `assignments` for the batch list');

  const detail = await asAdmin(`/delivery/dispatch/batches/${state.batchId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.assignment);

  const cancelled = await asAdmin(`/delivery/dispatch/batches/${state.batchId}/cancel`, {
    method: 'POST', body: { reason: 'console check' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.assignment.status, 'cancelled');

  // Reassignment needs a live batch: create another one and hand it over.
  const thirdOrder = `CONSOLE-R-${STAMP}`;
  assert.equal((await handoff(thirdOrder)).status, 201);
  const readyThird = await asAdmin('/delivery/dispatch/ready-orders?page=1&limit=50');
  const thirdId = readyThird.body.orders.find((o) => o.orderId === thirdOrder).id;
  const second = await asAdmin('/delivery/dispatch/batches', {
    method: 'POST', body: { deliveryIds: [thirdId], providerId: state.providerId },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const providers = await asAdmin('/delivery/provider?status=available&limit=50');
  const other = (providers.body.providers || []).find((p) => String(p._id) !== String(state.providerId));
  if (other) {
    const reassigned = await asAdmin(`/delivery/dispatch/batches/${second.body.assignment._id}/reassign`, {
      method: 'POST', body: { providerId: other._id, reason: 'console reassign check' },
    });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.ok(reassigned.body.assignment, 'console reads the new assignment');
  }
});


test('network workspace: locations, zones, hubs, routes, delivery services', { skip: !ENABLED }, async () => {
  // --- Locations
  const hierarchy = await asAdmin('/delivery/location/hierarchy');
  assert.equal(hierarchy.status, 200);
  assert.ok(Array.isArray(hierarchy.body.hierarchy), 'console reads `hierarchy`');
  const types = await asAdmin('/delivery/location/types');
  assert.equal(types.status, 200);
  assert.ok(types.body.types, 'the console renders the type rules');
  const listed = await asAdmin('/delivery/location?page=1&limit=50');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.locations), 'console reads `locations`');
  state.countryId = (listed.body.locations.find((l) => l.type === 'country') || {})._id;
  assert.ok(state.countryId, 'the seeded country is present');

  const suffix = String(STAMP).slice(-6);
  const city = await asAdmin('/delivery/location', {
    method: 'POST', body: { name: `Console City ${suffix}`, type: 'city', parentId: state.countryId, code: `CC-${suffix}` },
  });
  assert.equal(city.status, 201, JSON.stringify(city.body));
  assert.ok(city.body.location, 'console reads `location`');
  state.cityId = city.body.location._id;

  const sector = await asAdmin('/delivery/location', {
    method: 'POST', body: { name: `Console Sector ${suffix}`, type: 'sector', parentId: state.cityId, code: `CS-${suffix}` },
  });
  assert.equal(sector.status, 201, JSON.stringify(sector.body));
  state.sectorId = sector.body.location._id;

  const renamed = await asAdmin(`/delivery/location/${state.sectorId}`, {
    method: 'PUT', body: { name: `Console Sector ${suffix} v2` },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const children = await asAdmin(`/delivery/location/${state.cityId}/children`);
  assert.equal(children.status, 200);
  assert.ok(Array.isArray(children.body.children), 'console reads `children`');
  const ancestors = await asAdmin(`/delivery/location/${state.sectorId}/ancestors`);
  assert.equal(ancestors.status, 200);
  assert.ok(Array.isArray(ancestors.body.ancestors), 'console reads `ancestors`');
  const search = await asAdmin(`/delivery/location/search?q=Console%20City`);
  assert.equal(search.status, 200);
  assert.equal((await asAdmin('/delivery/location/stats')).status, 200);
  assert.equal((await asAdmin(`/delivery/location/${state.sectorId}/deactivate`, { method: 'PUT' })).status, 200);
  assert.equal((await asAdmin(`/delivery/location/${state.sectorId}/activate`, { method: 'PUT' })).status, 200);
  const bulk = await asAdmin('/delivery/location/bulk', {
    method: 'POST',
    body: { rows: [{ name: `Console Bulk ${suffix}`, type: 'sector', parentName: `Console City ${suffix}` }] },
  });
  assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
  assert.equal(bulk.body.createdCount, 1, 'console reads `createdCount`');

  // --- Zones
  const zone = await asAdmin('/delivery/zone', {
    method: 'POST', body: { name: `Console Zone ${suffix}`, code: `CZ-${suffix}`, locationIds: [state.sectorId] },
  });
  assert.equal(zone.status, 201, JSON.stringify(zone.body));
  assert.ok(zone.body.zone, 'console reads `zone`');
  state.zoneId = zone.body.zone._id;

  const zoneList = await asAdmin('/delivery/zone?page=1&limit=50');
  assert.equal(zoneList.status, 200);
  assert.ok(Array.isArray(zoneList.body.zones), 'console reads `zones`');
  assert.equal((await asAdmin('/delivery/zone/stats')).status, 200);
  const coverage = await asAdmin(`/delivery/zone/coverage/${state.sectorId}`);
  assert.equal(coverage.status, 200);
  assert.equal(coverage.body.covered, true);
  assert.equal((await asAdmin(`/delivery/zone/location/${state.sectorId}`)).status, 200);
  assert.equal((await asAdmin(`/delivery/zone/${state.zoneId}`, { method: 'PUT', body: { name: `Console Zone ${suffix} v2` } })).status, 200);
  assert.equal((await asAdmin(`/delivery/zone/${state.zoneId}/locations`, { method: 'POST', body: { locationId: state.cityId } })).status, 200);
  assert.equal((await asAdmin(`/delivery/zone/${state.zoneId}/locations/${state.cityId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await asAdmin(`/delivery/zone/${state.zoneId}/deactivate`, { method: 'PUT' })).status, 200);
  assert.equal((await asAdmin(`/delivery/zone/${state.zoneId}/activate`, { method: 'PUT' })).status, 200);
  const zoneDeleted = await asAdmin(`/delivery/zone/${state.zoneId}`, { method: 'DELETE' });
  assert.equal(zoneDeleted.status, 200, JSON.stringify(zoneDeleted.body));
});


test('network workspace: hubs, routes (incl. the console search), delivery services', { skip: !ENABLED }, async () => {
  const suffix = String(STAMP).slice(-6);

  // --- Hubs
  assert.equal((await asAdmin('/delivery/hub/stats')).status, 200);
  const hub = await asAdmin('/delivery/hub', {
    method: 'POST', body: { name: `Console Hub ${suffix}`, locationId: state.cityId, capacity: 30 },
  });
  assert.equal(hub.status, 201, JSON.stringify(hub.body));
  assert.ok(hub.body.hub, 'console reads `hub`');
  state.hubId = hub.body.hub._id;
  const hubList = await asAdmin('/delivery/hub?page=1&limit=50');
  assert.equal(hubList.status, 200);
  assert.ok(Array.isArray(hubList.body.hubs), 'console reads `hubs`');
  assert.equal((await asAdmin(`/delivery/hub/${state.hubId}`)).status, 200);
  assert.equal((await asAdmin(`/delivery/hub/${state.hubId}`, { method: 'PUT', body: { capacity: 40 } })).status, 200);
  const hubStatus = await asAdmin(`/delivery/hub/${state.hubId}/status`, { method: 'PUT', body: { status: 'inactive' } });
  assert.equal(hubStatus.status, 200, JSON.stringify(hubStatus.body));

  // --- Routes: the console's "is there already a connection?" check
  const none = await asAdmin(`/delivery/route/search?originId=${state.cityId}&destinationId=${state.sectorId}`);
  assert.equal(none.status, 200, `route search must be served, not read as an id: ${JSON.stringify(none.body)}`);
  assert.equal(none.body.route, null, 'console reads `route | null`');

  const route = await asAdmin('/delivery/route', {
    method: 'POST',
    body: { name: `Console Route ${suffix}`, originLocationId: state.cityId, destinationLocationId: state.sectorId },
  });
  assert.equal(route.status, 201, JSON.stringify(route.body));
  assert.ok(route.body.route, 'console reads `route`');
  state.routeId = route.body.route._id;

  const found = await asAdmin(`/delivery/route/search?originId=${state.cityId}&destinationId=${state.sectorId}`);
  assert.equal(found.status, 200);
  assert.equal(String(found.body.route && found.body.route._id), String(state.routeId));
  assert.equal((await asAdmin('/delivery/route/search')).status, 400, 'missing parameters are refused');
  assert.equal((await asAdmin('/delivery/route/search?originId=nope&destinationId=nope')).status, 400);

  const routeList = await asAdmin('/delivery/route?page=1&limit=50');
  assert.equal(routeList.status, 200);
  assert.ok(Array.isArray(routeList.body.routes), 'console reads `routes`');
  const routeStats = await asAdmin('/delivery/route/stats');
  assert.equal(routeStats.status, 200);
  assert.equal(typeof routeStats.body.totalRoutes, 'number', 'console reads `totalRoutes`');
  assert.equal((await asAdmin(`/delivery/route/${state.routeId}`)).status, 200);
  assert.equal((await asAdmin(`/delivery/route/${state.routeId}`, { method: 'PUT', body: { distanceKm: 7 } })).status, 200);
  const routeDeleted = await asAdmin(`/delivery/route/${state.routeId}`, { method: 'DELETE' });
  assert.equal(routeDeleted.status, 200, JSON.stringify(routeDeleted.body));

  // --- Delivery service catalogue
  const service = await asAdmin('/delivery/service', {
    method: 'POST', body: { name: `Console Service ${suffix}`, code: `CSVC-${suffix}`, serviceType: 'standard', baseFee: 40 },
  });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  assert.ok(service.body.service, 'console reads `service`');
  state.serviceId = service.body.service._id;
  const serviceList = await asAdmin('/delivery/service?page=1&limit=50');
  assert.equal(serviceList.status, 200);
  assert.ok(Array.isArray(serviceList.body.services), 'console reads `services`');
  assert.equal((await asAdmin(`/delivery/service/${state.serviceId}`)).status, 200);
  assert.equal((await asAdmin(`/delivery/service/${state.serviceId}`, { method: 'PUT', body: { baseFee: 55 } })).status, 200);
  assert.equal((await asAdmin(`/delivery/service/${state.serviceId}`, { method: 'DELETE' })).status, 200);
});


test('operations, tracking and shipments workspaces', { skip: !ENABLED }, async () => {
  const dashboard = await asAdmin('/delivery/operation/dashboard');
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.ok(dashboard.body.dashboard, 'console reads `dashboard`');
  const stats = await asAdmin('/delivery/operation/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.body.stats, 'console reads `stats`');

  const tracking = await asAdmin(`/delivery/tracking/${state.deliveryId}`);
  assert.equal(tracking.status, 200);
  assert.ok(Array.isArray(tracking.body.events), 'console reads `events`');
  const latest = await asAdmin(`/delivery/tracking/${state.deliveryId}/latest`);
  assert.equal(latest.status, 200);
  const nearby = await asAdmin('/delivery/tracking/nearby?longitude=42.12&latitude=9.31&maxDistance=2000');
  assert.equal(nearby.status, 200, JSON.stringify(nearby.body));
  assert.equal((await asAdmin('/delivery/tracking/nearby?longitude=abc&latitude=9.31')).status, 400, 'bad coordinates are refused');

  const shipments = await asAdmin('/delivery/shipments?page=1&limit=50');
  assert.equal(shipments.status, 200, JSON.stringify(shipments.body));
  assert.ok(Array.isArray(shipments.body.shipments), 'console reads `shipments`');
  const candidates = await asAdmin('/delivery/shipments/consolidation/candidates');
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  assert.ok(Array.isArray(candidates.body.candidates), 'console reads `candidates`');
});

test('every console surface is closed to a buyer and to anonymous callers', { skip: !ENABLED }, async () => {
  const adminSurfaces = [
    ['GET', '/delivery/provider'],
    ['POST', '/delivery/provider', { name: 'x', phone: 'y' }],
    ['PUT', `/delivery/delivery/${state.deliveryId}/status`, { status: 'pending' }],
    ['PUT', `/delivery/delivery/${state.deliveryId}/assign`, { providerId: state.providerId }],
    ['GET', '/delivery/assignment'],
    ['POST', '/delivery/assignment', { deliveryId: state.deliveryId, providerId: state.providerId }],
    ['POST', '/delivery/dispatch/batches', { deliveryIds: [], providerId: state.providerId }],
    ['GET', '/delivery/dispatch/ready-orders'],
    ['GET', '/delivery/operation/dashboard'],
    ['GET', '/delivery/operation/stats'],
    ['GET', '/delivery/shipments'],
    ['GET', '/delivery/hub'],
    ['GET', '/delivery/route'],
    ['POST', '/delivery/route', { name: 'x', originLocationId: state.cityId, destinationLocationId: state.sectorId }],
    ['GET', '/delivery/service'],
    ['POST', '/delivery/service', { name: 'x', code: `X-${Date.now()}` }],
    ['GET', '/delivery/zone'],
    ['POST', '/delivery/zone', { name: 'x', code: `Z-${Date.now()}` }],
    ['POST', '/delivery/location', { name: 'x', type: 'city', parentId: state.countryId }],
    ['GET', '/provider-application'],
    ['POST', '/delivery/tracking', { deliveryId: state.deliveryId }],
  ];

  for (const [method, path, body] of adminSurfaces) {
    const asBuyer = await call(`/api${path}`, { method, body, token: state.buyer });
    assert.ok([401, 403].includes(asBuyer.status), `BUYER must not ${method} ${path} (got ${asBuyer.status})`);
    const anonymous = await call(`/api${path}`, { method, body });
    assert.ok([401, 403].includes(anonymous.status), `anonymous must not ${method} ${path} (got ${anonymous.status})`);
  }

  // A buyer may READ deliveries — their own — and nothing else.
  const ownList = await call('/api/delivery/delivery?page=1&limit=50', { token: state.buyer });
  assert.equal(ownList.status, 200, 'a buyer is allowed to list their own deliveries');
  const leaked = (ownList.body.deliveries || []).filter((d) => d.orderId === state.orderId);
  assert.equal(leaked.length, 0, 'the buyer never sees the console\'s own orders');
  const anonymousList = await call('/api/delivery/delivery?page=1&limit=50');
  assert.equal(anonymousList.status, 401, 'and an anonymous caller gets nothing');
});

