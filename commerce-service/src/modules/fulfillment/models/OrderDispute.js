const mongoose = require('mongoose');

const orderDisputeSchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  initiator: { type: String, required: true },
  initiatorRole: { type: String, enum: ['BUYER', 'SELLER', 'ADMIN'] },
  evidence: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED'], default: 'OPEN', index: true },
  resolution: mongoose.Schema.Types.Mixed,
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  collection: 'order_disputes',
});

orderDisputeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('OrderDispute', orderDisputeSchema);
