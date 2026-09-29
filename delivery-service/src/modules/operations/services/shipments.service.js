const shipmentsRepo = require('../repositories/shipments.repository');
const auditClient = require('../../../shared/utils/audit-client');
const locationsService = require('../../locations-expansion/services/locations.service');
const routesRepo = require('../../locations-expansion/repositories/routes.repository');

const SHIPMENT_TRANSITIONS = {
  planning: ['ready', 'cancelled'],
  ready: ['dispatched', 'planning', 'cancelled'],
  dispatched: ['in_transit', 'arrived', 'failed', 'returned'],
  in_transit: ['arrived', 'failed', 'returned'],
  arrived: ['receiving', 'failed', 'returned'],
  receiving: ['received', 'failed'],
  received: ['completed'],
  completed: [],
  cancelled: [],
  failed: [],
  returned: []
};

async function transitionShipmentStatus(shipmentId, newStatus, actor, note = '') {
  const shipment = await shipmentsRepo.findById(shipmentId);
  if (!shipment) throw Object.assign(new Error('Shipment not found'), { status: 404 });

  const currentStatus = shipment.status;
  if (currentStatus === newStatus) return shipment; // Idempotent

  const allowed = SHIPMENT_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(new Error(`Invalid shipment status transition: ${currentStatus} -> ${newStatus}`), { status: 409 });
  }

  if (newStatus === 'dispatched') {
    if (shipment.items.length === 0) throw Object.assign(new Error('Cannot dispatch empty shipment'), { status: 400 });
  }

  const historyEntry = {
    status: newStatus,
    timestamp: new Date(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : null,
    note
  };

    const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
  const updated = await shipmentsRepo.updateFields(shipmentId, { status: newStatus });
  await shipmentsRepo.pushHistory(shipmentId, historyEntry);

  if (auditClient && typeof auditClient.sendAudit === 'function') {
    auditClient.sendAudit({
      action: `SHIPMENT_${newStatus.toUpperCase()}`,
      targetEntity: 'shipment',
      targetId: shipmentId,
      adminId: actor ? actor.id : null,
      adminName: actor ? actor.name : null,
      newValue: { status: newStatus },
      oldValue: { status: currentStatus },
      reason: note
    }).catch(() => null);
  }

  if (['received', 'completed', 'cancelled', 'failed', 'returned'].includes(newStatus)) {
    if (updated.items && updated.items.length > 0) {
      const deliveryIds = updated.items.map(i => i.deliveryId);
      // Remove shipmentId to release deliveries back to the ready pool for last-mile or re-routing
      await deliveriesRepo.updateMany({ _id: { $in: deliveryIds } }, { $set: { shipmentId: null } });
    }
  }

  return updated;
}

async function getShipment(id) {
  const shipment = await shipmentsRepo.findById(id);
  if (!shipment) throw Object.assign(new Error('Shipment not found'), { status: 404 });
  return decorate(shipment, new Map());
}

/**
 * Display names for the list UI: resolve origin/destination/route names once
 * per request (cached), so a shipment created before a rename still renders
 * the current name instead of an empty column.
 */
async function locName(id, cache) {
  const key = String(id);
  if (cache.has(key)) return cache.get(key);
  let name = '';
  try {
    const loc = await locationsService.getLocation(id);
    name = loc ? loc.name : '';
  } catch { name = ''; }
  cache.set(key, name);
  return name;
}

async function decorate(shipment, cache) {
  const plain = shipment.toObject ? shipment.toObject() : { ...shipment };
  const snap = plain.snapshots || {};
  if (!plain.originName) {
    plain.originName = plain.originLocationId
      ? await locName(plain.originLocationId, cache)
      : (snap.originName || '');
  }
  if (!plain.destinationName) {
    plain.destinationName = plain.destinationLocationId
      ? await locName(plain.destinationLocationId, cache)
      : (snap.destinationName || '');
  }
  if (!plain.routeName && plain.routeId) {
    try {
      const route = await routesRepo.findById(plain.routeId);
      plain.routeName = route ? (route.name || route.code || '') : '';
    } catch { plain.routeName = ''; }
  }
  return plain;
}

async function getShipments(filter, options) {
  const rows = await shipmentsRepo.findAll(filter, options);
  const cache = new Map();
  return Promise.all(rows.map((r) => decorate(r, cache)));
}

async function countShipments(filter = {}) {
  return shipmentsRepo.count(filter);
}

module.exports = {
  transitionShipmentStatus,
  getShipment,
  getShipments,
  countShipments
};
