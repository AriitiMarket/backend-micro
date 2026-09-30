'use strict';
/**
 * Delivery lifecycle + assignment integration tests.
 *
 * The whole path runs over HTTP against a real MongoDB: handoff, assignment,
 * provider acceptance, the status machine, capacity, concurrency, failure and
 * reassignment. Authorization comes from the same identity headers the gateway
 * injects, so these assertions cover what a real caller can actually do.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, createProvider, createDelivery, handoff, handoffPayload } = require('./fixtures');

const harness = createHarness('lifecycle');
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

/** A provider aligned with the seeded zone, linked to its own identity account. */
async function seededProvider(overrides = {}) {
  providerSeq += 1;
  return createProvider(models, {
    name: 'Provider One',
    identityUserId: `user-provider-${providerSeq}`,
    zoneId: geo.zone._id,
    zoneIds: [geo.zone._id],
    sectorId: geo.sector._id,
    serviceId: geo.service._id,
    ...overrides,
  });
}

/** The gateway actor whose identity is linked to a given provider record. */
function providerActor(provider) {
  return { id: provider.identityUserId, role: 'PROVIDER', capabilities: ['PROVIDER'] };
}

it('the full delivery lifecycle runs: assign → accept → pickup → transit → deliver', async () => {
  const delivery = await newOrder('LC');
  const provider = await seededProvider();
  const otherProvider = await seededProvider({ name: 'Provider B' });

  const assigned = await request(`/delivery/delivery/${delivery._id}/assign`, {
    method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.assignment.status, 'pending');

  let doc = await models.Delivery.findById(delivery._id);
  assert.equal(doc.status, 'assigned');
  assert.equal(String(doc.providerId), String(provider._id));
  assert.ok(doc.assignedAt, 'the milestone timestamp is stamped by the state machine');
  assert.equal(String(doc.assignmentId), String(assigned.body.assignment._id));

  // The provider (and only that provider) can accept.
  const wrong = await request(`/delivery/assignment/${assigned.body.assignment._id}/respond`, {
    method: 'POST', as: providerActor(otherProvider), body: { accepted: true },
  });
  assert.equal(wrong.status, 403, 'another provider may not accept an offer');

  const accepted = await request(`/delivery/assignment/${assigned.body.assignment._id}/respond`, {
    method: 'POST', as: providerActor(provider), body: { accepted: true },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.assignment.status, 'accepted');

  for (const [status, field] of [['pickup', 'pickedUpAt'], ['in_transit', 'inTransitAt'], ['delivered', 'deliveredAt']]) {
    const res = await request(`/delivery/delivery/${delivery._id}/status`, {
      method: 'PUT', as: actors.admin, body: { status },
    });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    doc = await models.Delivery.findById(delivery._id);
    assert.equal(doc.status, status);
    assert.ok(doc[field], `${field} is recorded`);
  }

  // Capacity is released exactly once when the delivery completes.
  const after = await models.Provider.findById(provider._id);
  assert.equal(after.activeDeliveries, 0, 'the workload counter is released');
  assert.deepEqual(after.currentWorkloadIds, [], 'no workload id is left behind');

  // The assignment is closed and history exists.
  const activeAssignments = await models.Assignment.find({ deliveryId: delivery._id, status: { $in: ['pending', 'accepted'] } });
  assert.equal(activeAssignments.length, 0, 'the assignment is closed on completion');
  const events = await models.TrackingEvent.find({ deliveryId: delivery._id }).sort({ timestamp: 1 });
  assert.ok(events.length >= 4, `history keeps every transition (${events.length} events)`);
  const statuses = new Set(events.map((e) => e.status));
  for (const status of ['assigned', 'pickup', 'in_transit', 'delivered']) {
    assert.ok(statuses.has(status), `a "${status}" event is recorded in history`);
  }
});

it('invalid status transitions are refused with 409 and leave the database unchanged', async () => {
  const cases = [
    { from: 'pending', to: 'delivered' },
    { from: 'pending', to: 'in_transit' },
    { from: 'pending', to: 'pickup' }, // never picked up without a provider
  ];
  for (const { from, to } of cases) {
    const delivery = await newOrder('TR');
    await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: from } });
    const before = await models.Delivery.findById(delivery._id);

    const res = await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: to } });
    assert.equal(res.status, 409, `${from} -> ${to} must be refused (${JSON.stringify(res.body)})`);
    assert.equal(res.body.code, 'INVALID_TRANSITION');

    const after = await models.Delivery.findById(delivery._id);
    assert.equal(after.status, from, 'the status did not move');
    assert.equal(String(after.updatedAt), String(before.updatedAt), 'nothing was written');
    assert.equal(after.deliveredAt, null);
    assert.equal(after.inTransitAt, null);
    assert.equal(after.pickedUpAt, null);
  }
});

