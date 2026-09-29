const deliveryServicesRepo = require('../repositories/deliveryServices.repository');
const zonesService = require('./zones.service');

async function createService(data) {
  if (data.code) {
    const existing = await deliveryServicesRepo.findByCode(data.code);
    if (existing) throw Object.assign(new Error('Service code already exists'), { status: 409 });
  }
  if (data.coverageZones && data.coverageZones.length > 0) {
    for (const zoneId of data.coverageZones) await zonesService.getZone(zoneId);
  }
  return deliveryServicesRepo.create(data);
}

async function getService(id) {
  const svc = await deliveryServicesRepo.findById(id);
  if (!svc) throw Object.assign(new Error('Delivery service not found'), { status: 404 });
  return svc;
}

async function updateService(id, fields) { await getService(id); return deliveryServicesRepo.updateFields(id, fields); }
async function getServices(filter = {}, options = {}) { return deliveryServicesRepo.findAll(filter, options); }
async function countServices(filter = {}) { return deliveryServicesRepo.count(filter); }
async function deleteService(id) { await getService(id); return deliveryServicesRepo.removeById(id); }
async function getActiveServices() { return deliveryServicesRepo.findActive(); }
async function addZone(serviceId, zoneId) { await getService(serviceId); await zonesService.getZone(zoneId); return deliveryServicesRepo.addZone(serviceId, zoneId); }
async function removeZone(serviceId, zoneId) { await getService(serviceId); return deliveryServicesRepo.removeZone(serviceId, zoneId); }
async function findServicesForZone(zoneId) { return deliveryServicesRepo.findByZoneId(zoneId); }

async function findServiceForDelivery(pickupLocationId, destinationLocationId) {
  const destZones = await zonesService.findZoneForLocation(destinationLocationId);
  if (destZones.length === 0) throw Object.assign(new Error('No delivery zone covers the destination'), { status: 404 });
  for (const zone of destZones) {
    const services = await deliveryServicesRepo.findByZoneId(zone._id);
    if (services.length > 0) return { zone, services };
  }
  throw Object.assign(new Error('No delivery service available for this route'), { status: 404 });
}

module.exports = {
  createService, getService, updateService, getServices, countServices, deleteService, getActiveServices,
  addZone, removeZone, findServicesForZone, findServiceForDelivery,
};
