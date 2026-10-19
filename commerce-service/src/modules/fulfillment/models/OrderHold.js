/**
 * ORDER HOLD MODEL
 */

const mongoose = require('mongoose');

const orderHoldSchema = new mongoose.Schema({
  // Foreign key
  orderId: { type: String, required: true, index: true },
  
  // Hold metadata
  reason: { type: String, required: true },
  holdByRole: { type: String, enum: ['ADMIN', 'SELLER', 'SYSTEM'], default: 'SYSTEM' },
  heldByUserId: { type: String, required: true },
  
  // Release metadata
  releasedAt: { type: Date, default: null },
  releaseReason: { type: String, default: null },
  releasedByUserId: { type: String, default: null },
  
  // Timestamps
  heldAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'order_holds',
});

// Indexes
orderHoldSchema.index({ orderId: 1, heldAt: -1 });
orderHoldSchema.index({ releasedAt: 1 }); // For finding active holds

module.exports = mongoose.model('OrderHold', orderHoldSchema);
