const mongoose = require('mongoose');

/**
 * FIX #9: Return Request Workflow
 * Tracks customer return requests from creation to refund
 */
const returnSchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  buyerId: { type: String, required: true, index: true },
  sellerId: { type: String, required: true, index: true },
  shopId: { type: String, default: null },
  
  // Return details
  reason: {
    type: String,
    enum: ['DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'DEFECTIVE', 'OTHER'],
    required: true
  },
  description: { type: String, required: true, maxlength: 1000 },
  images: [{ type: String }], // S3/upload URLs for evidence photos
  
  // Return items (may be partial return)
  items: [{
    _id: false,
    productId: { type: String, required: true },
    productName: { type: String },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    subtotal: { type: Number, required: true }
  }],
  
  // Return amount
  returnAmount: { type: Number, required: true }, // Total refund amount
  originalOrderAmount: { type: Number, required: true },
  
  // Pickup arrangement
  pickupRequired: { type: Boolean, default: true },
  pickupArranged: { type: Boolean, default: false },
  pickupDate: { type: Date, default: null },
  pickupAddress: { type: String, default: null },
  
  // Status flow: REQUESTED → APPROVED → PICKED_UP → RETURNED → REFUNDED
  status: {
    type: String,
    enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PICKED_UP', 'RETURNED', 'REFUNDED'],
    default: 'REQUESTED',
    index: true
  },
  
  // Timeline
  requestedAt: { type: Date, default: Date.now },
  approvedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  pickedUpAt: { type: Date, default: null },
  returnedAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  
  // Admin notes
  adminNotes: { type: String, default: '' },
  rejectionReason: { type: String, default: '' },
  
  // Refund tracking
  refundStatus: { type: String, enum: ['PENDING', 'PROCESSED', 'FAILED'], default: 'PENDING' },
  refundPaymentId: { type: String, default: null },
  refundProcessedAt: { type: Date, default: null },
  
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

// Index for common queries
returnSchema.index({ orderId: 1, buyerId: 1 });
returnSchema.index({ sellerId: 1, status: 1 });
returnSchema.index({ buyerId: 1, status: 1 });
returnSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Return', returnSchema);
