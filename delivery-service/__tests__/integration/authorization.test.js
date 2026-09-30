'use strict';
/**
 * Authorization / isolation integration tests (§27-§30, §35).
 *
 * The permission matrix from the specification is asserted against the running
 * service: what a BUYER, SELLER, DELIVERY_PROVIDER and ADMIN may each do, that
 * one tenant can never read another's delivery, and that a buyer never receives
 * provider-private or internal operational fields.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, createProvider, createDelivery } = require('./fixtures');

const harness = createHarness('authz');
const { request, actors, models } = harness;
let geo = null;
let dbReady = false;
let seq = 0;
let providerSeq = 0;

test.before(async () => {
  dbReady = await harness.start();
  if (dbReady) geo = await seedGeography(harness.models);
});

test.after(async () => { await harness.stop(); });

function it(name, fn) {
  test(name, async (t) => {
    if (!dbReady) {
      t.skip('MongoDB is not reachable (set ARITII_TEST_MONGO) — integration suite skipped');
      return;
    }
    await fn(t);
  });
}

async function newOrder(prefix, overrides = {}) {
  seq += 1;
  return createDelivery(harness, geo, `${prefix}-${seq}`, overrides);
}

async function seededProvider(overrides = {}) {
  providerSeq += 1;
  return createProvider(models, {
    name: 'Provider One',
    identityUserId: `user-authz-${providerSeq}`,
    zoneId: geo.zone._id,
    zoneIds: [geo.zone._id],
    sectorId: geo.sector._id,
    serviceId: geo.service._id,
    ...overrides,
  });
}

function providerActor(provider) {
  return { id: provider.identityUserId, role: 'PROVIDER', capabilities: ['PROVIDER'] };
}

/** An order owned by the harness buyer and seller actors, assigned to a provider. */
async function ownedAssignedOrder(provider) {
  const order = await newOrder('AZ', { buyerId: actors.buyer.id, sellerId: actors.seller.id });
  const res = await request(`/delivery/delivery/${order._id}/assign`, {
    method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return order;
}

it('the permission matrix: admin-only surfaces reject every other actor', async () => {
  const delivery = await newOrder('AZ-ADMIN');
  const provider = await seededProvider();

  const adminOnly = [
    { method: 'GET', path: '/delivery/provider', name: 'provider roster' },
    { method: 'GET', path: '/delivery/provider/available', name: 'dispatch-eligible providers' },
    { method: 'POST', path: '/delivery/provider', name: 'provider creation', body: { name: 'x', phone: 'y' } },
    { method: 'PUT', path: `/delivery/provider/${provider._id}`, name: 'provider update', body: { name: 'x' } },
    { method: 'POST', path: `/delivery/provider/${provider._id}/approve`, name: 'provider approval', body: {} },
    { method: 'POST', path: `/delivery/provider/${provider._id}/reject`, name: 'provider rejection', body: { reason: 'x' } },
    { method: 'PUT', path: `/delivery/provider/${provider._id}/status`, name: 'provider suspension', body: { status: 'suspended' } },
    { method: 'GET', path: '/delivery/location/hierarchy', name: 'location hierarchy', sharedRead: true },
    { method: 'POST', path: '/delivery/location', name: 'location creation', body: { name: 'x', type: 'city' } },
    { method: 'PUT', path: '/delivery/location/507f1f77bcf86cd799439011', name: 'location update', body: { name: 'x' } },
    { method: 'GET', path: '/delivery/zone', name: 'zone list' },
    { method: 'POST', path: '/delivery/zone', name: 'zone creation', body: { name: 'x', code: 'y' } },
    { method: 'GET', path: '/delivery/hub', name: 'hub list' },
    { method: 'POST', path: '/delivery/hub', name: 'hub creation', body: { name: 'x', locationId: String(geo.city._id) } },
    { method: 'GET', path: '/delivery/route', name: 'route list' },
    { method: 'POST', path: '/delivery/route', name: 'route creation', body: {} },
    { method: 'GET', path: '/delivery/service', name: 'delivery service catalogue' },
    { method: 'GET', path: '/delivery/operation/stats', name: 'operations stats' },
    { method: 'GET', path: '/delivery/dispatch/ready-orders', name: 'ready-orders queue' },
    { method: 'GET', path: '/delivery/dispatch/batches', name: 'dispatch batches' },
    { method: 'GET', path: '/delivery/shipments', name: 'shipments' },
    { method: 'GET', path: '/provider-application', name: 'provider applications queue' },
    { method: 'POST', path: '/delivery/assignment', name: 'provider assignment', body: { deliveryId: String(delivery._id), providerId: String(provider._id) } },
    { method: 'PUT', path: `/delivery/delivery/${delivery._id}/status`, name: 'status change', body: { status: 'pickup' } },
    { method: 'PUT', path: `/delivery/delivery/${delivery._id}/assign`, name: 'assignment', body: { providerId: String(provider._id) } },
  ];

  for (const actor of [actors.buyer, actors.seller, actors.provider]) {
    for (const route of adminOnly) {
      const res = await request(route.path, { method: route.method, as: actor, body: route.body });
      if (route.sharedRead && route.method === 'GET') {
        // Reference data every actor needs to pick an address with.
        assert.equal(res.status, 200, `${actor.role} must be able to read ${route.name}`);
        continue;
      }
      assert.ok(
        [401, 403, 404].includes(res.status),
        `${actor.role} must not ${route.method} ${route.path} (${route.name}) — got ${res.status}`,
      );
      assert.notEqual(res.body && res.body.success, true, `${route.name} must not succeed for ${actor.role}`);
    }
  }

  // ...and the administrator is not blocked by authorization on them.
  // (502 = the Identity Service is unreachable from this bare-metal test
  // environment while provisioning the PROVIDER role; it is a dependency
  // response, never an authorization one, and it is what the controller is
  // supposed to return in that case.)
  for (const route of adminOnly.slice(0, 6)) {
    const res = await request(route.path, { method: route.method, as: actors.admin, body: route.body });
    assert.ok(
      [200, 201, 502].includes(res.status),
      `ADMIN must be able to ${route.method} ${route.path} (got ${res.status})`,
    );
    assert.notEqual(res.status, 401, 'ADMIN must never be told it is unauthenticated');
    assert.notEqual(res.status, 403, 'ADMIN must never be told it lacks the permission');
  }
});

it('a provider can only act on its own work', async () => {
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });
  const order = await ownedAssignedOrder(providerA);

  const assignment = await models.Assignment.findOne({ deliveryId: order._id, status: 'pending' });

  const cases = [
    { name: 'accept', path: `/delivery/assignment/${assignment._id}/respond`, method: 'POST', body: { accepted: true } },
    { name: 'read the assignment', path: `/delivery/assignment/${assignment._id}`, method: 'GET' },
    { name: 'change the status', path: `/delivery/delivery/${order._id}/status`, method: 'PUT', body: { status: 'pickup' } },
    { name: 'track', path: '/delivery/tracking', method: 'POST', body: { deliveryId: String(order._id) } },
  ];
  for (const c of cases) {
    const res = await request(c.path, { method: c.method, as: providerActor(providerB), body: c.body });
    assert.ok(
      [403, 404].includes(res.status),
      `provider B must not ${c.name} provider A's work (got ${res.status})`,
    );
  }

  // The owner is allowed exactly where the matrix says so.
  const own = await request(`/delivery/assignment/${assignment._id}`, { method: 'GET', as: providerActor(providerA) });
  assert.equal(own.status, 200);
  const accept = await request(`/delivery/assignment/${assignment._id}/respond`, {
    method: 'POST', as: providerActor(providerA), body: { accepted: true },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
});

it('a provider reads its own record through /provider/me (the portal cannot know its id)', async () => {
  const provider = await seededProvider();
  const actor = providerActor(provider);

  const mine = await request('/delivery/provider/me', { as: actor });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(String(mine.body.provider._id), String(provider._id), 'the caller gets exactly its own record');
  assert.equal(mine.body.provider.identityUserId, provider.identityUserId);

  // Nobody else's record, and no record at all for an account that never applied.
  const other = await seededProvider({ name: 'Other Rider' });
  const otherMine = await request(`/delivery/provider/${other._id}`, { as: actor });
  assert.equal(otherMine.status, 403, 'a provider cannot read another provider through the roster');

  const none = await request('/delivery/provider/me', { as: actors.providerNoProfile });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, 'NOT_FOUND');

  // A buyer is not a provider at all.
  const asBuyer = await request('/delivery/provider/me', { as: actors.buyer });
  assert.equal(asBuyer.status, 403);

  // The availability toggle works with the id the portal just learned.
  const online = await request(`/delivery/provider/${provider._id}/online`, { method: 'PUT', as: actor, body: { isOnline: true } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.provider.status, 'available');
  const asAdmin = await request('/delivery/provider/me', { as: actors.admin });
  assert.equal(asAdmin.status, 404, 'an admin with no provider record is told so, not served another one');
});

it('a provider cannot flip another provider online or offline', async () => {
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });

  const res = await request(`/delivery/provider/${providerB._id}/online`, {
    method: 'PUT', as: providerActor(providerA), body: { isOnline: false },
  });
  assert.equal(res.status, 403);
  assert.equal((await models.Provider.findById(providerB._id)).availability.isOnline, true, 'the other provider is untouched');
});


