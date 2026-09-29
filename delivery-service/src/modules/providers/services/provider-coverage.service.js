const providersRepo = require('../repositories/providers.repository');
const locationsRepo = require('../../locations-expansion/repositories/locations.repository');
const zonesRepo = require('../../locations-expansion/repositories/zones.repository');

// Admin controlled changes
async function updateCoverage(providerId, { serviceId, zoneIds, sectorId, hubId }, actor) {
  const provider = await providersRepo.findById(providerId);
  if (!provider) throw Object.assign(new Error('Provider not found'), { status: 404 });

  const fields = {};
  if (serviceId !== undefined) fields.serviceId = serviceId;
  if (sectorId !== undefined) fields.sectorId = sectorId;
  if (hubId !== undefined) fields.hubId = hubId;

  if (zoneIds !== undefined) {
    // Validate zones
    if (!Array.isArray(zoneIds)) throw Object.assign(new Error('zoneIds must be an array'), { status: 400 });
    
    // Deduplicate
    const uniqueZoneIds = [...new Set(zoneIds.map(String))];
    
    // Check if active
    for (const zid of uniqueZoneIds) {
      const z = await zonesRepo.findById(zid);
      if (!z) throw Object.assign(new Error(`Zone ${zid} not found`), { status: 404 });
      if (z.status !== 'active') throw Object.assign(new Error(`Zone ${zid} is inactive`), { status: 400 });
    }

    fields.zoneIds = uniqueZoneIds;
    if (uniqueZoneIds.length > 0) {
      fields.zoneId = uniqueZoneIds[0]; // Maintain legacy sync
    } else {
      fields.zoneId = null;
    }
  }

  return providersRepo.updateFields(providerId, fields);
}

module.exports = {
  updateCoverage
};
