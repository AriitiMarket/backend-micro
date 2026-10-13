'use strict';
/**
 * Multi-order dispatch (AssignmentBatch) integration tests — the workflow an
 * admin and a delivery provider actually drive: ready orders → batch → accept →
 * pick up per seller → transit → deliver per order, with capacity, conflicts,
 * proof-of-delivery and reassignment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers');
const { seedGeography, createProvider, createDelivery } = require('./fixtures');

const harness = createHarness('dispatch');
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
    identityUserId: `user-dispatch-${providerSeq}`,
    zoneId: geo.zone._id,
    zoneIds: [geo.zone._id],
    portId: geo.port._id,
    serviceId: geo.service._id,
    ...overrides,
  });
}

function providerActor(provider) {
  return { id: provider.identityUserId, role: 'PROVIDER', capabilities: ['PROVIDER'] };
}

async function createBatch(deliveryIds, providerId) {
  return request('/delivery/dispatch/batches', {
    method: 'POST', as: actors.admin, body: { deliveryIds, providerId: String(providerId) },
  });
}

it('a multi-order batch groups the orders and one stop per seller', async () => {
  const provider = await seededProvider();
  const a = await newOrder('BATCH', { sellerId: 'seller-a' });
  const b = await newOrder('BATCH', { sellerId: 'seller-a' });
  const c = await newOrder('BATCH', { sellerId: 'seller-b' });

  const res = await createBatch([a._id, b._id, c._id], provider._id);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const batch = res.body.assignment;
  assert.equal(batch.deliveries.length, 3);
  assert.equal(batch.pickupPlan.length, 2, 'two sellers, two pickup stops');
  assert.ok(batch.reference, 'the human reference (DL-xxxx) is exposed');
  assert.equal(batch.status, 'waiting_acceptance');

  // One batch is one active assignment for capacity, however many orders it holds.
  const after = await models.Provider.findById(provider._id);
  assert.equal(after.activeDeliveries, 1, 'capacity counts assignment jobs, not orders');

  for (const id of [a._id, b._id, c._id]) {
    const doc = await models.Delivery.findById(id);
    assert.equal(doc.status, 'assigned');
    assert.equal(String(doc.providerId), String(provider._id));
    assert.equal(String(doc.assignmentId), String(batch._id));
  }

  // The ready pool no longer offers them.
  const ready = await request('/delivery/dispatch/ready-orders?limit=200', { as: actors.admin });
  assert.equal(ready.status, 200);
  const readyIds = new Set(ready.body.orders.map((o) => o.id));
  for (const id of [a._id, b._id, c._id]) {
    assert.ok(!readyIds.has(String(id)), 'an assigned order must not be dispatchable again');
  }
});

it('a provider may open their own batch and nobody else\'s', async () => {
  const providerA = await seededProvider({ name: 'Batch Rider A' });
  const providerB = await seededProvider({ name: 'Batch Rider B' });
  const order = await newOrder('BATCH-DETAIL');
  const created = await request('/delivery/dispatch/batches', {
    method: 'POST', as: actors.admin, body: { deliveryIds: [order._id], providerId: String(providerA._id) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const batchId = created.body.assignment._id;

  // The batch detail screen is the rider's own view: it used to be admin-only, so
  // the portal got 403 on the batch it was working.
  const own = await request(`/delivery/dispatch/batches/${batchId}`, { as: providerActor(providerA) });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(String(own.body.assignment.providerId), String(providerA._id));
  assert.ok(own.body.assignment.pickupPlan, 'the pickup plan the portal renders');

  const foreign = await request(`/delivery/dispatch/batches/${batchId}`, { as: providerActor(providerB) });
  assert.ok([403, 404].includes(foreign.status), 'another provider cannot open it');

  const asBuyer = await request(`/delivery/dispatch/batches/${batchId}`, { as: actors.buyer });
  assert.ok([403, 404].includes(asBuyer.status), 'a buyer cannot open it');

  const asAdmin = await request(`/delivery/dispatch/batches/${batchId}`, { as: actors.admin });
  assert.equal(asAdmin.status, 200, 'the admin console still sees every batch');
});

it('the rider drives the whole batch: accept, pickups per seller, transit, deliver', async () => {
  const provider = await seededProvider();
  const rider = providerActor(provider);
  const a = await newOrder('FLOW', { sellerId: 'seller-a' });
  const b = await newOrder('FLOW', { sellerId: 'seller-b' });

  const created = await createBatch([a._id, b._id], provider._id);
  assert.equal(created.status, 201);
  const batchId = created.body.assignment._id;
  const stops = created.body.assignment.pickupPlan;

  // A different provider may not touch it.
  const intruder = await seededProvider({ name: 'Intruder' });
  const refused = await request(`/delivery/dispatch/batches/${batchId}/respond`, {
    method: 'POST', as: providerActor(intruder), body: { accepted: true },
  });
  assert.equal(refused.status, 403, 'another provider may not act on this assignment');

  const accept = await request(`/delivery/dispatch/batches/${batchId}/respond`, {
    method: 'POST', as: rider, body: { accepted: true },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));

  // Transit before every pickup is refused.
  const tooEarly = await request(`/delivery/dispatch/batches/${batchId}/transit/start`, { method: 'POST', as: rider, body: {} });
  assert.equal(tooEarly.status, 400, JSON.stringify(tooEarly.body));

  const start = await request(`/delivery/dispatch/batches/${batchId}/pickup/start`, { method: 'POST', as: rider, body: {} });
  assert.equal(start.status, 200, JSON.stringify(start.body));

  const firstStop = await request(`/delivery/dispatch/batches/${batchId}/pickup/${stops[0].sellerId}/confirm`, {
    method: 'POST', as: rider, body: {},
  });
  assert.equal(firstStop.status, 200, JSON.stringify(firstStop.body));
  assert.equal(firstStop.body.assignment.status, 'picking_up', 'one stop is not the whole job');

  const stillEarly = await request(`/delivery/dispatch/batches/${batchId}/transit/start`, { method: 'POST', as: rider, body: {} });
  assert.equal(stillEarly.status, 400, 'transit only starts once every seller stop is collected');

  const secondStop = await request(`/delivery/dispatch/batches/${batchId}/pickup/${stops[1].sellerId}/confirm`, {
    method: 'POST', as: rider, body: {},
  });
  assert.equal(secondStop.status, 200);
  assert.equal(secondStop.body.assignment.status, 'picked_up');

  const transit = await request(`/delivery/dispatch/batches/${batchId}/transit/start`, { method: 'POST', as: rider, body: {} });
  assert.equal(transit.status, 200, JSON.stringify(transit.body));

  // An order cannot be delivered before the batch is in transit — checked above —
  // and each order moves on its own.
  const deliver = await request(`/delivery/dispatch/batches/${batchId}/orders/${a.orderId}/deliver`, {
    method: 'POST', as: rider, body: { note: 'Left with the guard' },
  });
  assert.equal(deliver.status, 200, JSON.stringify(deliver.body));
  assert.equal((await models.Delivery.findById(a._id)).status, 'delivered');
  assert.equal((await models.Delivery.findById(b._id)).status, 'in_transit', 'the other order is untouched');
  assert.equal((await models.AssignmentBatch.findById(batchId)).status, 'in_transit', 'the batch only completes when every order is delivered');

  const deliverRest = await request(`/delivery/dispatch/batches/${batchId}/orders/${b.orderId}/deliver`, {
    method: 'POST', as: rider, body: {},
  });
  assert.equal(deliverRest.status, 200, JSON.stringify(deliverRest.body));

  const finished = await models.AssignmentBatch.findById(batchId);
  assert.equal(finished.status, 'completed');
  assert.ok(finished.completedAt, 'completion is stamped');

  const providerAfter = await models.Provider.findById(provider._id);
  assert.equal(providerAfter.activeDeliveries, 0, 'capacity is released when the batch completes');
});

it('a COD delivery needs the collected amount confirmed by the provider', async () => {
  const provider = await seededProvider({ maxActiveAssignments: 5 });
  const rider = providerActor(provider);
  const order = await newOrder('COD', { paymentMethod: 'COD', paymentAmount: 500 });

  const created = await createBatch([order._id], provider._id);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const batchId = created.body.assignment._id;
  const stop = created.body.assignment.pickupPlan[0];

  await request(`/delivery/dispatch/batches/${batchId}/respond`, { method: 'POST', as: rider, body: { accepted: true } });
  await request(`/delivery/dispatch/batches/${batchId}/pickup/start`, { method: 'POST', as: rider, body: {} });
  await request(`/delivery/dispatch/batches/${batchId}/pickup/${stop.sellerId}/confirm`, { method: 'POST', as: rider, body: {} });
  await request(`/delivery/dispatch/batches/${batchId}/transit/start`, { method: 'POST', as: rider, body: {} });

  const withoutProof = await request(`/delivery/dispatch/batches/${batchId}/orders/${order.orderId}/deliver`, {
    method: 'POST', as: rider, body: {},
  });
  assert.equal(withoutProof.status, 400, `COD must not complete without proof: ${JSON.stringify(withoutProof.body)}`);
  assert.equal(withoutProof.body.code, 'PROOF_REQUIRED');
  assert.equal((await models.Delivery.findById(order._id)).status, 'in_transit', 'the refused completion changed nothing');

  const withProof = await request(`/delivery/dispatch/batches/${batchId}/orders/${order.orderId}/deliver`, {
    method: 'POST', as: rider, body: { codConfirmed: true, codCollectedAmount: 500, recipientName: 'Buyer' },
  });
  assert.equal(withProof.status, 200, JSON.stringify(withProof.body));

  const delivered = await models.Delivery.findById(order._id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.proofOfDelivery.codConfirmed, true, 'the confirmation is persisted');
  assert.equal(delivered.proofOfDelivery.codCollectedAmount, 500, 'the collected cash is persisted for reconciliation');
});

it('an order on an active assignment cannot be added to another one', async () => {
  const providerA = await seededProvider({ maxActiveAssignments: 5 });
  const providerB = await seededProvider({ maxActiveAssignments: 5, name: 'Provider B' });
  const held = await newOrder('CONFLICT');
  const batch = await createBatch([held._id], providerA._id);
  assert.equal(batch.status, 201);

  const conflict = await createBatch([held._id], providerB._id);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.match(String(conflict.body.message), /already assigned/i);
  assert.equal(await models.AssignmentBatch.countDocuments({ 'deliveries.deliveryId': held._id, status: { $nin: ['cancelled', 'rejected', 'completed'] } }), 1);
});

it('a provider cannot take more concurrent batches than its capacity', async () => {
  const provider = await seededProvider({ maxActiveAssignments: 1 });
  const first = await newOrder('CAP-A');
  const second = await newOrder('CAP-B');

  const ok = await createBatch([first._id], provider._id);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const rejected = await createBatch([second._id], provider._id);
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body.message), /maximum assignment limit|maximum of 1 active assignments/i);

  assert.equal((await models.Provider.findById(provider._id)).activeDeliveries, 1, 'capacity is not oversubscribed');
  assert.equal((await models.Delivery.findById(second._id)).status, 'pending', 'the refused order stays ready');
  assert.equal(await models.AssignmentBatch.countDocuments({ 'deliveries.deliveryId': second._id }), 0, 'no batch was created for it');
});

it('rejection releases the orders and the capacity immediately', async () => {
  const provider = await seededProvider();
  const rider = providerActor(provider);
  const order = await newOrder('REJ');

  const created = await createBatch([order._id], provider._id);
  assert.equal(created.status, 201);
  assert.equal((await models.Provider.findById(provider._id)).activeDeliveries, 1);

  const rejected = await request(`/delivery/dispatch/batches/${created.body.assignment._id}/respond`, {
    method: 'POST', as: rider, body: { accepted: false, reason: 'Too far away' },
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

  const doc = await models.Delivery.findById(order._id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.providerId, null);
  assert.equal(doc.assignmentId, null);
  const providerAfter = await models.Provider.findById(provider._id);
  assert.equal(providerAfter.activeDeliveries, 0, 'a rejection must not leak capacity');
});

it('reassignment moves the whole batch to a new provider and keeps the lineage', async () => {
  const providerA = await seededProvider({ name: 'Provider A' });
  const providerB = await seededProvider({ name: 'Provider B' });
  const order = await newOrder('REASSIGN-BATCH');

  const created = await createBatch([order._id], providerA._id);
  assert.equal(created.status, 201);
  const firstId = created.body.assignment._id;

  const reassigned = await request(`/delivery/dispatch/batches/${firstId}/reassign`, {
    method: 'POST', as: actors.admin, body: { providerId: String(providerB._id), reason: 'Provider A became unavailable' },
  });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));

  const previous = await models.AssignmentBatch.findById(firstId);
  const next = await models.AssignmentBatch.findById(reassigned.body.assignment._id);
  assert.equal(previous.status, 'cancelled', 'the outgoing batch is preserved, not deleted');
  assert.equal(String(previous.reassignedToId), String(next._id), 'the old batch points forward');
  assert.equal(String(next.reassignedFromId), String(previous._id), 'the new batch points back');
  assert.ok(next.history.length >= 1, 'history is kept');

  assert.equal((await models.Provider.findById(providerA._id)).activeDeliveries, 0, 'provider A is released');
  assert.equal((await models.Provider.findById(providerB._id)).activeDeliveries, 1, 'provider B holds the work');
  assert.equal(await models.AssignmentBatch.countDocuments({ 'deliveries.deliveryId': order._id, status: { $nin: ['cancelled', 'rejected', 'completed'] } }), 1, 'no duplicate active batch');

  const doc = await models.Delivery.findById(order._id);
  assert.equal(String(doc.providerId), String(providerB._id));
  assert.equal(String(doc.assignmentId), String(next._id));
});

it('an administrator can cancel a live batch and the orders go back to the pool', async () => {
  const provider = await seededProvider();
  const order = await newOrder('CANCEL-BATCH');
  const created = await createBatch([order._id], provider._id);
  assert.equal(created.status, 201);

  const cancelled = await request(`/delivery/dispatch/batches/${created.body.assignment._id}/cancel`, {
    method: 'POST', as: actors.admin, body: { reason: 'The order changed' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const doc = await models.Delivery.findById(order._id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.providerId, null);
  assert.equal((await models.Provider.findById(provider._id)).activeDeliveries, 0);
  assert.equal((await models.AssignmentBatch.findById(created.body.assignment._id)).status, 'cancelled');

  // A cancelled batch is closed: its rider cannot restart it.
  const actor = providerActor(provider);
  for (const action of ['pickup/start', 'transit/start']) {
    const res = await request(`/delivery/dispatch/batches/${created.body.assignment._id}/${action}`, {
      method: 'POST', as: actor, body: {},
    });
    assert.ok([400, 403].includes(res.status), `${action} on a cancelled batch must be refused (${res.status})`);
  }
});

it('a suspended or offline provider cannot be given a batch', async () => {
  const suspended = await seededProvider({ status: 'suspended' });
  const offline = await seededProvider({ status: 'offline', availability: { isOnline: false } });
  const order = await newOrder('ELIG-BATCH');

  for (const provider of [suspended, offline]) {
    const res = await createBatch([order._id], provider._id);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((await models.Delivery.findById(order._id)).status, 'pending');
  }
});
