const deliveriesRepo = require('../../delivery-fulfillment/repositories/delivery.repository');
const providersRepo = require('../../providers/repositories/providers.repository');
const zonesRepo = require('../../locations-expansion/repositories/zones.repository');
const deliveryServicesRepo = require('../../locations-expansion/repositories/deliveryServices.repository');
const routesRepo = require('../../locations-expansion/repositories/routes.repository');
const assignmentsRepo = require('../repositories/assignments.repository');
const locationsRepo = require('../../locations-expansion/repositories/locations.repository');
const portsRepo = require('../repositories/ports.repository');
const shipmentsRepo = require('../repositories/shipments.repository');
const {
  DELIVERY_STATUSES,
  IN_PROGRESS_DELIVERY_STATUSES,
  READY_DELIVERY_STATUSES,
} = require('../../../shared/constants');

/**
 * Overview dashboard (MVP §5). Filters mirror what the admin can pick on the
 * Overview page: status, zone/service, date range.
 */
async function getDashboard(filters = {}, scope = {}) {
  const { zoneId, serviceId, providerId, status, dateFrom, dateTo } = filters;
  const df = { ...scope };
  if (status) df.status = status;
  if (zoneId) df['destination.zoneId'] = zoneId;
  if (serviceId) df.serviceId = serviceId;
  if (providerId) df.providerId = providerId;
  if (dateFrom || dateTo) {
    df.createdAt = {};
    if (dateFrom) df.createdAt.$gte = new Date(dateFrom);
    if (dateTo) df.createdAt.$lte = new Date(dateTo);
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [active, pending, assigned, pickup, inTransit, deliveredCount, failedCount, cancelledCount,
    deliveredToday, pendingAssignments,
    totalProviders, availableProviders, busyProviders, pendingProviders, suspendedProviders,
    totalZones, activeZones,
    totalServices, activeServices, totalRoutes, activeRoutes,
    byZone,
    activeShipments, waitingForDispatchShipments, inTransitShipments, arrivedShipments, receivingShipments] = await Promise.all([
    deliveriesRepo.count({ ...df, status: { $in: IN_PROGRESS_DELIVERY_STATUSES } }),
    deliveriesRepo.count({ ...df, status: { $in: READY_DELIVERY_STATUSES } }),
    deliveriesRepo.count({ ...df, status: 'assigned' }),
    deliveriesRepo.count({ ...df, status: 'pickup' }),
    deliveriesRepo.count({ ...df, status: 'in_transit' }),
    deliveriesRepo.count({ ...df, status: 'delivered' }),
    deliveriesRepo.count({ ...df, status: 'failed' }),
    deliveriesRepo.count({ ...df, status: 'cancelled' }),
    deliveriesRepo.count({ ...df, status: 'delivered', deliveredAt: { $gte: startOfToday } }),
    assignmentsRepo.count({ status: 'pending' }),
    providersRepo.count({}), providersRepo.count({ status: 'available' }), providersRepo.count({ status: 'busy' }),
    providersRepo.count({ status: 'pending' }), providersRepo.count({ status: 'suspended' }),
    zonesRepo.count({}), zonesRepo.count({ status: 'active' }),
    deliveryServicesRepo.count({}), deliveryServicesRepo.count({ status: 'active' }),
    routesRepo.count({}), routesRepo.count({ status: 'active' }),
    deliveriesRepo.countByLocationField('destination.zoneId'),
    shipmentsRepo.count({ status: { $in: ['planning', 'ready', 'dispatched', 'in_transit', 'arrived', 'receiving'] } }),
    shipmentsRepo.count({ status: 'ready' }),
    shipmentsRepo.count({ status: 'in_transit' }),
    shipmentsRepo.count({ status: 'arrived' }),
    shipmentsRepo.count({ status: 'receiving' })
  ]);

  const byZoneMap = {};
  for (const row of byZone) {
    if (row._id) byZoneMap[String(row._id)] = row.count;
  }

  return {
    activeDeliveries: active, pendingDeliveries: pending, assignedDeliveries: assigned,
    pickupDeliveries: pickup,
    inTransitDeliveries: inTransit, completedDeliveries: deliveredCount,
    failedDeliveries: failedCount, cancelledDeliveries: cancelledCount,
    deliveredToday, pendingAssignments,
    unassignedDeliveries: pending, availableProviders, busyProviders, totalProviders,
    pendingProviders, suspendedProviders,
    activeZones, totalZones, activeServices, totalServices, activeRoutes, totalRoutes,
    deliveriesByZone: byZoneMap,
    activeShipments, waitingForDispatchShipments, inTransitShipments, arrivedShipments, receivingShipments
  };
}

async function getDeliveryStatsByStatus() {
  const stats = {};
  await Promise.all(DELIVERY_STATUSES.map(async (s) => {
    stats[s] = await deliveriesRepo.countByStatus(s);
  }));
  return stats;
}

async function getRecentDeliveries(limit = 20) { return deliveriesRepo.findAll({}, { limit, sort: { createdAt: -1 } }); }

async function getExpansionStatus(locationId) {
  const location = await locationsRepo.findById(locationId);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const children = await locationsRepo.findChildren(locationId);
  const zones = await zonesRepo.findByLocationId(locationId);
  const activeZones = zones.filter((z) => z.status === 'active');
  let services = [];
  for (const zone of activeZones) {
    const svcs = await deliveryServicesRepo.findByZoneId(zone._id);
    services.push(...svcs);
  }
  const uniqueServices = [...new Map(services.map((s) => [s._id.toString(), s])).values()];
  let providers = [];
  for (const zone of activeZones) {
    const acts = await providersRepo.findByZone(zone._id);
    providers.push(...acts);
  }
  const routesFrom = await routesRepo.findByOrigin(locationId);
  const routesTo = await routesRepo.findByDestination(locationId);
  const ports = await portsRepo.findByLocationId(locationId);
  const ready = location.isActive && activeZones.length > 0 && uniqueServices.length > 0;
  return {
    location: { id: location._id, name: location.name, type: location.type, isActive: location.isActive },
    children: children.length, zones: { total: zones.length, active: activeZones.length },
    services: { total: uniqueServices.length, active: uniqueServices.filter((s) => s.status === 'active').length },
    routes: { total: routesFrom.length + routesTo.length, active: [...routesFrom, ...routesTo].filter((r) => r.status === 'active').length },
    ports: { total: ports.length, active: ports.filter((h) => h.status === 'active').length },
    ready,
  };
}

async function bulkActivate(locationId) {
  const location = await locationsRepo.findById(locationId);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const activated = { zones: 0, services: 0, providers: 0, routes: 0, ports: 0, location: false };
  if (!location.isActive) { await locationsRepo.activate(locationId); activated.location = true; }
  const zones = await zonesRepo.findByLocationId(locationId);
  for (const zone of zones) {
    if (zone.status !== 'active') { await zonesRepo.updateFields(zone._id, { status: 'active' }); activated.zones++; }
  }
  return activated;
}

async function bulkDeactivate(locationId) {
  const location = await locationsRepo.findById(locationId);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const deactivated = { zones: 0, location: false };
  const seen = new Set();
  const visit = async (id) => {
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    const children = await locationsRepo.findChildren(id);
    for (const child of children) await visit(child._id);
    const node = await locationsRepo.findById(id);
    if (node && node.isActive) { await locationsRepo.deactivate(id); deactivated.location = true; }
  };
  await visit(locationId);
  const zones = await zonesRepo.findByLocationId(locationId);
  for (const zone of zones) {
    if (zone.status === 'active') { await zonesRepo.updateFields(zone._id, { status: 'inactive' }); deactivated.zones++; }
  }
  return deactivated;
}

module.exports = {
  getDashboard, getDeliveryStatsByStatus, getRecentDeliveries,
  getExpansionStatus, bulkActivate, bulkDeactivate,
};
