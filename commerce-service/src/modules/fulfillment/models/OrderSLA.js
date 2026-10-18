const mongoose = require('mongoose');

const orderSLASchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  stateName: { type: String, required: true },
  durationHours: { type: Number, required: true },
  deadline: { type: Date, required: true, index: true },
  setBy: { type: String, required: true },
  completedAt: { type: Date, default: null },
  breached: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'order_slas',
});

orderSLASchema.index({ deadline: 1, breached: 1 });

module.exports = mongoose.model('OrderSLA', orderSLASchema);
