const DeliveryService = require('../models/DeliveryService');

async function findById(id) { return DeliveryService.findById(id); }
async function findByCode(code) { return DeliveryService.findOne({ code }); }
async function create(data) { return DeliveryService.create(data); }
async function updateFields(id, fields) { return DeliveryService.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return DeliveryService.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return DeliveryService.countDocuments(filter); }
async function findActive() { return DeliveryService.find({ status: 'active' }).sort({ name: 1 }); }
async function findByZoneId(zoneId) { return DeliveryService.find({ coverageZones: zoneId, status: 'active' }); }
async function addZone(serviceId, zoneId) { return DeliveryService.findByIdAndUpdate(serviceId, { $addToSet: { coverageZones: zoneId } }, { new: true }); }
async function removeZone(serviceId, zoneId) { return DeliveryService.findByIdAndUpdate(serviceId, { $pull: { coverageZones: zoneId } }, { new: true }); }
async function removeById(id) { return DeliveryService.findByIdAndDelete(id); }

module.exports = {
  findById, findByCode, create, updateFields, findAll, count,
  findActive, findByZoneId, addZone, removeZone, removeById,
};