it('a terminal delivery cannot go backwards', async () => {
  const delivery = await newOrder('TERM');
  const provider = await seededProvider({ maxActiveAssignments: 1 });
  await request(`/delivery/delivery/${delivery._id}/assign`, { method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'pickup' } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'in_transit' } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'delivered' } });

  for (const to of ['pending', 'in_transit', 'pickup', 'assigned']) {
    const res = await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: to } });
    assert.equal(res.status, 409, `delivered -> ${to} must be refused`);
  }
  const cancel = await request(`/delivery/delivery/${delivery._id}/status`, {
    method: 'PUT', as: actors.admin, body: { status: 'cancelled', reason: 'late change of mind' },
  });
  assert.equal(cancel.status, 409, 'a delivered delivery is never cancellable');
  assert.equal(cancel.body.code, 'CANCEL_NOT_ALLOWED');

  assert.equal(await models.Delivery.findById(delivery._id).then((d) => d.status), 'delivered');
});

it('the canonical uppercase status spelling is accepted and normalized', async () => {
  const delivery = await newOrder('CASE');
  const provider = await seededProvider();
  await request(`/delivery/delivery/${delivery._id}/assign`, { method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) } });
  const res = await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'PICKED_UP' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await models.Delivery.findById(delivery._id)).status, 'pickup');

  const unknown = await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'teleporting' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'VALIDATION_ERROR');
});

it('assignment validates the delivery, the provider and their eligibility', async () => {
  const missingDelivery = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: '507f1f77bcf86cd799439011', providerId: 'x' },
  });
  assert.equal(missingDelivery.status, 404);

  const delivery = await newOrder('ELIG');
  const missingProvider = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: '507f1f77bcf86cd799439011' },
  });
  assert.equal(missingProvider.status, 404);

  const suspended = await seededProvider({ status: 'suspended' });
  const suspendedRes = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(suspended._id) },
  });
  assert.equal(suspendedRes.status, 400, JSON.stringify(suspendedRes.body));
  assert.match(String(suspendedRes.body.message), /suspended/i);

  const offline = await seededProvider({ status: 'offline', availability: { isOnline: false } });
  const offlineRes = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(offline._id) },
  });
  assert.equal(offlineRes.status, 400);
  assert.match(String(offlineRes.body.message), /offline/i);

  // A provider outside the delivery's zone may not be assigned to it.
  const otherZone = await models.Zone.create({ name: 'Other zone', code: 'OTHER-ZONE' });
  const elsewhere = await seededProvider({ zoneId: otherZone._id, zoneIds: [otherZone._id] });
  const coverageRes = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(elsewhere._id) },
  });
  assert.equal(coverageRes.status, 400, JSON.stringify(coverageRes.body));
  assert.match(String(coverageRes.body.message), /zone/i);

  assert.equal((await models.Delivery.findById(delivery._id)).status, 'pending', 'no partial state was written');
  assert.equal((await models.Assignment.countDocuments({ deliveryId: delivery._id })), 0, 'no orphan assignment exists');
});

