const DeliveryRequest = require('../models/DeliveryRequest');

async function findById(id) { return DeliveryRequest.findById(id); }
async function findByOrderId(orderId) { return DeliveryRequest.findOne({ orderId }); }
async function create(data) { return DeliveryRequest.create(data); }
async function updateFields(id, fields) { return DeliveryRequest.findByIdAndUpdate(id, { $set: fields }, { new: true }); }
async function findAll(filter = {}, options = {}) {
  const { limit = 100, skip = 0, sort = { createdAt: -1 } } = options;
  return DeliveryRequest.find(filter).sort(sort).skip(skip).limit(limit);
}
async function count(filter = {}) { return DeliveryRequest.countDocuments(filter); }
async function findBySellerId(sellerId) { return DeliveryRequest.find({ sellerId }).sort({ createdAt: -1 }); }
async function findByBuyerId(buyerId) { return DeliveryRequest.find({ buyerId }).sort({ createdAt: -1 }); }

module.exports = { findById, findByOrderId, create, updateFields, findAll, count, findBySellerId, findByBuyerId };
