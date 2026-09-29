const DeliveryRoute = require('../models/DeliveryRoute');

async function findById(id) { return DeliveryRoute.findById(id).populate('originLocationId destinationLocationId'); }
async function create(data) { return DeliveryRoute.create(data); }
async function updateFields(id, fields) { return DeliveryRoute.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function deleteRoute(id) { return DeliveryRoute.findByIdAndDelete(id); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return DeliveryRoute.find(filter).sort(sort).skip(skip).limit(limit).populate('originLocationId destinationLocationId');
}
async function count(filter = {}) { return DeliveryRoute.countDocuments(filter); }
async function findActive() { return DeliveryRoute.find({ status: 'active' }).sort({ name: 1 }); }
async function findByOrigin(originLocationId) { return DeliveryRoute.find({ originLocationId, status: 'active' }); }
async function findByDestination(destinationLocationId) { return DeliveryRoute.find({ destinationLocationId, status: 'active' }); }
async function findByEndpoints(originLocationId, destinationLocationId) {
  return DeliveryRoute.findOne({ originLocationId, destinationLocationId, status: 'active' });
}
async function findAnyByEndpoints(originLocationId, destinationLocationId) {
  return DeliveryRoute.findOne({ originLocationId, destinationLocationId });
}

module.exports = {
  findById, create, updateFields, deleteRoute, findAll, count, findActive,
  findByOrigin, findByDestination, findByEndpoints, findAnyByEndpoints,
};