it('a buyer sees only their own delivery, and only the buyer-facing fields', async () => {
  const provider = await seededProvider();
  const mine = await ownedAssignedOrder(provider);
  seq += 1;
  const foreign = await createDelivery(harness, geo, `AZ-FOREIGN-${seq}`, {
    buyerId: 'someone-else', sellerId: 'other-seller',
  });

  const own = await request(`/delivery/delivery/${mine._id}`, { as: actors.buyer });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.delivery.status, 'assigned');

  const foreignRead = await request(`/delivery/delivery/${foreign._id}`, { as: actors.buyer });
  assert.equal(foreignRead.status, 403, 'another buyer\'s delivery must not be readable');

  const list = await request('/delivery/delivery?limit=200', { as: actors.buyer });
  assert.equal(list.status, 200);
  const ids = list.body.deliveries.map((d) => String(d._id));
  assert.ok(ids.includes(String(mine._id)), 'the buyer sees their own delivery');
  assert.ok(!ids.includes(String(foreign._id)), 'and never another buyer\'s');

  // Private provider data and internal operational data never reach a buyer.
  const detail = own.body.delivery;
  assert.ok(detail.provider, 'the buyer sees who is delivering');
  assert.equal(detail.provider.name, provider.name);
  for (const secret of ['phone', 'email', 'identityUserId', 'availability', 'currentWorkloadIds', 'maxActiveAssignments']) {
    assert.equal(detail.provider[secret], undefined, `provider.${secret} must not be exposed to a buyer`);
  }
  assert.equal(detail.assignmentHistory, undefined, 'assignment offers and their notes stay internal');
  assert.equal(detail.metadata, undefined, 'internal metadata stays internal');
  assert.ok(!detail.failureReason, 'internal failure reasons stay internal');
});