it('one delivery never holds two active assignments', async () => {
  const delivery = await newOrder('DUP');
  const providerA = await seededProvider();
  const providerB = await seededProvider({ name: 'Provider Two' });

  const first = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(providerA._id) },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const second = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(providerB._id) },
  });
  assert.equal(second.status, 409);

  assert.equal(await models.Assignment.countDocuments({ deliveryId: delivery._id, status: { $in: ['pending', 'accepted'] } }), 1);
  assert.equal(
    String((await models.Delivery.findById(delivery._id)).providerId),
    String(providerA._id),
    'the first provider stays the owner',
  );
});

it('a provider can never exceed its active-assignment capacity', async () => {
  const capacityOne = await seededProvider({ maxActiveAssignments: 1 });
  const first = await newOrder('CAP-1');
  const second = await newOrder('CAP-2');

  const ok = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(first._id), providerId: String(capacityOne._id) },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const rejected = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(second._id), providerId: String(capacityOne._id) },
  });
  assert.ok([400, 409].includes(rejected.status), `over-capacity must be refused, got ${rejected.status}`);
  assert.match(JSON.stringify(rejected.body), /capacity|limit/i);

  const provider = await models.Provider.findById(capacityOne._id);
  assert.equal(provider.activeDeliveries, 1, 'capacity is not oversubscribed');
  const rejectedDelivery = await models.Delivery.findById(second._id);
  assert.equal(rejectedDelivery.status, 'pending', 'the refused order stays dispatchable');
  assert.equal(rejectedDelivery.providerId, null);
});

it('concurrent assignments to a provider at capacity cannot oversubscribe it', async () => {
  const provider = await seededProvider({ maxActiveAssignments: 1 });
  const a = await newOrder('RACE-1');
  const b = await newOrder('RACE-2');

  const [resA, resB] = await Promise.all([
    request('/delivery/assignment', { method: 'POST', as: actors.admin, body: { deliveryId: String(a._id), providerId: String(provider._id) } }),
    request('/delivery/assignment', { method: 'POST', as: actors.admin, body: { deliveryId: String(b._id), providerId: String(provider._id) } }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses.filter((s) => s >= 500), [], `no server error: ${JSON.stringify([resA.body, resB.body])}`);
  assert.equal(statuses.filter((s) => s === 201).length, 1, 'exactly one assignment wins the capacity');

  const after = await models.Provider.findById(provider._id);
  assert.equal(after.activeDeliveries, 1, 'the counter reflects exactly one reservation');
  assert.ok(after.activeDeliveries >= 0 && after.currentWorkloadIds.length === 1, 'capacity never goes negative');

  const winners = [a, b].filter((d) => d !== null);
  const pending = await models.Delivery.find({ _id: { $in: winners.map((d) => d._id) }, status: 'pending' });
  const assigned = await models.Delivery.find({ _id: { $in: winners.map((d) => d._id) }, status: 'assigned' });
  assert.equal(assigned.length, 1, 'exactly one delivery is assigned');
  assert.equal(pending.length, 1, 'the other stays in the ready pool');
});


it('a rejected assignment releases the order back to the ready pool', async () => {
  const delivery = await newOrder('REJ');
  const provider = await seededProvider();
  const assigned = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(provider._id) },
  });
  assert.equal(assigned.status, 201);

  const rejected = await request(`/delivery/assignment/${assigned.body.assignment._id}/respond`, {
    method: 'POST', as: providerActor(provider), body: { accepted: false, reason: 'Vehicle problem' },
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.assignment.status, 'rejected');

  const doc = await models.Delivery.findById(delivery._id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.providerId, null);
  assert.equal(doc.assignmentId, null);

  const providerAfter = await models.Provider.findById(provider._id);
  assert.equal(providerAfter.activeDeliveries, 0, 'the reserved capacity is released');

  const history = await models.TrackingEvent.find({ deliveryId: delivery._id }).sort({ timestamp: 1 });
  assert.ok(history.some((e) => e.status === 'pending'), 'the release is part of the delivery history');
});

