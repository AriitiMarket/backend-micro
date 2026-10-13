/**
 * Delivery assignment tests — normal Zone/Port assignment, the no-provider
 * case, FORCE assignment (reason + admin identity required, exception recorded,
 * delivery Zone/Port never moved) and the guards around busy / deactivated /
 * unapproved providers and duplicate assignments.
 *
 * Repositories and cross-module services are replaced with in-memory fakes via
 * the require cache; the REAL assignments.service and provider-eligibility
 * service run on top of them (the pattern used by assignmentBatches.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

// ---- In-memory fakes -------------------------------------------------------
const store = { deliveries: new Map(), assignments: [], providers: new Map(), events: [], nextId: 1 };
let seq = 0;
// Each id is fixed at creation — calling String() twice must not mint a new id.
const oid = () => {
  const v = `id${++seq}`;
  return { toString: () => v, valueOf: () => v };
};

function reset() {
  store.deliveries = new Map();
  store.assignments = [];
  store.providers = new Map();
  store.events = [];
}

function seedDelivery({
  orderId = 'DL-1', zoneId = 'zone-central', portId = 'port-main', status = 'ready_for_pickup',
} = {}) {
  const d = {
    _id: oid(), orderId, status,
    origin: { locationId: 'loc-seller' },
    destination: { locationId: 'loc-customer', zoneId, portId },
    serviceId: null, providerId: null, assignmentId: null,
  };
  store.deliveries.set(String(d._id), d);
  return d;
}

function seedProvider(id, extra = {}) {
  const p = {
    _id: { toString: () => id, valueOf: () => id },
    name: id, status: 'available',
    availability: { isOnline: true },
    zoneId: 'zone-central', zoneIds: ['zone-central'], portId: 'port-main',
    activeDeliveries: 0, maxActiveAssignments: 3, maxCapacityKg: 50,
    ...extra,
  };
  store.providers.set(id, p);
  return p;
}

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Real eligibility rules on top of the in-memory provider store.
const realEligibility = require(path.join(ROOT, 'src/modules/providers/services/provider-eligibility.service.js'));

const assignmentsRepo = {
  async create(data) {
    const active = store.assignments.find(
      (a) => String(a.deliveryId) === String(data.deliveryId) && ['pending', 'accepted'].includes(a.status),
    );
    if (active) throw Object.assign(new Error('dup'), { code: 11000 });
    const doc = {
      _id: oid(), status: 'pending', forcedAssignment: false, forceReason: '',
      forcedBy: null, forcedAt: null, notes: '',
      originalZoneId: null, originalPortId: null, providerZoneId: null, providerPortId: null,
      ...data,
    };
    store.assignments.push(doc);
    return doc;
  },
  async findById(id) { return store.assignments.find((a) => String(a._id) === String(id)) || null; },
  async findActiveByDeliveryId(deliveryId) {
    return store.assignments.filter(
      (a) => String(a.deliveryId) === String(deliveryId) && ['pending', 'accepted'].includes(a.status),
    );
  },
  async findAll(filter = {}) {
    let out = store.assignments;
    if (filter.deliveryId) out = out.filter((a) => String(a.deliveryId) === String(filter.deliveryId));
    if (filter.providerId) out = out.filter((a) => String(a.providerId) === String(filter.providerId));
    if (filter.status) out = out.filter((a) => a.status === filter.status);
    return out;
  },
  async count(filter = {}) { return (await assignmentsRepo.findAll(filter)).length; },
  async cancelActiveByDelivery(deliveryId) {
    store.assignments.forEach((a) => {
      if (String(a.deliveryId) === String(deliveryId) && ['pending', 'accepted'].includes(a.status)) {
        a.status = 'cancelled';
      }
    });
    return { modifiedCount: 0 };
  },
  async updateFields(id, fields) {
    const a = await assignmentsRepo.findById(id);
    if (a) Object.assign(a, fields);
    return a;
  },
  async findPendingExpired() { return []; },
};

const deliveriesRepo = {
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
};

const providersService = {
  async getProvider(id) {
    const p = store.providers.get(String(id));
    if (!p) throw Object.assign(new Error('Provider not found'), { status: 404 });
    return p;
  },
  isProviderEligible: realEligibility.isProviderEligible,
  findEligibleProviders: realEligibility.findEligibleProviders,
  async incrementWorkload(providerId, workloadId) {
    const p = await this.getProvider(providerId);
    if ((p.activeDeliveries || 0) >= (p.maxActiveAssignments || 3)) {
      throw Object.assign(new Error('Capacity exceeded'), { status: 409 });
    }
    if (!p.currentWorkloadIds) p.currentWorkloadIds = [];
    if (!p.currentWorkloadIds.includes(String(workloadId))) {
      p.currentWorkloadIds.push(String(workloadId));
      p.activeDeliveries = (p.activeDeliveries || 0) + 1;
    }
    return p;
  },
  async decrementWorkload(providerId, workloadId) {
    const p = store.providers.get(String(providerId));
    if (!p) return null;
    p.currentWorkloadIds = (p.currentWorkloadIds || []).filter((w) => w !== String(workloadId));
    p.activeDeliveries = Math.max(0, (p.activeDeliveries || 0) - 1);
    return p;
  },
  async findAvailableForAssignment(serviceId, zoneId) {
    return [...store.providers.values()].filter((p) => {
      if (p.status !== 'available' || !p.availability?.isOnline) return false;
      if ((p.activeDeliveries || 0) >= (p.maxActiveAssignments || 3)) return false;
      if (zoneId) {
        const inZone = String(p.zoneId) === String(zoneId) || (p.zoneIds || []).some((z) => String(z) === String(zoneId));
        if (!inZone) return false;
      }
      return true;
    });
  },
};

stub('src/modules/operations/repositories/assignments.repository.js', assignmentsRepo);
stub('src/modules/operations/repositories/assignmentBatches.repository.js', {
  async findActiveByDeliveryIds() { return []; },
  async findActiveByDeliveryId() { return []; },
});
stub('src/modules/delivery-fulfillment/repositories/delivery.repository.js', deliveriesRepo);
stub('src/modules/delivery-fulfillment/services/delivery-fulfillment.service.js', {
  async getDelivery(id) {
    const d = store.deliveries.get(String(id));
    if (!d) throw Object.assign(new Error('Delivery not found'), { status: 404 });
    return d;
  },
});
stub('src/modules/delivery-fulfillment/services/delivery-status.service.js', {
  async transitionDeliveryStatus(id, to, actor, opts) {
    const d = store.deliveries.get(String(id));
    if (!d) throw Object.assign(new Error('Delivery not found'), { status: 404 });
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
stub('src/modules/providers/services/providers.service.js', providersService);

const svc = require(path.join(ROOT, 'src/modules/operations/services/assignments.service.js'));

const admin = { id: 'admin-9', name: 'Force Admin', role: 'SUPER_ADMIN' };

// What the controller puts on the body: the AUTHENTICATED admin identity.
const actorFor = { actorId: admin.id, actorName: admin.name, actorRole: admin.role };

// ---- Normal assignment -----------------------------------------------------

test('normal assignment: in-area provider gets the offer; delivery Zone/Port untouched', async () => {
  reset();
  seedProvider('ahmed');
  const delivery = seedDelivery({ zoneId: 'zone-central', portId: 'port-main' });

  const assignment = await svc.createAssignment({
    deliveryId: delivery._id, providerId: 'ahmed', ...actorFor,
  });

  assert.equal(assignment.forcedAssignment, false);
  assert.equal(assignment.forceReason, '');
  const d = store.deliveries.get(String(delivery._id));
  assert.equal(d.status, 'assigned');
  assert.equal(String(d.providerId), 'ahmed');
  // §12 — the delivery keeps its own geography.
  assert.equal(d.destination.zoneId, 'zone-central');
  assert.equal(d.destination.portId, 'port-main');
});

test('no eligible provider in the zone: normal assignment is refused, nothing is created', async () => {
  reset();
  seedProvider('hassan', { zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
  const delivery = seedDelivery({ zoneId: 'zone-central', portId: 'port-main' });

  await assert.rejects(
    () => svc.createAssignment({ deliveryId: delivery._id, providerId: 'hassan', ...actorFor }),
    (err) => err.status === 400 && /does not cover the required zone/.test(err.message),
  );
  assert.equal(store.assignments.length, 0);
  const d = store.deliveries.get(String(delivery._id));
  assert.notEqual(d.status, 'assigned');
});

test('provider outside the delivery Port: normal assignment is refused', async () => {
  reset();
  seedProvider('ali', { portId: 'port-jugol' });
  const delivery = seedDelivery({ zoneId: 'zone-central', portId: 'port-main' });

  await assert.rejects(
    () => svc.createAssignment({ deliveryId: delivery._id, providerId: 'ali', ...actorFor }),
    (err) => err.status === 400 && /does not serve the required port/.test(err.message),
  );
  assert.equal(store.assignments.length, 0);
});

// ---- Force assignment ------------------------------------------------------

test('force assignment without a reason is rejected (400) before any state changes', async () => {
  reset();
  seedProvider('hassan', { zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
  const delivery = seedDelivery();

  await assert.rejects(
    () => svc.createAssignment({
      deliveryId: delivery._id, providerId: 'hassan',
      forceAssignment: true, ...actorFor,
    }),
    (err) => err.status === 400 && /requires a reason/.test(err.message),
  );
  assert.equal(store.assignments.length, 0);
  assert.equal(store.deliveries.get(String(delivery._id)).status, 'ready_for_pickup');
});

test('force assignment without an admin identity is rejected (403)', async () => {
  reset();
  seedProvider('hassan', { zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
  const delivery = seedDelivery();

  await assert.rejects(
    () => svc.createAssignment({
      deliveryId: delivery._id, providerId: 'hassan',
      forceAssignment: true, reason: 'No available provider in the delivery zone.',
      // Deliberately NO actorId — the controller only ever sends the
      // AUTHENTICATED admin, so a force request without one must be refused.
    }),
    (err) => err.status === 403 && /admin identity/.test(err.message),
  );
  assert.equal(store.assignments.length, 0);
});

test('force assignment: out-of-area provider accepted, exception recorded, delivery Zone/Port kept', async () => {
  reset();
  seedProvider('hassan', { zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
  const delivery = seedDelivery({ zoneId: 'zone-central', portId: 'port-main' });

  const assignment = await svc.createAssignment({
    deliveryId: delivery._id, providerId: 'hassan',
    forceAssignment: true, reason: 'No available provider in the delivery zone.', ...actorFor,
  });

  // §11 — the exception is fully recorded, never hidden.
  assert.equal(assignment.forcedAssignment, true);
  assert.equal(assignment.forceReason, 'No available provider in the delivery zone.');
  assert.equal(String(assignment.forcedBy), admin.id);
  assert.ok(assignment.forcedAt);
  assert.equal(String(assignment.originalZoneId), 'zone-central');
  assert.equal(String(assignment.originalPortId), 'port-main');
  assert.equal(String(assignment.providerZoneId), 'zone-jugol');
  assert.equal(String(assignment.providerPortId), 'port-jugol');

  // §12 — the DELIVERY stays where it is; the provider is the exception.
  const d = store.deliveries.get(String(delivery._id));
  assert.equal(d.status, 'assigned');
  assert.equal(d.destination.zoneId, 'zone-central');
  assert.equal(d.destination.portId, 'port-main');

  // The reason is visible in the delivery history event.
  const last = store.events[store.events.length - 1];
  assert.match(last.note, /Force assigned.*No available provider/);
});

// ---- Guards: the force flag never rescues a non-receivable provider --------

test('force assignment never rescues BUSY / DEACTIVATED / PENDING / OFFLINE providers', async () => {
  const cases = [
    ['busy', /not assignable/],
    ['suspended', /deactivated/i],
    ['pending', /not approved/i],
    ['offline', /offline/i],
  ];
  for (const [status, reason] of cases) {
    reset();
    seedProvider('target', { status, zoneId: 'zone-jugol', zoneIds: ['zone-jugol'], portId: 'port-jugol' });
    const delivery = seedDelivery();

    await assert.rejects(
      () => svc.createAssignment({
        deliveryId: delivery._id, providerId: 'target',
        forceAssignment: true, reason: 'No provider in zone', ...actorFor,
      }),
      (err) => err.status === 400 && reason.test(err.message),
      `force must not rescue status ${status}`,
    );
    assert.equal(store.assignments.length, 0, `no assignment for status ${status}`);
  }
});

test('a provider at capacity cannot be force-assigned either', async () => {
  reset();
  seedProvider('full', { activeDeliveries: 3, maxActiveAssignments: 3 });
  const delivery = seedDelivery();

  await assert.rejects(
    () => svc.createAssignment({
      deliveryId: delivery._id, providerId: 'full',
      forceAssignment: true, reason: 'No provider in zone', ...actorFor,
    }),
    (err) => err.status === 400 && /maximum assignment limit/.test(err.message),
  );
  assert.equal(store.assignments.length, 0);
});

// ---- Duplicate assignment --------------------------------------------------

test('duplicate assignment: an active offer blocks a second one (409)', async () => {
  reset();
  seedProvider('ahmed');
  seedProvider('hassan');
  const delivery = seedDelivery();

  await svc.createAssignment({ deliveryId: delivery._id, providerId: 'ahmed', ...actorFor });
  await assert.rejects(
    () => svc.createAssignment({ deliveryId: delivery._id, providerId: 'hassan', ...actorFor }),
    (err) => err.status === 409 && /already has an active assignment/.test(err.message),
  );
  // Force mode must not bypass the duplicate guard either.
  await assert.rejects(
    () => svc.createAssignment({
      deliveryId: delivery._id, providerId: 'hassan',
      forceAssignment: true, reason: 'swap', ...actorFor,
    }),
    (err) => err.status === 409,
  );
  assert.equal(store.assignments.length, 1);
});



