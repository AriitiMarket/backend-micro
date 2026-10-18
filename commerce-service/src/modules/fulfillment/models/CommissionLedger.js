/**
 * COMMISSION LEDGER MODEL
 * Immutable audit trail of commission calculations
 */

const mongoose = require('mongoose');

const commissionLedgerSchema = new mongoose.Schema({
  // Foreign keys
  orderId: { type: String, required: true, index: true },
  sellerId: { type: String, required: true, index: true },
  allocationId: { type: String, default: null },
  
  // Calculation breakdown
  grossSubtotal: { type: Number, required: true },
  shippingFee: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  
  // Commission calculation
  commissionRate: { type: Number, required: true }, // e.g., 10 for 10%
  platformCommission: { type: Number, required: true }, // Calculated amount
  
  // Result
  netPayable: { type: Number, required: true }, // Gross - Commission
  
  // Metadata
  reason: { type: String, default: 'ORDER_CONFIRMED', index: true },
  metadata: mongoose.Schema.Types.Mixed,
  
  // Timestamp (immutable)
  timestamp: { type: Date, default: Date.now, index: true },
}, {
  collection: 'commission_ledger',
});

// Prevent updates (enforce immutability)
commissionLedgerSchema.pre('updateOne', function(next) {
  const err = new Error('Commission ledger entries are immutable');
  err.statusCode = 403;
  next(err);
});

commissionLedgerSchema.pre('findByIdAndUpdate', function(next) {
  const err = new Error('Commission ledger entries are immutable');
  err.statusCode = 403;
  next(err);
});

// Indexes
commissionLedgerSchema.index({ orderId: 1, timestamp: -1 });
commissionLedgerSchema.index({ sellerId: 1, timestamp: -1 });
commissionLedgerSchema.index({ timestamp: -1 });
commissionLedgerSchema.index({ reason: 1, timestamp: -1 });

module.exports = mongoose.model('CommissionLedger', commissionLedgerSchema);
