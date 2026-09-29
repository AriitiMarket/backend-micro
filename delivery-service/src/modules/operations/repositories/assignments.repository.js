const Assignment = require('../models/Assignment');

async function findById(id) { return Assignment.findById(id); }
async function create(data) { return Assignment.create(data); }
async function updateFields(id, fields) { return Assignment.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findByDeliveryId(deliveryId) { return Assignment.find({ deliveryId }).sort({ assignedAt: -1 }); }
async function findActiveByDeliveryId(deliveryId) {
  return Assignment.find({ deliveryId, status: { $in: ['pending', 'accepted'] } });
}
async function findActiveByDeliveryIds(deliveryIds = []) {
  if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) return [];
  return Assignment.find({ deliveryId: { $in: deliveryIds }, status: { $in: ['pending', 'accepted'] } });
}
async function findActiveByProviderId(providerId) { return Assignment.find({ providerId, status: { $in: ['pending', 'accepted'] } }); }
async function findPendingExpired() { return Assignment.find({ status: 'pending', expiresAt: { $lt: new Date() } }); }
async function cancelActiveByDelivery(deliveryId) {
  return Assignment.updateMany(
    { deliveryId, status: { $in: ['pending', 'accepted'] } },
    { $set: { status: 'cancelled', respondedAt: new Date() } },
  );
}
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { assignedAt: -1 } } = options;
  return Assignment.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Assignment.countDocuments(filter); }

module.exports = {
  findById, create, updateFields, findByDeliveryId, findActiveByDeliveryId,
  findActiveByDeliveryIds, findActiveByProviderId, findPendingExpired,
  cancelActiveByDelivery, findAll, count,
};
