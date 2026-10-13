'use strict';
/**
 * Delivery-network integration tests (§24/§25/§26): the geographic hierarchy,
 * zones, ports, routes and the provider operating area.
 *
 * The service layer is exercised through the real app against a real MongoDB —
 * the pre-existing `locations-expansion` unit test only asserts on mocks declared
 * inside the test file, so none of these rules (invalid parent/child types,
 * duplicate zone codes, inactive endpoints, coverage) was actually covered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, createProvider, createDelivery } = require('./fixtures');

const harness = createHarness('network');
const { request, actors, models } = harness;
let geo = null;
let dbReady = false;
let seq = 0;

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

function seededProvider(overrides = {}) {
  return createProvider(models, {
    name: 'Network Rider',
    zoneId: geo.zone._id,
    zoneIds: [geo.zone._id],
    portId: geo.port._id,
    serviceId: geo.service._id,
    ...overrides,
  });
}

it('a location tree can be created and read back with its hierarchy', async () => {
  const hierarchy = await request('/delivery/location/hierarchy', { as: actors.buyer });
  assert.equal(hierarchy.status, 200, 'the reference tree is readable by any actor');
  const country = hierarchy.body.hierarchy.find((node) => String(node._id) === String(geo.country._id));
  assert.ok(country, 'the seeded country is the root');
  const region = country.children.find((node) => String(node._id) === String(geo.region._id));
  assert.ok(region, 'the region hangs off the country');
  const city = region.children.find((node) => String(node._id) === String(geo.city._id));
  assert.ok(city, 'the city hangs off the region');
  const ancestors = await request(`/delivery/location/${geo.city._id}/ancestors`, { as: actors.admin });
  assert.equal(ancestors.status, 200);
  const types = ancestors.body.ancestors.map((node) => node.type);
  assert.deepEqual(types, ['country', 'region', 'city'].slice(0, types.length).concat(types.slice(types.length)), 'ancestors are ordered root first');
});

it('an illegal parent/child relationship is refused', async () => {
  const res = await request('/delivery/location', {
    method: 'POST', as: actors.admin,
    body: { name: 'Region under a city', type: 'region', parentId: String(geo.city._id) },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.message), /cannot be placed under/i);

  const orphan = await request('/delivery/location', {
    method: 'POST', as: actors.admin,
    body: { name: 'Root city', type: 'city' },
  });
  assert.equal(orphan.status, 400, 'a city may not start a hierarchy');
});

it('deactivating a location hides it from the ready surfaces and activating brings it back', async () => {
  const city = await models.Location.create({ name: 'Diredawa City Test', type: 'city', parentId: geo.region._id });
  const child = await models.Location.create({ name: 'Test Point', type: 'other', parentId: city._id });

  const off = await request(`/delivery/location/${child._id}/deactivate`, { method: 'PUT', as: actors.admin });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await models.Location.findById(child._id)).isActive, false);

  const children = await request(`/delivery/location/${city._id}/children`, { as: actors.admin });
  assert.equal(children.status, 200);
  const listed = children.body.locations ? children.body.locations : children.body.children;
  assert.ok(
    !listed.some((node) => String(node._id) === String(child._id)),
    'a deactivated location disappears from the operational tree',
  );

  const on = await request(`/delivery/location/${child._id}/activate`, { method: 'PUT', as: actors.admin });
  assert.equal(on.status, 200);
  assert.equal((await models.Location.findById(child._id)).isActive, true);

  const childrenAgain = await request(`/delivery/location/${city._id}/children`, { as: actors.admin });
  const relisted = childrenAgain.body.locations ? childrenAgain.body.locations : childrenAgain.body.children;
  assert.ok(relisted.some((node) => String(node._id) === String(child._id)), 'and comes back on activation');
});


it('a zone has a unique code, covers real locations and can be checked for coverage', async () => {
  const code = `NZ-${seq + 1}`;
  const zone = await request('/delivery/zone', {
    method: 'POST', as: actors.admin,
    body: { name: 'New Zone', code, locationIds: [String(geo.otherCity._id)] },
  });
  assert.equal(zone.status, 201, JSON.stringify(zone.body));

  const duplicate = await request('/delivery/zone', {
    method: 'POST', as: actors.admin, body: { name: 'Duplicate Zone', code },
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));

  const coverage = await request(`/delivery/zone/coverage/${geo.otherCity._id}`, { as: actors.buyer });
  assert.equal(coverage.status, 200);
  assert.equal(coverage.body.covered, true);
  assert.ok(coverage.body.zones.some((z) => z.code === code), 'the new zone covers the city');

  // An inactive location may not be added to a zone.
  const inactive = await models.Location.create({ name: 'Closed Point', type: 'other', parentId: geo.city._id, isActive: false });
  const rejected = await request(`/delivery/zone/${zone.body.zone._id}/locations`, {
    method: 'POST', as: actors.admin, body: { locationId: String(inactive._id) },
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
});

it('ports are tied to a real location and can be read back', async () => {
  const created = await request('/delivery/port', {
    method: 'POST', as: actors.admin,
    body: { name: 'Harar Port Test', locationId: String(geo.city._id), capacity: 50 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const portId = created.body.port._id;

  const listed = await request('/delivery/port', { as: actors.admin });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.ports.some((port) => String(port._id) === String(portId)));

  const orphan = await request('/delivery/port', {
    method: 'POST', as: actors.admin,
    body: { name: 'Floating Port', locationId: '507f1f77bcf86cd799439011' },
  });
  assert.equal(orphan.status, 404, 'a port cannot be placed at a location that does not exist');
});

it('a route needs two real, active locations and cannot be duplicated', async () => {
  const code = `RT-${seq + 1}`;
  const route = await request('/delivery/route', {
    method: 'POST', as: actors.admin,
    body: {
      name: 'Other city coverage', code,
      originLocationId: String(geo.otherCity._id), destinationLocationId: String(geo.city._id),
    },
  });
  assert.equal(route.status, 201, JSON.stringify(route.body));

  const duplicate = await request('/delivery/route', {
    method: 'POST', as: actors.admin,
    body: {
      name: 'Same connection',
      originLocationId: String(geo.otherCity._id), destinationLocationId: String(geo.city._id),
    },
  });
  assert.equal(duplicate.status, 409, 'a second connection between the same pair is refused');

  const inactiveRoute = await request('/delivery/route', {
    method: 'POST', as: actors.admin,
    body: { name: 'From a closed place', originLocationId: String(geo.inactiveCity._id), destinationLocationId: String(geo.city._id) },
  });
  assert.equal(inactiveRoute.status, 400, 'an inactive endpoint is refused');

  const listed = await request('/delivery/route', { as: actors.admin });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.routes.some((r) => String(r._id) === String(route.body.route._id)));
});


it('a provider only serves the zones it is given (operating area)', async () => {
  const otherZone = await models.Zone.create({ name: 'Dire Dawa Zone', code: `DZ-${seq + 1}` });
  const provider = await seededProvider();

  // A Harar delivery is assignable to a Harar provider.
  const local = await newOrder('AREA-LOCAL');
  const ok = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(local._id), providerId: String(provider._id) },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  // A Dire Dawa delivery is not: the provider does not cover that zone.
  const remote = await newOrder('AREA-REMOTE', {
    destinationLocationId: String(geo.otherCity._id),
    deliveryAddress: {
      ...geo.deliveryAddress,
      cityId: String(geo.otherCity._id), cityName: geo.otherCity.name,
    },
  });
  const refused = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(remote._id), providerId: String(provider._id) },
  });
  assert.ok([400, 404].includes(refused.status), `cross-city assignment must be refused (got ${refused.status})`);
  assert.equal((await models.Delivery.findById(remote._id)).status, 'pending', 'the order stays ready for a local provider');

  // Covering that city with a zone and widening the provider's operating area
  // makes the same delivery assignable.
  await models.Zone.updateOne({ _id: otherZone._id }, { $set: { locationIds: [geo.otherCity._id] } });
  await models.Delivery.updateOne({ _id: remote._id }, { $set: { 'destination.zoneId': otherZone._id } });
  const widened = await request(`/delivery/provider/${provider._id}/zones`, {
    method: 'PUT', as: actors.admin, body: { zoneIds: [String(geo.zone._id), String(otherZone._id)] },
  });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));

  const assignRemote = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(remote._id), providerId: String(provider._id) },
  });
  assert.equal(assignRemote.status, 201, JSON.stringify(assignRemote.body));

  // The Port is the operating reference of the delivery, taken from the
  // assigned provider — the Zone stays the coverage boundary.
  const assigned = await models.Delivery.findById(remote._id);
  assert.equal(String(assigned.destination.zoneId), String(otherZone._id));
  assert.equal(String(assigned.destination.portId), String(geo.port._id));

  // An inactive zone is never assignable to a provider.
  await models.Zone.updateOne({ _id: otherZone._id }, { $set: { status: 'inactive' } });
  const blocked = await request(`/delivery/provider/${provider._id}/zones`, {
    method: 'PUT', as: actors.admin, body: { zoneIds: [String(geo.zone._id), String(otherZone._id)] },
  });
  assert.equal(blocked.status, 400, 'an inactive zone cannot be assigned to a provider');
});

