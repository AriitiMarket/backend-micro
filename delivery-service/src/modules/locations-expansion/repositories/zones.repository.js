const Zone = require('../models/Zone');

async function findById(id) { return Zone.findById(id).populate('locationIds'); }
async function findByCode(code) { return Zone.findOne({ code }); }
async function create(data) { return Zone.create(data); }
async function updateFields(id, fields) { return Zone.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function deleteZone(id) { return Zone.findByIdAndDelete(id); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Zone.find(filter).sort(sort).skip(skip).limit(limit).populate('locationIds');
}
async function count(filter = {}) { return Zone.countDocuments(filter); }
async function findByLocationId(locationId) { return Zone.find({ locationIds: locationId, status: 'active' }); }
async function addLocation(zoneId, locationId) { return Zone.findByIdAndUpdate(zoneId, { $addToSet: { locationIds: locationId } }, { new: true }); }
async function removeLocation(zoneId, locationId) { return Zone.findByIdAndUpdate(zoneId, { $pull: { locationIds: locationId } }, { new: true }); }
async function findActive() { return Zone.find({ status: 'active' }).sort({ name: 1 }); }

module.exports = {
  findById, findByCode, create, updateFields, deleteZone, findAll, count,
  findByLocationId, addLocation, removeLocation, findActive,
};
