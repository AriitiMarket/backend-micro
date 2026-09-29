const zonesRepo = require('../repositories/zones.repository');
const locationsService = require('./locations.service');

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

module.exports = {
  createZone, getZone, updateZone, deleteZone, getZones, countZones, getActiveZones, getZoneStats,
  addLocationToZone, removeLocationFromZone, findZoneForLocation, checkCoverage,
};
