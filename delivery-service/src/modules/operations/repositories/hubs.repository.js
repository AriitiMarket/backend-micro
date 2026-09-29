const Hub = require('../models/Hub');

async function findById(id) { return Hub.findById(id); }
async function create(data) { return Hub.create(data); }
async function updateFields(id, fields) { return Hub.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { name: 1 } } = options;
  return Hub.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Hub.countDocuments(filter); }
async function findActive() { return Hub.find({ status: 'active' }).sort({ name: 1 }); }
async function findByLocationId(locationId) { return Hub.find({ locationId, status: 'active' }); }
async function incrementLoad(id) { return Hub.findByIdAndUpdate(id, { $inc: { currentLoad: 1 } }, { new: true }); }
async function decrementLoad(id) { return Hub.findByIdAndUpdate(id, { $inc: { currentLoad: -1 } }, { new: true }); }

module.exports = {
  findById, create, updateFields, findAll, count, findActive,
  findByLocationId, incrementLoad, decrementLoad,
};
