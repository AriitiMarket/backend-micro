const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');

const store = {
  shipments: [],
  deliveries: new Map(),
  routes: new Map(),
  audit: [],
  nextId: 1
};

function oid() {
  const id = `id${store.nextId++}`;
  return { toString: () => id, valueOf: () => id };
}

const shipmentsRepo = {
  async create(data) { const doc = { ...data, _id: oid() }; store.shipments.push(doc); return doc; },
  async findById(id) { return store.shipments.find(s => String(s._id) === String(id)) || null; },
  async findByIdAndUpdate(id, update, opts) {
    const s = await this.findById(id);
    if (!s) return null;
    if (update.$set) Object.assign(s, update.$set);
    if (update.$push && update.$push.history) s.history.push(update.$push.history);
    return s;
  },
  async updateFields(id, fields) {
    const s = await this.findById(id);
    if (s) Object.assign(s, fields);
    return s;
  },
  async pushHistory(id, entry) {
    const s = await this.findById(id);
    if (s) s.history.push(entry);
    return s;
  },
  async removeById(id) {
    const idx = store.shipments.findIndex(s => String(s._id) === String(id));
    if (idx >= 0) return store.shipments.splice(idx, 1)[0];
    return null;
  }
};

const deliveriesRepo = {
  async findById(id) { return store.deliveries.get(String(id)) || null; },
  async findAll(filter = {}, _opts = {}) {
    const out = [];
    for (const d of store.deliveries.values()) {
      if (filter.status && d.status !== filter.status) continue;
      if ('shipmentId' in filter && d.shipmentId != null) continue;
      if (filter['origin.locationId'] && String(d.origin?.locationId) !== String(filter['origin.locationId'])) continue;
      if (filter['destination.locationId'] && String(d.destination?.locationId) !== String(filter['destination.locationId'])) continue;
      if (filter.serviceId && String(d.serviceId) !== String(filter.serviceId)) continue;
      out.push(d);
    }
    return out;
  },
  async updateFields(id, fields) {
    const d = store.deliveries.get(String(id));
    if (d) Object.assign(d, fields);
    return d;
  },
  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (const d of store.deliveries.values()) {
      if (filter._id && filter._id.$in) {
        const idMatches = filter._id.$in.includes(d._id) || filter._id.$in.includes(String(d._id));
        const statusOk = !filter.status || d.status === filter.status;
        const shipmentOk = !('shipmentId' in filter) || d.shipmentId == null;
        if (idMatches && statusOk && shipmentOk) {
          if (update.$set) Object.assign(d, update.$set);
          modifiedCount++;
        }
      }
    }
    // Same shape mongoose returns.
    return { modifiedCount, matchedCount: modifiedCount };
  }
};

const routesRepo = {
  async findById(id) { return store.routes.get(String(id)) || null; }
};

const auditClient = {
  async sendAudit(event) { store.audit.push(event); }
};

function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('src/modules/operations/repositories/shipments.repository.js', shipmentsRepo);
stub('src/modules/delivery-fulfillment/repositories/delivery.repository.js', deliveriesRepo);
stub('src/modules/locations-expansion/repositories/routes.repository.js', routesRepo);
stub('src/shared/utils/audit-client.js', auditClient);
// Name lookups for candidate groups — no DB in unit tests.
stub('src/modules/locations-expansion/services/locations.service.js', {
  getLocation: async (id) => ({ _id: id, name: `Location ${id}` })
});
stub('src/modules/locations-expansion/services/deliveryServices.service.js', {
  getService: async (id) => ({ _id: id, name: `Service ${id}` })
});

const consolidationService = require(path.join(ROOT, 'src/modules/operations/services/consolidation.service.js'));
const shipmentsService = require(path.join(ROOT, 'src/modules/operations/services/shipments.service.js'));

function reset() {
  store.shipments = [];
  store.deliveries.clear();
  store.routes.clear();
  store.audit = [];
}

const actor = { id: 'admin1', name: 'Admin' };

test('Shipment: create shipment via consolidation', async () => {
  reset();
  const d1 = { _id: oid(), status: 'pending', origin: { locationId: 'loc1' }, metadata: { weight: 10 } };
  const d2 = { _id: oid(), status: 'pending', origin: { locationId: 'loc1' }, metadata: { weight: 5 } };
  store.deliveries.set(String(d1._id), d1);
  store.deliveries.set(String(d2._id), d2);

  const shipment = await consolidationService.confirmConsolidation({
    deliveryIds: [d1._id, d2._id],
    originLocationId: 'loc1',
    maxWeight: 20
  }, actor);

  assert.equal(shipment.items.length, 2);
  assert.equal(shipment.capacity.usedWeight, 15);
  assert.equal(String(d1.shipmentId), String(shipment._id));
  assert.ok(shipment.shipmentNumber, 'shipment gets a reference number');
});

