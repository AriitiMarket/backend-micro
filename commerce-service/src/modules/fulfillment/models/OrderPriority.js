const mongoose = require('mongoose');

const orderPrioritySchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true, unique: true },
  priority: { type: String, enum: ['NORMAL', 'HIGH', 'VIP', 'URGENT'], default: 'NORMAL', index: true },
  reason: { type: String },
  setBy: { type: String, required: true },
  markedAt: { type: Date, default: Date.now },
  resetAt: { type: Date, default: null },
}, {
  collection: 'order_priorities',
});

orderPrioritySchema.index({ priority: 1, markedAt: -1 });

module.exports = mongoose.model('OrderPriority', orderPrioritySchema);
