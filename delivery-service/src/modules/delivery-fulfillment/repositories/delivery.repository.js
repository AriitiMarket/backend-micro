const Delivery = require('../models/Delivery');

async function findById(id) { return Delivery.findById(id); }
async function findByOrderId(orderId) { return Delivery.findOne({ orderId }); }
async function create(data) { return Delivery.create(data); }
async function updateFields(id, fields) { return Delivery.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { createdAt: -1 } } = options;
  return Delivery.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Delivery.countDocuments(filter); }
async function findByStatus(status) { return Delivery.find({ status }).sort({ createdAt: -1 }); }
async function findByProviderId(providerId) {
  return Delivery.find({ providerId, status: { $in: ['assigned', 'pickup', 'in_transit'] } }).sort({ createdAt: -1 });
}
async function findBySellerId(sellerId) { return Delivery.find({ sellerId }).sort({ createdAt: -1 }); }
async function findByBuyerId(buyerId) { return Delivery.find({ buyerId }).sort({ createdAt: -1 }); }
async function findActive() { return Delivery.find({ status: { $in: ['pending', 'assigned', 'pickup', 'in_transit'] } }); }
async function findByOrderIds(orderIds = []) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
  return Delivery.find({ orderId: { $in: orderIds } }).lean();
}
async function countByStatus(status) { return Delivery.countDocuments({ status }); }
async function countByLocationField(field) {
  return Delivery.aggregate([
    { $match: { [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
}

async function updateMany(filter, update) {
  return Delivery.updateMany(filter, update);
}

module.exports = {
  updateMany,
  findById, findByOrderId, create, updateFields, findAll, count,
  findByStatus, findByProviderId, findBySellerId, findByBuyerId,
  findActive, findByOrderIds, countByStatus, countByLocationField,
};
