const Delivery = require('../models/Delivery');
const {
  ACTIVE_DELIVERY_STATUSES,
  IN_PROGRESS_DELIVERY_STATUSES,
} = require('../../../shared/constants');

async function findById(id) { return Delivery.findById(id); }
async function findByOrderId(orderId) { return Delivery.findOne({ orderId }); }
async function create(data) {
  if (!data.deliveryRef) data = { ...data, deliveryRef: await nextDeliveryRef() };
  return Delivery.create(data);
}

/**
 * The next readable reference: DEL-1001, DEL-1002, …
 *
 * Counters are atomic, so two concurrent handoffs can never mint the same
 * reference (the unique sparse index is the second line of defence).
 */
async function nextDeliveryRef() {
  const counter = await Delivery.collection.findOneAndUpdate(
    { _id: 'delivery-ref' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `DEL-${counter.seq}`;
}
async function updateFields(id, fields) { return Delivery.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { createdAt: -1 } } = options;
  return Delivery.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return Delivery.countDocuments(filter); }
async function findByStatus(status) { return Delivery.find({ status }).sort({ createdAt: -1 }); }
async function findByProviderId(providerId) {
  // A rider's live workload: assigned/being collected/with the rider. The
  // transient `reassigned` state is excluded on purpose — it is the handover
  // marker, not a parcel the rider is carrying.
  return Delivery.find({ providerId, status: { $in: ['assigned', 'pickup', 'in_transit'] } }).sort({ createdAt: -1 });
}
async function findBySellerId(sellerId) { return Delivery.find({ sellerId }).sort({ createdAt: -1 }); }
async function findByBuyerId(buyerId) { return Delivery.find({ buyerId }).sort({ createdAt: -1 }); }
/** Every delivery still moving — the canonical active set, not a local list. */
async function findActive() { return Delivery.find({ status: { $in: ACTIVE_DELIVERY_STATUSES } }); }

/** Every delivery a rider physically holds right now. */
async function findInProgress() { return Delivery.find({ status: { $in: IN_PROGRESS_DELIVERY_STATUSES } }); }
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
  nextDeliveryRef,
  updateMany,
  findById, findByOrderId, create, updateFields, findAll, count,
  findByStatus, findByProviderId, findBySellerId, findByBuyerId,
  findActive, findInProgress, findByOrderIds, countByStatus, countByLocationField,
};
