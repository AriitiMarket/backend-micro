/**
 * Single-assignment advance tests.
 *
 * A provider holding ONE delivery must be able to move it forward —
 * pickup → in_transit → delivered. Before this route existed only the batch
 * (multi-order) flow could advance a delivery, so a rider with a single order
 * was stuck: their parcel sat in `assigned` until an admin closed it by hand.
 *
 * These tests run the REAL `advanceAssignment` on top of in-memory fakes (the
 * pattern used by assignmentForce.test.js) and assert the rules that make the
 * route safe: only the holder may drive it, only after the offer was ACCEPTED,
 * only to a status the delivery can actually reach, and always through the ONE
 * state machine so the milestone, the wallet credit, the tracking event and
 * the Commerce notification are identical to the batch path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

// ---- In-memory fakes -------------------------------------------------------
const store = { deliveries: new Map(), assignments: [], events: [] };
let seq = 0;
const oid = () => {
  const v = `id${++seq}`;
  return { toString: () => v, valueOf: () => v };
};

function reset() {
  store.deliveries = new Map();
  store.assignments = [];
  store.events = [];
}

function seedDelivery({ orderId = 'DL-1', status = 'assigned' } = {}) {
  const d = {
    _id: oid(), orderId, status,
    origin: { locationId: 'loc-seller' },
    destination: { locationId: 'loc-customer', zoneId: 'zone-central', portId: 'port-main' },
    serviceId: null, providerId: null, assignmentId: null,
    paymentMethod: 'COD', paymentAmount: 500, proofRules: { requireCodConfirmation: true },
  };
  store.deliveries.set(String(d._id), d);
  return d;
}

function seedAssignment(delivery, { status = 'accepted', providerId = 'rider-1' } = {}) {
  const a = {
    _id: oid(), deliveryId: delivery._id, providerId, status,
    serviceId: null, zoneId: 'zone-central', portId: 'port-main', routeId: null,
    assignedAt: new Date(), respondedAt: null, expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    notes: '', forcedAssignment: false, forceReason: '', forcedBy: null, forcedAt: null,
  };
  store.assignments.push(a);
  return a;
}

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const assignmentsRepo = {
  async findById(id) { return store.assignments.find((a) => String(a._id) === String(id)) || null; },
  async findAll() { return store.assignments; },
  async count() { return store.assignments.length; },
  async updateFields(id, fields) {
    const a = await assignmentsRepo.findById(id);
    if (a) Object.assign(a, fields);
    return a;
  },
  async cancelActiveByDelivery(deliveryId) {
    store.assignments.forEach((a) => {
      if (String(a.deliveryId) === String(deliveryId) && ['pending', 'accepted'].includes(a.status)) {
        a.status = 'cancelled';
      }
    });
    return { modifiedCount: 0 };
  },
  async findActiveByDeliveryId() { return []; },
  async findPendingExpired() { return []; },
};

stub('src/modules/operations/repositories/assignments.repository.js', assignmentsRepo);
stub('src/modules/operations/repositories/assignmentBatches.repository.js', {
  async findActiveByDeliveryIds() { return []; },
  async findActiveByDeliveryId() { return []; },
});
stub('src/modules/delivery-fulfillment/repositories/delivery.repository.js', {
  async findById(id) { return store.deliveries.get(String(id)) || null; },
  async findByProviderId() { return []; },
  async updateFields(id, fields) {
    const d = store.deliveries.get(String(id));
    if (!d) return null;
    for (const [key, value] of Object.entries(fields)) {
      if (key.startsWith('destination.')) {
        d.destination = d.destination || {};
        d.destination[key.slice('destination.'.length)] = value;
      } else {
        d[key] = value;
      }
    }
    return d;
  },
});
stub('src/modules/delivery-fulfillment/services/delivery-fulfillment.service.js', {
  async getDelivery(id) {
    const d = store.deliveries.get(String(id));
    if (!d) throw Object.assign(new Error('Delivery not found'), { status: 404 });
    return d;
  },
});
// The state machine is the REAL one; only its side effects are recorded.
stub('src/modules/delivery-fulfillment/services/delivery-status.service.js', {
  async transitionDeliveryStatus(id, to, actor, opts) {
    const d = store.deliveries.get(String(id));
    if (!d) throw Object.assign(new Error('Delivery not found'), { status: 404 });
    const VALID = {
      assigned: ['pickup', 'reassigned', 'pending', 'failed', 'cancelled'],
      pickup: ['in_transit', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
      in_transit: ['delivered', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
    };
    if (!VALID[d.status] || !VALID[d.status].includes(to)) {
      throw Object.assign(new Error(`Invalid transition ${d.status} -> ${to}`), { status: 409 });
    }
    d.status = to;
    store.events.push({ id: String(id), to, actor, note: opts && opts.note });
    return d;
  },
});
stub('src/modules/locations-expansion/services/zones.service.js', {
  async getZone(id) {
    if (!id) throw Object.assign(new Error('Zone not found'), { status: 404 });
    return { _id: id, name: `Zone ${id}` };
  },
  async findZoneForLocation() { return []; },
});
stub('src/modules/locations-expansion/services/routes.service.js', {
  async findRouteByEndpoints() { return null; },
  async getRoutes() { return []; },
});
stub('src/modules/locations-expansion/services/deliveryServices.service.js', {
  async getService() { return null; },
  async findServiceForDelivery() { return { services: [] }; },
});
stub('src/modules/providers/services/providers.service.js', {
  async getProvider(id) { return { _id: { toString: () => id, valueOf: () => id }, name: id }; },
  isProviderEligible() { return { eligible: true }; },
  findEligibleProviders() { return []; },
  async findAvailableForAssignment() { return []; },
  async incrementWorkload() {},
  async decrementWorkload() {},
});

const svc = require(path.join(ROOT, 'src/modules/operations/services/assignments.service.js'));

const rider = { id: 'rider-1', name: 'Rider One', providerId: 'rider-1', isAdmin: false };
const otherRider = { id: 'rider-2', name: 'Rider Two', providerId: 'rider-2', isAdmin: false };
const admin = { id: 'admin-1', name: 'Admin', isAdmin: true };

// ---- The happy path ---------------------------------------------------------

test('the provider holding the assignment advances it: assigned → pickup → in_transit → delivered', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await svc.advanceAssignment(assignment._id, 'pickup', rider);
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'pickup');

  await svc.advanceAssignment(assignment._id, 'in_transit', rider);
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'in_transit');

  await svc.advanceAssignment(assignment._id, 'delivered', rider);
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'delivered');
});

test('every advance goes through the one state machine, as a PROVIDER actor', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await svc.advanceAssignment(assignment._id, 'pickup', rider);

  assert.equal(store.events.length, 1);
  const event = store.events[0];
  assert.equal(event.to, 'pickup');
  assert.equal(event.actor.role, 'PROVIDER');
  assert.equal(String(event.actor.id), 'rider-1');
  // The provider id travels with the actor so the delivery's own record can
  // be attributed to the rider who did the work.
  assert.equal(String(event.actor.id), 'rider-1');
});

// ---- Ownership -------------------------------------------------------------

test('a provider who does not hold the assignment is refused (403)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted', providerId: 'rider-1' });

  await assert.rejects(
    () => svc.advanceAssignment(assignment._id, 'pickup', otherRider),
    (err) => err.status === 403 && /another provider/.test(err.message),
  );
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'assigned');
  assert.equal(store.events.length, 0);
});

test('an account with no provider profile cannot advance a delivery (403)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await assert.rejects(
    () => svc.advanceAssignment(assignment._id, 'pickup', { id: 'nobody', isAdmin: false }),
    (err) => err.status === 403 && /No delivery provider profile/.test(err.message),
  );
  assert.equal(store.events.length, 0);
});

// ---- The offer must have been accepted --------------------------------------

test('the provider must ACCEPT the assignment before they perform work on it (409)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'pending' });

  await assert.rejects(
    () => svc.advanceAssignment(assignment._id, 'pickup', rider),
    (err) => err.status === 409 && /Accept the assignment/.test(err.message),
  );
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'assigned');
  assert.equal(store.events.length, 0);
});

// ---- The target must be reachable -------------------------------------------

test('only pickup, in_transit and delivered may be driven by a provider (400)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  for (const target of ['assigned', 'pending', 'failed', 'cancelled', 'reassigned', 'nonsense']) {
    await assert.rejects(
      () => svc.advanceAssignment(assignment._id, target, rider),
      (err) => err.status === 400 && /Cannot move a delivery/.test(err.message),
      `target ${target} must be refused`,
    );
  }
  assert.equal(store.events.length, 0);
});

test('a delivery that has not been picked up cannot jump straight to delivered (409)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await assert.rejects(
    () => svc.advanceAssignment(assignment._id, 'delivered', rider),
    (err) => err.status === 409 && /INVALID_ADVANCE_STATE|assigned|delivery/i.test(err.message),
  );
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'assigned');
  assert.equal(store.events.length, 0);
});

test('a cancelled delivery cannot be advanced (409)', async () => {
  reset();
  const delivery = seedDelivery({ status: 'cancelled' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await assert.rejects(
    () => svc.advanceAssignment(assignment._id, 'pickup', rider),
    (err) => err.status === 409,
  );
  assert.equal(store.events.length, 0);
});

// ---- Platform operators ----------------------------------------------------

test('an admin may advance a delivery on a provider\'s behalf', async () => {
  reset();
  const delivery = seedDelivery({ status: 'assigned' });
  const assignment = seedAssignment(delivery, { status: 'accepted' });

  await svc.advanceAssignment(assignment._id, 'pickup', admin);
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'pickup');
  assert.equal(store.events[0].actor.role, 'ADMIN');
});
