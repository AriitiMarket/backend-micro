'use strict';
/**
 * Seed data integration tests (§37).
 *
 * The Ethiopian location hierarchy, zones, hubs, routes and providers must be
 * safe to seed repeatedly: the first run creates them, every later run finds
 * them, and nothing that is not part of the seed is ever deleted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');

const harness = createHarness('seed');
const { models } = harness;
const { seed } = require('../../src/seed/seed');

let dbReady = false;

test.before(async () => { dbReady = await harness.start(); });
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

it('the first run creates the whole delivery hierarchy', async () => {
  const summary = await seed({ connect: false });
  assert.ok(summary.created > 0, 'the first run creates records');
  assert.equal(summary.reused, 0);

  const counts = {
    locations: await models.Location.countDocuments(),
    zones: await models.Zone.countDocuments(),
    deliveryServices: await models.DeliveryService.countDocuments(),
    providers: await models.Provider.countDocuments(),
    hubs: await models.Hub.countDocuments(),
    routes: await models.DeliveryRoute.countDocuments(),
  };
  assert.ok(counts.locations >= 14, `locations seeded (${counts.locations})`);
  assert.ok(counts.zones >= 3, `zones seeded (${counts.zones})`);
  assert.ok(counts.deliveryServices >= 2);
  assert.ok(counts.providers >= 3);
  assert.ok(counts.hubs >= 2);
  assert.ok(counts.routes >= 3);
});

it('a second run creates nothing and deletes nothing', async () => {
  const before = await seed({ connect: false });
  const countsBefore = {
    locations: await models.Location.countDocuments(),
    zones: await models.Zone.countDocuments(),
    providers: await models.Provider.countDocuments(),
    hubs: await models.Hub.countDocuments(),
    routes: await models.DeliveryRoute.countDocuments(),
  };

  // Records that are NOT part of the seed (an operator's own data).
  const extraLocation = await models.Location.create({ name: 'Operator Village', type: 'village', code: 'OP-VILLAGE' });
  await models.Provider.create({ name: 'Operator Rider', phone: '+251977777777', status: 'available' });
  const deliveries = await models.Delivery.countDocuments();

  const second = await seed({ connect: false });
  assert.equal(second.created, 0, 'the second run adds nothing');
  assert.ok(second.reused >= before.created, 'every seeded record is found again');

  const countsAfter = {
    locations: await models.Location.countDocuments(),
    zones: await models.Zone.countDocuments(),
    providers: await models.Provider.countDocuments(),
    hubs: await models.Hub.countDocuments(),
    routes: await models.DeliveryRoute.countDocuments(),
  };
  // +1 location and +1 provider: the ones the operator added, nothing else.
  assert.equal(countsAfter.locations, countsBefore.locations + 1);
  assert.equal(countsAfter.providers, countsBefore.providers + 1);
  assert.equal(countsAfter.zones, countsBefore.zones);
  assert.equal(countsAfter.hubs, countsBefore.hubs);
  assert.equal(countsAfter.routes, countsBefore.routes);
  assert.equal(await models.Delivery.countDocuments(), deliveries, 'deliveries are untouched by a re-seed');

  assert.ok(await models.Location.findById(extraLocation._id), 'the operator data survived');
  assert.equal(await models.Location.countDocuments({ code: 'HAR' }), 1, 'no duplicate location was created');
});

it('the seeded hierarchy is internally consistent', async () => {
  const conflicts = await models.Location.find({ type: 'sector' });
  assert.ok(conflicts.length >= 2);
  for (const sector of conflicts) {
    assert.ok(sector.parentId, `sector ${sector.name} has a parent`);
    const parent = await models.Location.findById(sector.parentId);
    assert.ok(parent, `sector ${sector.name} references an existing parent`);
    assert.ok(['city', 'town', 'area', 'region'].includes(parent.type), `sector ${sector.name} hangs off a ${parent.type}`);
  }

  const zones = await models.Zone.find({});
  for (const zone of zones) {
    assert.ok(zone.code, `zone ${zone.name} has a code`);
    for (const locationId of zone.locationIds) {
      assert.ok(await models.Location.findById(locationId), `zone ${zone.name} references existing locations`);
    }
  }

  const routes = await models.DeliveryRoute.find({});
  for (const route of routes) {
    assert.ok(await models.Location.findById(route.originLocationId), `route ${route.name} has a real origin`);
    assert.ok(await models.Location.findById(route.destinationLocationId), `route ${route.name} has a real destination`);
  }

  const hubs = await models.Hub.find({});
  for (const hub of hubs) {
    assert.ok(await models.Location.findById(hub.locationId), `hub ${hub.name} sits at a real location`);
  }

  const providers = await models.Provider.find({ email: { $in: ['ahmed@aritii.et', 'fatima@aritii.et', 'omar@aritii.et'] } });
  assert.equal(providers.length, 3, 'the three seeded providers exist exactly once');
  for (const provider of providers) {
    assert.equal(provider.status, 'available');
    assert.ok(provider.zoneIds.length > 0, `${provider.name} has an operating area`);
  }
});

it('two routes can exist without a code (unique + sparse index regression)', async () => {
  // `code` is unique + sparse: an unset code must be stored ABSENT. With a null
  // default the second code-less route died with `E11000 ... code_1`, so the
  // admin could only ever create one route without a code.
  const origin = await models.Location.findOne({ code: 'HAR' });
  const destination = await models.Location.findOne({ code: 'HAR-SH' });
  const first = await models.DeliveryRoute.create({ name: 'No code A', originLocationId: origin._id, destinationLocationId: destination._id });
  const second = await models.DeliveryRoute.create({ name: 'No code B', originLocationId: destination._id, destinationLocationId: origin._id });
  assert.ok(first._id && second._id);
  assert.equal(first.code, undefined);
  assert.equal(second.code, undefined);
  // A literal `null` code must not be persisted (a missing field is what the
  // sparse index skips); `{ code: null }` would also match missing fields.
  assert.equal(await models.DeliveryRoute.countDocuments({ code: { $type: 'null' } }), 0, 'no null code is persisted');
});

