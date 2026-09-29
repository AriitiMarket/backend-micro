const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const locationsRepo = require('../../locations-expansion/repositories/locations.repository');
const zonesRepo = require('../../locations-expansion/repositories/zones.repository');
const providersRepo = require('../../providers/repositories/providers.repository');

const ACTIVE_STATUSES = ['pending', 'assigned', 'pickup', 'in_transit'];

async function getOperationsDashboard() {
  const statuses = ['pending', 'assigned', 'pickup', 'in_transit', 'delivered', 'failed', 'cancelled', 'reassigned'];
  const [counts, activeProviders, totalProviders, totalZones, activeZones] = await Promise.all([
    Promise.all(statuses.map((s) => deliveriesRepo.count({ status: s }))),
    providersRepo.count({ status: 'available' }),
    providersRepo.count({}),
    zonesRepo.count({}),
    zonesRepo.count({ status: 'active' }),
  ]);
  const byStatus = {};
  statuses.forEach((s, i) => { byStatus[s] = counts[i]; });
  return {
    byStatus, total: counts.reduce((a, b) => a + b, 0),
    active: ACTIVE_STATUSES.reduce((a, s) => a + byStatus[s], 0),
    failed: byStatus.failed,
    providers: { total: totalProviders, available: activeProviders },
    zones: { total: totalZones, active: activeZones },
  };
}

async function locationSubtreeIds(locationId) {
  const ids = [locationId];
  const seen = new Set([String(locationId)]);
  let frontier = [locationId];
  while (frontier.length) {
    const children = await Promise.all(frontier.map((id) => locationsRepo.findChildren(id)));
    const next = [];
    for (const child of children.flat()) {
      const key = String(child._id);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(child._id);
      next.push(child._id);
    }
    frontier = next;
  }
  return ids;
}

async function listDeliveries({ status, orderId, locationId, pickupLocationId, destinationLocationId, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (orderId) filter.orderId = orderId;
  if (pickupLocationId) {
    const ids = await locationSubtreeIds(pickupLocationId);
    filter['origin.locationId'] = ids.length === 1 ? ids[0] : { $in: ids };
  }
  if (destinationLocationId) {
    const ids = await locationSubtreeIds(destinationLocationId);
    filter['destination.locationId'] = ids.length === 1 ? ids[0] : { $in: ids };
  }
  if (locationId) {
    const ids = await locationSubtreeIds(locationId);
    const match = ids.length === 1 ? ids[0] : { $in: ids };
    filter.$or = [{ 'origin.locationId': match }, { 'destination.locationId': match }];
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const [deliveries, total] = await Promise.all([
    deliveriesRepo.findAll(filter, { skip: (safePage - 1) * safeLimit, limit: safeLimit }),
    deliveriesRepo.count(filter),
  ]);
  return { deliveries, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
}

async function getDeliveriesForOrders(orderIds = []) {
  const limited = orderIds.filter(Boolean).slice(0, 200);
  const deliveries = await deliveriesRepo.findByOrderIds(limited);
  return deliveries.map((d) => ({
    orderId: d.orderId, deliveryId: d._id, status: d.status, providerId: d.providerId,
    origin: d.origin, destination: d.destination,
    pickedUpAt: d.pickedUpAt, deliveredAt: d.deliveredAt, failedAt: d.failedAt, cancelledAt: d.cancelledAt,
    failureReason: d.failureReason, cancellationReason: d.cancellationReason,
    createdAt: d.createdAt, updatedAt: d.updatedAt,
  }));
}

async function getLocationCounts() {
  const types = ['country', 'region', 'city', 'town', 'area', 'sector', 'community', 'village', 'rural', 'other'];
  const [typeCounts, activeByType, deliveryCounts, zonesTotal] = await Promise.all([
    Promise.all(types.map((t) => locationsRepo.count({ type: t }))),
    Promise.all(types.map((t) => locationsRepo.count({ type: t, isActive: true }))),
    Promise.all([deliveriesRepo.countByLocationField('origin.locationId'), deliveriesRepo.countByLocationField('destination.locationId')]),
    zonesRepo.count({}),
  ]);
  const byType = {};
  const activeTypes = {};
  types.forEach((t, i) => { byType[t] = typeCounts[i]; activeTypes[t] = activeByType[i]; });
  const [origin, destination] = deliveryCounts;
  const toMap = (rows) => { const o = {}; for (const r of rows) o[String(r._id)] = r.count; return o; };
  return {
    byType, activeByType: activeTypes, total: typeCounts.reduce((a, b) => a + b, 0), zones: zonesTotal,
    deliveriesByOriginLocation: toMap(origin), deliveriesByDestinationLocation: toMap(destination),
  };
}

module.exports = { locationSubtreeIds, getOperationsDashboard, listDeliveries, getDeliveriesForOrders, getLocationCounts };