it('a failed delivery can be requeued and given to a new provider', async () => {
  const delivery = await newOrder('FAIL');
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });

  await request(`/delivery/delivery/${delivery._id}/assign`, { method: 'PUT', as: actors.admin, body: { providerId: String(providerA._id) } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'pickup' } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'in_transit' } });

  const failed = await request(`/delivery/delivery/${delivery._id}/status`, {
    method: 'PUT', as: actors.admin, body: { status: 'failed', reason: 'Buyer unavailable at the address' },
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));

  let doc = await models.Delivery.findById(delivery._id);
  assert.equal(doc.status, 'failed');
  assert.equal(doc.failureReason, 'Buyer unavailable at the address');
  assert.equal((await models.Provider.findById(providerA._id)).activeDeliveries, 0, 'the failed attempt frees capacity');

  // Recovery path: back to the ready pool, then to a NEW provider.
  const requeue = await request(`/delivery/delivery/${delivery._id}/status`, {
    method: 'PUT', as: actors.admin, body: { status: 'pending', note: 'Retry with another provider' },
  });
  assert.equal(requeue.status, 200, JSON.stringify(requeue.body));

  const reassign = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(providerB._id) },
  });
  assert.equal(reassign.status, 201, JSON.stringify(reassign.body));
  doc = await models.Delivery.findById(delivery._id);
  assert.equal(String(doc.providerId), String(providerB._id));
  assert.equal(await models.Assignment.countDocuments({ deliveryId: delivery._id, status: { $in: ['pending', 'accepted'] } }), 1);
});


it('reassignment transfers the work and never leaves a duplicate active holder', async () => {
  const delivery = await newOrder('REASSIGN');
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });

  const first = await request('/delivery/assignment', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(providerA._id) },
  });
  assert.equal(first.status, 201);
  assert.equal((await models.Provider.findById(providerA._id)).activeDeliveries, 1);

  const reassigned = await request('/delivery/assignment/reassign', {
    method: 'POST', as: actors.admin, body: { deliveryId: String(delivery._id), providerId: String(providerB._id) },
  });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
  assert.equal(String(reassigned.body.assignment.providerId), String(providerB._id));
  assert.equal((await models.Provider.findById(providerA._id)).activeDeliveries, 0, 'provider A no longer consumes capacity');
  assert.equal((await models.Provider.findById(providerB._id)).activeDeliveries, 1, 'provider B is the active holder');
  assert.equal(await models.Assignment.countDocuments({ deliveryId: delivery._id, status: { $in: ['pending', 'accepted'] } }), 1, 'no duplicate active assignment');

  const doc = await models.Delivery.findById(delivery._id);
  assert.equal(String(doc.providerId), String(providerB._id));
  const history = await models.TrackingEvent.find({ deliveryId: delivery._id }).sort({ timestamp: 1 });
  assert.ok(history.some((e) => e.status === 'reassigned'), 'the reassignment is recorded in history');
});

it('cancellation releases everything it holds and is terminal', async () => {
  const delivery = await newOrder('CANCEL');
  const provider = await seededProvider();
  await request(`/delivery/delivery/${delivery._id}/assign`, { method: 'PUT', as: actors.admin, body: { providerId: String(provider._id) } });
  await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'pickup' } });

  const cancelled = await request(`/delivery/delivery/${delivery._id}/status`, {
    method: 'PUT', as: actors.admin, body: { status: 'cancelled', reason: 'The buyer cancelled the order' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const doc = await models.Delivery.findById(delivery._id);
  assert.equal(doc.status, 'cancelled');
  assert.equal(doc.cancellationReason, 'The buyer cancelled the order');
  assert.equal((await models.Provider.findById(provider._id)).activeDeliveries, 0, 'capacity is not leaked by a cancellation');
  assert.equal(await models.Assignment.countDocuments({ deliveryId: delivery._id, status: { $in: ['pending', 'accepted'] } }), 0);

  const again = await request(`/delivery/delivery/${delivery._id}/status`, { method: 'PUT', as: actors.admin, body: { status: 'pending' } });
  assert.equal(again.status, 409, 'a cancelled delivery is terminal');
});


