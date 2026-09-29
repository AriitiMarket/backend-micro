const repo = require('../repositories/sectorAvailability.repository');
const locationsRepo = require('../repositories/locations.repository');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

async function listForLocation(locationId) {
  if (!isValidObjectId(locationId)) throw Object.assign(new Error('Invalid location id'), { status: 400 });
  const location = await locationsRepo.findById(locationId);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const [availability, summary] = await Promise.all([repo.findByLocation(locationId), summarize(locationId)]);
  return {
    location: { id: location._id, name: location.name, type: location.type, isActive: location.isActive, parentId: location.parentId },
    sectors: availability.map(toDto), summary,
  };
}

function toDto(row) {
  return {
    sectorId: row.sectorId, sectorName: row.sectorName, isActive: row.isActive,
    deliveryAvailable: row.deliveryAvailable, pickupAvailable: row.pickupAvailable,
    notes: row.notes, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
  };
}

async function summarize(locationId) {
  const filter = locationId ? { locationId } : {};
  const [total, active, delivery, pickup] = await Promise.all([
    repo.count(filter), repo.count({ ...filter, isActive: true }),
    repo.count({ ...filter, deliveryAvailable: true }), repo.count({ ...filter, pickupAvailable: true }),
  ]);
  return { total, active, inactive: total - active, deliveryAvailable: delivery, pickupAvailable: pickup };
}

async function setAvailability(locationId, sectorId, payload = {}, adminId = null) {
  if (!isValidObjectId(locationId)) throw Object.assign(new Error('Invalid location id'), { status: 400 });
  if (!sectorId) throw Object.assign(new Error('Sector id is required'), { status: 400 });
  const location = await locationsRepo.findById(locationId);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const previous = await repo.findByLocationAndSector(locationId, sectorId);
  const saved = await repo.upsert({
    locationId, sectorId, sectorName: payload.sectorName, isActive: payload.isActive,
    deliveryAvailable: payload.deliveryAvailable, pickupAvailable: payload.pickupAvailable,
    notes: payload.notes, updatedBy: adminId,
  });
  return { previous: previous ? toDto(previous) : null, current: toDto(saved) };
}

async function removeAvailability(locationId, sectorId) {
  if (!isValidObjectId(locationId)) throw Object.assign(new Error('Invalid location id'), { status: 400 });
  const removed = await repo.remove(locationId, sectorId);
  if (!removed) throw Object.assign(new Error('Sector availability not found'), { status: 404 });
  return toDto(removed);
}

async function getSummary(locationId) { return summarize(locationId); }

module.exports = { listForLocation, setAvailability, removeAvailability, getSummary };