it('a seller sees only their own order\'s delivery', async () => {
  const provider = await seededProvider();
  const mine = await ownedAssignedOrder(provider);
  seq += 1;
  const foreign = await createDelivery(harness, geo, `AZ-SELLER-${seq}`, {
    sellerId: 'another-seller', buyerId: 'another-buyer',
  });

  const own = await request(`/delivery/delivery/${mine._id}`, { as: actors.seller });
  assert.equal(own.status, 200);
  assert.equal(own.body.delivery.provider.phone, undefined, 'provider contact details stay internal');

  const foreignRead = await request(`/delivery/delivery/${foreign._id}`, { as: actors.seller });
  assert.equal(foreignRead.status, 403);

  const list = await request('/delivery/delivery?limit=200', { as: actors.seller });
  const ids = list.body.deliveries.map((d) => String(d._id));
  assert.ok(ids.includes(String(mine._id)));
  assert.ok(!ids.includes(String(foreign._id)));
});

it('a provider sees only deliveries assigned to it', async () => {
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });
  const mine = await ownedAssignedOrder(providerA);
  seq += 1;
  const theirs = await createDelivery(harness, geo, `AZ-PROV-${seq}`, {});
  await request(`/delivery/delivery/${theirs._id}/assign`, {
    method: 'PUT', as: actors.admin, body: { providerId: String(providerB._id) },
  });

  const own = await request(`/delivery/delivery/${mine._id}`, { as: providerActor(providerA) });
  assert.equal(own.status, 200);

  const foreign = await request(`/delivery/delivery/${theirs._id}`, { as: providerActor(providerA) });
  assert.ok([403, 404].includes(foreign.status), 'another provider\'s delivery is not readable');

  const list = await request('/delivery/delivery?limit=200', { as: providerActor(providerA) });
  const ids = list.body.deliveries.map((d) => String(d._id));
  assert.ok(ids.includes(String(mine._id)));
  assert.ok(!ids.includes(String(theirs._id)));
});


