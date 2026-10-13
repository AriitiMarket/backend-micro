const Port = require('../models/Port');

async function findById(id) { return Port.findById(id); }
async function create(data) { return Port.create(data); }
async function updateFields(id, fields) { return Port.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Port.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Port.countDocuments(filter); }
async function findActive() { return Port.find({ status: 'active' }).sort({ name: 1 }); }
async function findByLocationId(locationId) { return Port.find({ locationId, status: 'active' }); }
async function findActiveByZoneId(zoneId) { return Port.find({ zoneId, status: 'active' }).sort({ name: 1 }); }
async function incrementLoad(id) { return Port.findByIdAndUpdate(id, { $inc: { currentLoad: 1 } }, { new: true }); }
async function decrementLoad(id) { return Port.findByIdAndUpdate(id, { $inc: { currentLoad: -1 } }, { new: true }); }

module.exports = {
  findById, create, updateFields, findAll, count, findActive,
  findByLocationId, findActiveByZoneId, incrementLoad, decrementLoad,
};
