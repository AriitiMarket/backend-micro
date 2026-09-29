const SectorAvailability = require('../models/SectorAvailability');

async function findByLocation(locationId) { return SectorAvailability.find({ locationId }).sort({ sectorName: 1 }).lean(); }
async function findByLocationAndSector(locationId, sectorId) { return SectorAvailability.findOne({ locationId, sectorId }).lean(); }
async function findByLocationIds(locationIds = []) {
  if (!locationIds.length) return [];
  return SectorAvailability.find({ locationId: { $in: locationIds } }).lean();
}
async function count(filter = {}) { return SectorAvailability.countDocuments(filter); }
async function upsert({ locationId, sectorId, sectorName, isActive, deliveryAvailable, pickupAvailable, notes, updatedBy }) {
  const update = {};
  if (sectorName !== undefined) update.sectorName = sectorName;
  if (isActive !== undefined) update.isActive = isActive;
  if (deliveryAvailable !== undefined) update.deliveryAvailable = deliveryAvailable;
  if (pickupAvailable !== undefined) update.pickupAvailable = pickupAvailable;
  if (notes !== undefined) update.notes = notes;
  update.updatedBy = updatedBy || null;
  return SectorAvailability.findOneAndUpdate(
    { locationId, sectorId },
    { $set: update, $setOnInsert: { locationId, sectorId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
}
async function remove(locationId, sectorId) { return SectorAvailability.findOneAndDelete({ locationId, sectorId }).lean(); }

module.exports = { findByLocation, findByLocationAndSector, findByLocationIds, count, upsert, remove };
