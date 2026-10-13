const zonesRepo = require('../repositories/zones.repository');
const locationsService = require('./locations.service');
const portsRepo = require('../../operations/repositories/ports.repository');

async function createZone(data) {
  if (data.code) {
    const existing = await zonesRepo.findByCode(data.code);
    if (existing) throw Object.assign(new Error('Zone code already exists'), { status: 409 });
  }
  if (data.locationIds && data.locationIds.length > 0) {
    for (const locId of data.locationIds) {
      const loc = await locationsService.getLocation(locId);
      if (!loc.isActive) throw Object.assign(new Error(`Location ${locId} is inactive`), { status: 400 });
    }
  }
  return zonesRepo.create(data);
}

async function getZone(id) {
  const zone = await zonesRepo.findById(id);
  if (!zone) throw Object.assign(new Error('Zone not found'), { status: 404 });
  return zone;
}

async function updateZone(id, fields) { 
  await getZone(id); 
  return zonesRepo.updateFields(id, fields); 
}

async function deleteZone(id) {
  await getZone(id);
  return zonesRepo.deleteZone(id);
}

async function getZones(filter = {}, options = {}) { return zonesRepo.findAll(filter, options); }
async function countZones(filter = {}) { return zonesRepo.count(filter); }
async function getActiveZones() { return zonesRepo.findActive(); }

async function addLocationToZone(zoneId, locationId) {
  await getZone(zoneId);
  const loc = await locationsService.getLocation(locationId);
  if (!loc.isActive) throw Object.assign(new Error('Location is inactive'), { status: 400 });
  return zonesRepo.addLocation(zoneId, locationId);
}

async function removeLocationFromZone(zoneId, locationId) { await getZone(zoneId); return zonesRepo.removeLocation(zoneId, locationId); }
async function findZoneForLocation(locationId) { return zonesRepo.findByLocationId(locationId); }

async function checkCoverage(locationId) {
  const zones = await zonesRepo.findByLocationId(locationId);
  return { covered: zones.length > 0, zones: zones.map((z) => ({ id: z._id, name: z.name, code: z.code })) };
}

async function getZoneStats() {
  const allZones = await zonesRepo.findAll({});
  const activeZones = allZones.filter(z => z.status === 'active');
  const serviceableZones = allZones.filter(z => z.deliveryRules?.serviceable);
  const unassignedZones = allZones.filter(z => !z.locationIds || z.locationIds.length === 0);
  
  return {
    totalZones: allZones.length,
    activeZones: activeZones.length,
    serviceableZones: serviceableZones.length,
    unassignedZones: unassignedZones.length,
    zonesWithActiveRoutes: 0, // Will be calculated with route integration
  };
}

/** Centralized zone resolution: by explicit zoneId, else by location. */
async function resolveDeliveryArea({ zoneId, locationId } = {}) {
  if (zoneId) {
    const zone = await getZone(zoneId).catch(() => null);
    return zone || null;
  }
  if (locationId) {
    const zones = await findZoneForLocation(locationId);
    return zones && zones.length > 0 ? zones[0] : null;
  }
  return null;
}

/**
 * One serviceability verdict for the whole module — Requests, Deliveries and
 * Controllers must NOT reimplement these checks.
 */
function getZoneRequestability(zone, now = new Date()) {
  if (!zone) return { serviceable: false, reason: 'ZONE_NOT_FOUND' };
  if (zone.status === 'inactive' || zone.status === 'suspended') return { serviceable: false, reason: 'ZONE_NOT_AVAILABLE' };
  const lifecycle = zone.lifecycle || 'LIVE';
  if (lifecycle === 'PAUSED') return { serviceable: false, reason: 'ZONE_PAUSED' };
  if (lifecycle === 'DRAFT') return { serviceable: false, reason: 'ZONE_NOT_READY' };
  if (lifecycle === 'READY') return { serviceable: false, reason: 'ZONE_NOT_LIVE' };
  if (zone.deliveryRules && zone.deliveryRules.serviceable === false) return { serviceable: false, reason: 'SERVICE_NOT_AVAILABLE' };
  const hours = zone.operationalRules?.operatingHours;
  if (hours && hours.open && hours.close) {
    const hh = now.getHours() * 60 + now.getMinutes();
    const [oh, om] = hours.open.split(':').map(Number);
    const [ch, cm] = hours.close.split(':').map(Number);
    if (Number.isFinite(oh) && Number.isFinite(ch) && (hh < oh * 60 + om || hh > ch * 60 + cm)) {
      return { serviceable: false, reason: 'OUTSIDE_SERVICE_HOURS' };
    }
  }
  return { serviceable: true, reason: null };
}

/**
 * The Port that serves a Zone. One rule, used by every caller: a Zone may hold
 * several known local points, and the first ACTIVE one is the one that serves
 * new deliveries (the customer never picks a port).
 */
async function resolveZonePort(zoneId) {
  if (!zoneId) return null;
  const ports = await portsRepo.findActiveByZoneId(zoneId);
  return ports && ports.length > 0 ? ports[0] : null;
}

async function assertZoneRequestable(zone, now = new Date()) {
  const verdict = getZoneRequestability(zone, now);
  if (!verdict.serviceable) {
    throw Object.assign(new Error(`Zone not serviceable: ${verdict.reason}`), { status: 400, code: verdict.reason });
  }
  return verdict;
}

module.exports = {
  createZone, getZone, updateZone, deleteZone, getZones, countZones, getActiveZones, getZoneStats,
  addLocationToZone, removeLocationFromZone, findZoneForLocation, checkCoverage,
  resolveDeliveryArea, getZoneRequestability, assertZoneRequestable, resolveZonePort,
};
