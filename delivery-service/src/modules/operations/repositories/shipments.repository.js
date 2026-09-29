const Shipment = require('../models/Shipment');

async function create(data) {
  const shipment = new Shipment(data);
  return shipment.save();
}

async function findById(id) {
  return Shipment.findById(id);
}

async function findAll(filter = {}, options = {}) {
  const { skip = 0, limit = 50, sort = { createdAt: -1 } } = options;
  return Shipment.find(filter).sort(sort).skip(skip).limit(limit);
}

async function count(filter = {}) {
  return Shipment.countDocuments(filter);
}

async function updateFields(id, fields) {
  return Shipment.findByIdAndUpdate(id, { $set: fields }, { new: true });
}

async function pushHistory(id, historyEntry) {
  return Shipment.findByIdAndUpdate(id, { $push: { history: historyEntry } }, { new: true });
}

async function pushItem(id, item) {
  return Shipment.findByIdAndUpdate(id, { 
    $push: { items: item },
    $inc: { 'capacity.usedWeight': item.weight || 0, 'capacity.usedItems': 1 }
  }, { new: true });
}

async function pullItem(id, deliveryId, weight) {
  return Shipment.findByIdAndUpdate(id, {
    $pull: { items: { deliveryId } },
    $inc: { 'capacity.usedWeight': -(weight || 0), 'capacity.usedItems': -1 }
  }, { new: true });
}

/** Rollback helper: a consolidation that lost the claim race removes its shipment. */
async function removeById(id) {
  return Shipment.findByIdAndDelete(id);
}

module.exports = {
  create,
  findById,
  findAll,
  count,
  updateFields,
  pushHistory,
  pushItem,
  pullItem,
  removeById
};
