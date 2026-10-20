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
  commissionRateApplied: { type: Number, required: true }, // Rate actually applied (from settings)
  platformCommission: { type: Number, required: true }, // Calculated amount

  // Result
  netPayable: { type: Number, required: true }, // Gross - Commission

  // Effective dating for audit
  effectiveFrom: { type: Date, default: Date.now, index: true }, // When this rate was in force

  // Actor audit trail (who, why, when)
  //
  // `actorId` is the identity-service user id, which is a STRING (a UUID) —
  // not a Mongo ObjectId. It used to be typed as ObjectId, so
  // `logCommission()` threw "Cast to ObjectId failed for value \"admin-1\""
  // on every call and the commission ledger — the audit trail of every
  // commission calculation — never recorded a single row.
  actorId: { type: String, default: null, index: true },
  actorRole: { type: String, enum: ['SYSTEM', 'ADMIN', 'SELLER', 'BUYER'], default: 'SYSTEM' },
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
