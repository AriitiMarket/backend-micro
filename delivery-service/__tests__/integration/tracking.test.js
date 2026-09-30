'use strict';
/**
 * Tracking integration tests (§17/§18).
 *
 * Tracking is provider work scoped to the assigned provider, and it is HISTORY:
 * every event is appended, the newest is addressable separately, and a closed
 * delivery accepts nothing more.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, createProvider, createDelivery } = require('./fixtures');

const harness = createHarness('tracking');
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
    identityUserId: `user-track-${providerSeq}`,
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

/** Assign a delivery to a provider so tracking ownership can be exercised. */
async function assignedOrder(provider, prefix) {
  const order = await newOrder(prefix);
  const res = await request(`/delivery/delivery/${order._id}/assign`, {
    method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return order;
}


it('the assigned provider appends tracking events and history is never overwritten', async () => {
  const provider = await seededProvider();
  const order = await assignedOrder(provider, 'TRACK');
  const rider = providerActor(provider);

  const points = [
    { location: { type: 'Point', coordinates: [42.12, 9.31] }, note: 'left the shop' },
    { location: { type: 'Point', coordinates: [42.13, 9.32] }, note: 'on the main road' },
    { location: { type: 'Point', coordinates: [42.14, 9.33] }, note: 'arriving' },
  ];
  for (const point of points) {
    const res = await request('/delivery/tracking', {
      method: 'POST', as: rider, body: { deliveryId: String(order._id), ...point },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  const history = await request(`/delivery/tracking/${order._id}`, { as: actors.admin });
  assert.equal(history.status, 200);
  // 3 explicit updates + the `assigned` event recorded by the state machine.
  assert.equal(history.body.count, points.length + 1, 'every update is kept, not just the last one');
  const notes = history.body.events.map((e) => e.note);
  assert.deepEqual(notes.slice(-points.length), points.map((p) => p.note), 'the sequence is preserved in order');

  const latest = await request(`/delivery/tracking/${order._id}/latest`, { as: actors.admin });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.location.note, 'arriving', 'the latest position is addressable on its own');
  assert.deepEqual(latest.body.location.location.coordinates, [42.14, 9.33]);

  const stored = await models.TrackingEvent.find({ deliveryId: order._id, note: { $in: points.map((p) => p.note) } });
  assert.equal(stored.length, points.length);
  assert.ok(stored.every((e) => String(e.providerId) === String(provider._id)), 'the provider is derived from the authenticated context');
});

it('a provider may only update tracking for its own assigned delivery', async () => {
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });
  const order = await assignedOrder(providerA, 'TRACK-OWN');

  const intruder = await request('/delivery/tracking', {
    method: 'POST', as: providerActor(providerB),
    body: { deliveryId: String(order._id), note: 'I am not the assigned provider' },
  });
  assert.equal(intruder.status, 403, 'cross-provider tracking is refused');

  // A forged providerId in the body cannot attribute the event to someone else.
  const forged = await request('/delivery/tracking', {
    method: 'POST', as: providerActor(providerA),
    body: { deliveryId: String(order._id), providerId: String(providerB._id), note: 'legit update' },
  });
  assert.equal(forged.status, 200);
  assert.equal(String(forged.body.event.providerId), String(providerA._id), 'the identity wins over the payload');
});

it('buyers and sellers cannot write tracking', async () => {
  const provider = await seededProvider();
  const order = await assignedOrder(provider, 'TRACK-ROLE');

  for (const actor of [actors.buyer, actors.seller]) {
    const res = await request('/delivery/tracking', {
      method: 'POST', as: actor, body: { deliveryId: String(order._id), note: 'nope' },
    });
    assert.equal(res.status, 403, `${actor.role} must not record tracking`);
  }
});

it('invalid coordinates, timestamps and statuses are refused', async () => {
  const provider = await seededProvider();
  const order = await assignedOrder(provider, 'TRACK-VALID');
  const rider = providerActor(provider);

  const cases = [
    { name: 'out-of-range latitude', body: { location: { type: 'Point', coordinates: [42.1, 120] } } },
    { name: 'out-of-range longitude', body: { location: { type: 'Point', coordinates: [250, 9.3] } } },
    { name: 'malformed coordinates', body: { location: { coordinates: ['x', 'y'] } } },
    { name: 'non-Point geometry', body: { location: { type: 'Polygon', coordinates: [42.1, 9.3] } } },
    { name: 'invalid timestamp', body: { timestamp: 'yesterday' } },
    { name: 'unknown status', body: { status: 'teleporting' } },
  ];
  for (const { name, body } of cases) {
    const res = await request('/delivery/tracking', {
      method: 'POST', as: rider, body: { deliveryId: String(order._id), ...body },
    });
    assert.equal(res.status, 400, `${name} must be a 400 (got ${res.status})`);
  }

  const missingId = await request('/delivery/tracking', { method: 'POST', as: rider, body: { note: 'x' } });
  assert.equal(missingId.status, 400);

  const badId = await request('/delivery/tracking', { method: 'POST', as: rider, body: { deliveryId: 'not-an-id' } });
  assert.equal(badId.status, 400);

  const unknownDelivery = await request('/delivery/tracking', {
    method: 'POST', as: rider, body: { deliveryId: '507f1f77bcf86cd799439011' },
  });
  assert.equal(unknownDelivery.status, 404);

  assert.equal(await models.TrackingEvent.countDocuments({ deliveryId: order._id }), 1, 'only the assignment event exists');
});

it('every lifecycle status can be stored in tracking history', async () => {
  const provider = await seededProvider();
  const order = await assignedOrder(provider, 'TRACK-STATUS');
  const rider = providerActor(provider);

  // These are the statuses the history enum used to reject, which silently
  // dropped the event from the delivery timeline.
  for (const status of ['ready_for_pickup', 'arrived_at_hub', 'out_for_delivery']) {
    const res = await request('/delivery/tracking', {
      method: 'POST', as: rider, body: { deliveryId: String(order._id), status },
    });
    assert.equal(res.status, 200, `${status} must be storable (${JSON.stringify(res.body)})`);
    assert.equal(res.body.event.status, status);
  }
});

it('a closed delivery accepts no further tracking', async () => {
  const provider = await seededProvider();
  const order = await assignedOrder(provider, 'TRACK-CLOSED');
  const rider = providerActor(provider);

  await request(`/delivery/delivery/${order._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'pickup' } });
  await request(`/delivery/delivery/${order._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'in_transit' } });
  await request(`/delivery/delivery/${order._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'delivered' } });

  const after = await request('/delivery/tracking', {
    method: 'POST', as: rider, body: { deliveryId: String(order._id), note: 'too late' },
  });
  assert.equal(after.status, 409);
  assert.equal(after.body.code, 'TRACKING_CLOSED');
});