test('Shipment: capacity validation', async () => {
  reset();
  const d1 = { _id: oid(), status: 'pending', origin: { locationId: 'loc1' }, metadata: { weight: 15 } };
  store.deliveries.set(String(d1._id), d1);

  await assert.rejects(
    () => consolidationService.confirmConsolidation({ deliveryIds: [d1._id], originLocationId: 'loc1', maxWeight: 10 }, actor),
    /capacity exceeded/i
  );
});

test('Shipment: invalid transitions', async () => {
  reset();
  const sId = oid();
  store.shipments.push({ _id: sId, status: 'planning', history: [] });
  await assert.rejects(
    () => shipmentsService.transitionShipmentStatus(sId, 'received', actor),
    /Invalid shipment status transition/
  );
});

test('Consolidation: duplicate request', async () => {
  reset();
  const d1 = { _id: oid(), status: 'pending', origin: { locationId: 'loc1' }, shipmentId: oid() };
  store.deliveries.set(String(d1._id), d1);

  await assert.rejects(
    () => consolidationService.confirmConsolidation({ deliveryIds: [d1._id], originLocationId: 'loc1' }, actor),
    /already belongs to a shipment/i
  );
});

test('Consolidation candidates expose the shape the admin UI reads', async () => {
  reset();
  const base = {
    status: 'pending',
    origin: { locationId: 'loc1' },
    destination: { locationId: 'loc2' },
    serviceId: 'svc1',
    metadata: { weight: 4 },
  };
  const d1 = { ...base, _id: oid(), orderId: 'ord-1' };
  const d2 = { ...base, _id: oid(), orderId: 'ord-2' };
  // Different group (other destination) must not merge into it.
  const d3 = { ...base, _id: oid(), orderId: 'ord-3', destination: { locationId: 'loc3' } };
  // Not eligible: already in a shipment.
  const d4 = { ...base, _id: oid(), orderId: 'ord-4', shipmentId: 'shp-1' };
  [d1, d2, d3, d4].forEach((d) => store.deliveries.set(String(d._id), d));

  const groups = await consolidationService.getCandidates({});
  assert.equal(groups.length, 2);

  const main = groups.find((g) => g.deliveryCount === 2);
  assert.ok(main, 'first group holds both same-route deliveries');
  assert.ok(main.id && main.groupName, 'id + groupName present (React keys / labels)');
  assert.equal(main.deliveryIds.length, 2);
  assert.deepEqual(main.deliveryIds, [String(d1._id), String(d2._id)]);
  assert.equal(main.deliveryCount, 2);
  assert.equal(main.totalWeight, 8);
  assert.equal(main.originLocationId, 'loc1');
  assert.equal(main.serviceId, 'svc1');
  assert.equal(main.originName, 'Location loc1');
  assert.equal(main.destinationName, 'Location loc2');
  assert.equal(main.serviceName, 'Service svc1');
  assert.match(main.reason, /Same origin/);

  const solo = groups.find((g) => g.deliveryCount === 1);
  assert.equal(solo.originLocationId, 'loc1');
  assert.equal(solo.destinationLocationId, 'loc3');
});

test('Deconsolidation: shipment received releases deliveries', async () => {
  reset();
  const d1 = { _id: 'd1', status: 'pending', shipmentId: oid() };
  store.deliveries.set('d1', d1);
  const sId = oid();
  store.shipments.push({ _id: sId, status: 'receiving', items: [{ deliveryId: 'd1' }], history: [] });
  await shipmentsService.transitionShipmentStatus(sId, 'received', actor);
  
  // Delivery should be released
  assert.equal(d1.shipmentId, null);
});

test('Hub: arrival and receiving', async () => {
  reset();
  const sId = oid();
  store.shipments.push({ _id: sId, status: 'in_transit', items: [{ deliveryId: 'd1' }], history: [] });
  const s = await shipmentsService.transitionShipmentStatus(sId, 'arrived', actor);
  assert.equal(s.status, 'arrived');
});
