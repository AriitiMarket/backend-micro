/**
 * Functional tests for the multi-order assignment state machine.
 *
 * The repositories are replaced with in-memory fakes (via the require cache)
 * so the real service logic runs without a database: eligibility rules, the
 * seller-grouped pickup plan, the "never complete early" rule, and
 * reassignment lineage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// __dirname = <service>/src/modules/operations/__tests__
// four levels up is the service root, where `src/...` paths resolve from.
const ROOT = path.resolve(__dirname, '../../../..');

// ---- In-memory fakes -------------------------------------------------------
const store = { batches: [], deliveries: new Map(), providers: new Map(), tracking: [], outbox: [], nextId: 1 };

function oid() {
  const id = `id${store.nextId++}`;
  return { toString: () => id, valueOf: () => id };
}

const ACTIVE = ['waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit'];

const batchRepo = {
  async findById(id) { return store.batches.find((b) => String(b._id) === String(id)) || null; },
  async create(data) { const doc = { ...data, _id: oid() }; store.batches.push(doc); return doc; },
  async updateFields(id, fields) { const b = await batchRepo.findById(id); Object.assign(b, fields); return b; },
  async findAll(filter = {}) {
    let out = store.batches;
    if (filter.status) out = out.filter((b) => b.status === filter.status);
    if (filter.providerId) out = out.filter((b) => String(b.providerId) === String(filter.providerId));
    return out;
  },
  async count(filter = {}) { return (await batchRepo.findAll(filter)).length; },
  async findActiveByProviderId(providerId) {
    return store.batches.filter((b) => String(b.providerId) === String(providerId) && ACTIVE.includes(b.status));
  },
  async findActiveByDeliveryIds(ids) {
    const set = new Set(ids.map(String));
    return store.batches.filter(
      (b) => ACTIVE.includes(b.status) && b.deliveries.some((d) => set.has(String(d.deliveryId))),
    );
  },
  async nextReference() { return `DL-${2000 + store.batches.length}`; },
};

const deliveriesRepo = {
  async findById(id) { return store.deliveries.get(String(id)) || null; },
  async updateFields(id, fields) {
    const d = store.deliveries.get(String(id));
    if (d) Object.assign(d, fields);
    return d;
  },
};

const eligibilityService = require('../../providers/services/provider-eligibility.service.js');
const providersService = {
  async getProvider(id) {
    const p = store.providers.get(String(id));
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    return p;
  },
  isProviderEligible: eligibilityService.isProviderEligible,
  async incrementWorkload(id, wId) {
    const p = await this.getProvider(id);
    const capacity = p.maxActiveAssignments || 3;
    if ((p.activeDeliveries || 0) >= capacity) throw Object.assign(new Error('Capacity exceeded'), { status: 409 });
    p.activeDeliveries = (p.activeDeliveries || 0) + 1;
    return p;
  },
  async decrementWorkload(id, wId) {
    const p = await this.getProvider(id).catch(() => null);
    if (p) p.activeDeliveries = Math.max(0, (p.activeDeliveries || 0) - 1);
    return p;
  },
  async completeDelivery(id, wId) {
    return this.decrementWorkload(id, wId);
  }
};

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('src/modules/operations/repositories/assignmentBatches.repository.js', batchRepo);
stub('src/modules/delivery-fulfillment/repositories/delivery.repository.js', deliveriesRepo);
stub('src/modules/providers/repositories/providers.repository.js', {
  async findByIdentityUserId(uid) {
    return [...store.providers.values()].find((p) => p.identityUserId === uid) || null;
  },
});
stub('src/modules/providers/services/providers.service.js', providersService);
stub('src/modules/tracking/repositories/tracking.repository.js', {
  async create(e) { store.tracking.push(e); return e; },
});
// The Commerce notification outbox is infrastructure, not business logic: the
// delivery state machine must run (and be asserted) without a live MongoDB just
// to record the downstream event. Without this stub every transition timed out
// on `deliveryoutboxevents.findOneAndUpdate()`.
stub('src/modules/delivery-fulfillment/repositories/delivery-outbox.repository.js', {
  async enqueue(event) { store.outbox.push(event); return { ...event, _id: oid() }; },
  async claimNext() { return null; },
  async markSent() { return null; },
  async markFailed() { return null; },
});
// Single-assignment holders (the OTHER assignment flow) — see createBatch's guard.
const singleHolds = { active: [] };
stub('src/modules/operations/repositories/assignments.repository.js', {
  async findActiveByDeliveryIds(ids = []) {
    const wanted = new Set(ids.map(String));
    return singleHolds.active.filter((a) => wanted.has(String(a.deliveryId)));
  },
  async findActiveByDeliveryId(deliveryId) {
    return singleHolds.active.filter((a) => String(a.deliveryId) === String(deliveryId));
  },
  // The delivery state machine closes the delivery's active assignment when it is
  // delivered/failed/cancelled.
  async cancelActiveByDelivery(deliveryId) {
    singleHolds.active = singleHolds.active.filter((a) => String(a.deliveryId) !== String(deliveryId));
    return { modifiedCount: 0 };
  },
});

const svc = require(path.join(ROOT, 'src/modules/operations/services/assignmentBatches.service.js'));

// ---- Fixtures --------------------------------------------------------------
function reset() {
  store.batches = [];
  store.tracking = [];
  store.outbox = [];
  store.deliveries = new Map();
  store.providers = new Map();
  singleHolds.active = [];
}

function seedDelivery(orderId, sellerId, status = 'pending', zoneId = 'zone1') {
  const d = {
    _id: oid(), orderId, sellerId, status,
    destination: { zoneId },
    origin: { shopName: `Shop ${sellerId}` },
  };
  store.deliveries.set(String(d._id), d);
  return d;
}

function seedProvider(id, status = 'available', extra = {}) {
  const p = { _id: { toString: () => id, valueOf: () => id }, name: id, status, availability: { isOnline: true }, ...extra };
  store.providers.set(id, p);
  return p;
}

const actor = { id: 'admin1', name: 'Admin' };

test('assigns many ready orders from different sellers in one batch', async () => {
  reset();
  seedProvider('rider1');
  const a = seedDelivery('AM-1021', 'A');
  const b = seedDelivery('AM-1022', 'B');
  const c = seedDelivery('AM-1023', 'A');

  const batch = await svc.createBatch({ deliveryIds: [a._id, b._id, c._id], providerId: 'rider1', actor });

  assert.equal(batch.status, 'waiting_acceptance');
  assert.equal(batch.deliveries.length, 3);
  // Orders from the SAME seller are one pickup stop; a different seller is another.
  assert.equal(batch.pickupPlan.length, 2);
  assert.deepEqual(batch.pickupPlan[0].orderIds, ['AM-1021', 'AM-1023']);
  assert.deepEqual(batch.pickupPlan[1].orderIds, ['AM-1022']);
  assert.equal(store.deliveries.get(String(a._id)).status, 'assigned');
});

test('refuses cancelled, delivered, and already-assigned orders', async () => {
  reset();
  seedProvider('rider1');
  const cancelled = seedDelivery('AM-1', 'A', 'cancelled');
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [cancelled._id], providerId: 'rider1', actor }),
    /cannot be assigned/,
  );

  reset();
  seedProvider('rider1');
  const delivered = seedDelivery('AM-2', 'A', 'delivered');
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [delivered._id], providerId: 'rider1', actor }),
    /cannot be assigned/,
  );

  reset();
  seedProvider('rider1');
  const one = seedDelivery('AM-3', 'A');
  await svc.createBatch({ deliveryIds: [one._id], providerId: 'rider1', actor });
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [one._id], providerId: 'rider1', actor }),
    /already assigned/,
  );
});

test('refuses riders that are unavailable or over capacity', async () => {
  reset();
  // An offline rider cannot be assigned
  seedProvider('busyRider', 'offline', { availability: { isOnline: false } });
  const d = seedDelivery('AM-4', 'A');
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [d._id], providerId: 'busyRider', actor }),
    /offline/,
  );

  reset();
  seedProvider('rider1', 'available', { maxActiveAssignments: 1 });
  const x = seedDelivery('AM-5', 'A');
  const y = seedDelivery('AM-6', 'B');
  await svc.createBatch({ deliveryIds: [x._id], providerId: 'rider1', actor });
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [y._id], providerId: 'rider1', actor }),
    /maximum assignment limit reached/,
  );
});

test('rider lifecycle: accept, pickup per seller, transit, deliver', async () => {
  reset();
  seedProvider('rider1');
  const a = seedDelivery('AM-1021', 'A');
  const b = seedDelivery('AM-1022', 'B');
  const batch = await svc.createBatch({ deliveryIds: [a._id, b._id], providerId: 'rider1', actor });

  assert.equal((await svc.acceptBatch(batch._id, 'rider1', { id: 'rider1' })).status, 'accepted');
  assert.equal((await svc.startPickup(batch._id, { id: 'rider1' })).status, 'picking_up');

  // First seller stop: the assignment is still picking up.
  const afterStop1 = await svc.confirmPickupStop(batch._id, 'A', { id: 'rider1' });
  assert.equal(afterStop1.status, 'picking_up');
  assert.equal(afterStop1.deliveries.find((d) => d.orderId === 'AM-1021').status, 'pickup');

  // Last stop: now the whole batch is picked up.
  assert.equal((await svc.confirmPickupStop(batch._id, 'B', { id: 'rider1' })).status, 'picked_up');

  const transit = await svc.startTransit(batch._id, { id: 'rider1' });
  assert.equal(transit.status, 'in_transit');
  assert.ok(transit.deliveries.every((d) => d.status === 'in_transit'));

  // Deliver ONE order: the assignment must NOT complete yet.
  const partial = await svc.markDelivered(batch._id, 'AM-1021', { id: 'rider1' });
  assert.equal(partial.status, 'in_transit', 'must not complete before every order is delivered');
  assert.equal(partial.deliveries.find((d) => d.orderId === 'AM-1022').status, 'in_transit');

  // Deliver the last order: now it completes.
  const done = await svc.markDelivered(batch._id, 'AM-1022', { id: 'rider1' });
  assert.equal(done.status, 'completed');
  assert.ok(done.completedAt);
});

test('reassigning keeps the previous assignment in history', async () => {
  reset();
  seedProvider('rider1');
  seedProvider('rider2');
  const a = seedDelivery('AM-1', 'A');
  const b = seedDelivery('AM-2', 'B');
  const first = await svc.createBatch({ deliveryIds: [a._id, b._id], providerId: 'rider1', actor });

  const { previous, assignment: second } = await svc.reassignBatch(first._id, {
    providerId: 'rider2', reason: 'Rider unavailable', actor,
  });

  assert.equal(previous.status, 'cancelled');
  assert.equal(String(previous.reassignedToId), String(second._id));
  assert.equal(previous.history.length >= 2, true);
  assert.equal(String(second.reassignedFromId), String(first._id));
  assert.equal(second.providerName, 'rider2');
  assert.deepEqual(second.deliveries.map((d) => d.orderId), ['AM-1', 'AM-2']);
  assert.notEqual(second.reference, first.reference);
});

test('a failed reassignment leaves the current assignment intact', async () => {
  reset();
  seedProvider('rider1');
  seedProvider('offlineRider', 'offline');
  const a = seedDelivery('AM-1', 'A');
  const first = await svc.createBatch({ deliveryIds: [a._id], providerId: 'rider1', actor });

  // The incoming rider is offline: the reassignment must fail...
  await assert.rejects(
    () => svc.reassignBatch(first._id, { providerId: 'offlineRider', reason: 'x', actor }),
    /offline/,
  );

  // ...and the ORIGINAL assignment must still be active and still hold the order.
  const still = await svc.getBatch(first._id);
  assert.equal(still.status, 'waiting_acceptance');
  assert.equal(store.batches.length, 1, 'no partial/duplicate batch was created');
  assert.equal(store.deliveries.get(String(a._id)).status, 'assigned');
  assert.equal(String(still.providerId), 'rider1');
});

test('rejects the whole batch if one selected order is not eligible', async () => {
  reset();
  seedProvider('rider1');
  const good = seedDelivery('AM-1', 'A');
  const bad = seedDelivery('AM-2', 'B', 'delivered');

  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [good._id, bad._id], providerId: 'rider1', actor }),
    /cannot be assigned/,
  );
  // Nothing was created and the good order was NOT left half-assigned.
  assert.equal(store.batches.length, 0);
  assert.equal(store.deliveries.get(String(good._id)).status, 'pending');
});

test('refuses a batch larger than the configured maximum', async () => {
  reset();
  seedProvider('rider1');
  const ids = Array.from({ length: 21 }, (_, i) => seedDelivery(`AM-${i}`, `S${i}`)._id);
  await assert.rejects(
    () => svc.createBatch({ deliveryIds: ids, providerId: 'rider1', actor }),
    /at most 20 orders/,
  );
});

test('rejecting releases the orders back to the ready pool', async () => {
  reset();
  seedProvider('rider1');
  const a = seedDelivery('AM-1', 'A');
  const batch = await svc.createBatch({ deliveryIds: [a._id], providerId: 'rider1', actor });

  const rejected = await svc.rejectBatch(batch._id, 'rider1', 'Too far', { id: 'rider1' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(store.deliveries.get(String(a._id)).status, 'pending');
  assert.equal(store.deliveries.get(String(a._id)).providerId, null);
});


test('refuses an order already held by a single assignment', async () => {
  reset();
  seedProvider('rider1');
  const a = seedDelivery('AM-1', 'A');
  singleHolds.active.push({ deliveryId: String(a._id) });

  await assert.rejects(
    () => svc.createBatch({ deliveryIds: [a._id], providerId: 'rider1', actor }),
    (err) => err.status === 409 && /already assigned/.test(err.message),
  );
  assert.equal(store.batches.length, 0, 'no batch was created for a held order');
  assert.equal(store.deliveries.get(String(a._id)).status, 'pending');
});