it('the operations dashboard is scoped and role-gated', async () => {
  const sellerDashboard = await request('/delivery/operation/dashboard', { as: actors.seller });
  assert.equal(sellerDashboard.status, 200, 'a seller may see their own operation');
  const buyerDashboard = await request('/delivery/operation/dashboard', { as: actors.buyer });
  assert.equal(buyerDashboard.status, 403);
  const adminDashboard = await request('/delivery/operation/dashboard', { as: actors.admin });
  assert.equal(adminDashboard.status, 200);
  assert.ok(adminDashboard.body.dashboard, 'the admin gets the operational overview');
});

it('mass assignment and unknown identifiers are refused without leaking internals', async () => {
  const provider = await seededProvider();

  // Fields that are not part of the roster contract cannot be patched in.
  for (const body of [{ status: 'suspended' }, { activeDeliveries: 0 }, { identityUserId: 'someone-else' }, { currentWorkloadIds: [] }]) {
    const res = await request(`/delivery/provider/${provider._id}`, { method: 'PUT', as: actors.admin, body });
    assert.equal(res.status, 400, `patching ${JSON.stringify(body)} must be refused`);
    assert.equal(res.body.code, 'UNSUPPORTED_FIELD');
  }
  const after = await models.Provider.findById(provider._id);
  assert.equal(after.status, 'available');
  assert.equal(after.activeDeliveries, 0);
  assert.equal(after.identityUserId, provider.identityUserId);

  const malformed = await request('/delivery/delivery/not-an-object-id', { as: actors.admin });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'INVALID_ID');
  assert.equal(malformed.body.success, false);

  const unknown = await request('/delivery/delivery/507f1f77bcf86cd799439011', { as: actors.admin });
  assert.equal(unknown.status, 404);

  const listMalformed = await request('/delivery/delivery?providerId=not-an-id', { as: actors.admin });
  assert.ok([200, 400].includes(listMalformed.status), 'a malformed filter must not crash the service');
});

it('responses are consistently shaped and never leak internals', async () => {
  const cases = [
    { name: 'validation', res: await request('/delivery/delivery?status=teleported', { as: actors.admin }) },
    { name: 'unauthorized', res: await request('/delivery/delivery') },
    { name: 'forbidden', res: await request('/delivery/provider', { as: actors.buyer }) },
    { name: 'not found', res: await request('/delivery/delivery/507f1f77bcf86cd799439011', { as: actors.admin }) },
    { name: 'invalid id', res: await request('/delivery/delivery/not-an-object-id', { as: actors.admin }) },
    { name: 'unrouted', res: await request('/delivery/nope', { as: actors.admin }) },
    { name: 'invalid transition', res: await request('/delivery/delivery/not-an-id/status', { method: 'PUT', as: actors.admin, body: { status: 'delivered' } }) },
  ];
  for (const { name, res } of cases) {
    assert.equal(res.body.success, false, `${name}: success must be false`);
    assert.equal(typeof res.body.message, 'string', `${name}: message must be present`);
    assert.ok(Array.isArray(res.body.errors), `${name}: errors must be an array`);
    const raw = JSON.stringify(res.body);
    for (const leak of ['at Object.', 'node_modules', 'MongoServerError', 'E11000', '/home/', 'stack']) {
      assert.ok(!raw.includes(leak), `${name}: the body must not leak "${leak}" (${raw.slice(0, 160)})`);
    }
  }
  assert.equal(cases[1].res.status, 401, 'a missing identity is a 401');
  assert.equal(cases[2].res.status, 403, 'a missing role is a 403');
  assert.equal(cases[5].res.status, 404, 'an unrouted path is a 404');
});

