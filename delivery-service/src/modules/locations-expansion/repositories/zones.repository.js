const mongoose = require('mongoose');
const Zone = require('../models/Zone');

function isValidId(id) {
  return id && id !== 'undefined' && id !== 'null' && mongoose.isValidObjectId(id);
}

async function findById(id) {
  if (!isValidId(id)) return null;
  return Zone.findById(id).populate('locationIds');
}
async function findByCode(code) { return Zone.findOne({ code }); }
async function create(data) { return Zone.create(data); }
async function updateFields(id, fields) {
  if (!isValidId(id)) return null;
  return Zone.findByIdAndUpdate(id, { $set: fields }, { new: true });
}
async function deleteZone(id) {
  if (!isValidId(id)) return null;
  return Zone.findByIdAndDelete(id);
}
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Zone.find(filter).sort(sort).skip(skip).limit(limit).populate('locationIds');
}
async function count(filter = {}) { return Zone.countDocuments(filter); }
async function findByLocationId(locationId) {
  if (!isValidId(locationId)) return [];
  return Zone.find({ locationIds: locationId, status: 'active' });
}
async function addLocation(zoneId, locationId) { return Zone.findByIdAndUpdate(zoneId, { $addToSet: { locationIds: locationId } }, { new: true }); }
async function removeLocation(zoneId, locationId) { return Zone.findByIdAndUpdate(zoneId, { $pull: { locationIds: locationId } }, { new: true }); }
async function findActive() { return Zone.find({ status: 'active' }).sort({ name: 1 }); }

module.exports = {
  findById, findByCode, create, updateFields, deleteZone, findAll, count,
  findByLocationId, addLocation, removeLocation, findActive,
};
