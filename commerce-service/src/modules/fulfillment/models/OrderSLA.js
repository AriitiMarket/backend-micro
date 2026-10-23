const mongoose = require('mongoose');

const orderSLASchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  stateName: { type: String, required: true },
  durationHours: { type: Number, required: true },
  deadline: { type: Date, required: true, index: true },
  setBy: { type: String, required: true },
  completedAt: { type: Date, default: null },
  breached: { type: Boolean, default: false },
  // Breach audit trail. A breach is either DETECTED (the deadline passed on
  // its own) or PUSHED IN by an operator (a dispute upheld, a mis-declared
  // deadline), so the record has to say WHEN it was missed, WHY, and WHO
  // recorded it — otherwise the SLA dashboard cannot be audited.
  breachedAt: { type: Date, default: null },
  breachReason: { type: String, default: null },
  breachedBy: { type: String, default: null },
  breachSource: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'order_slas',
});

orderSLASchema.index({ deadline: 1, breached: 1 });
// The dashboard lists breaches by WHEN they happened, not by when the SLA was
// created — an SLA set three weeks ago that was only breached yesterday still
// belongs in "the last 7 days".
orderSLASchema.index({ breached: 1, breachedAt: -1 });

module.exports = mongoose.model('OrderSLA', orderSLASchema);
