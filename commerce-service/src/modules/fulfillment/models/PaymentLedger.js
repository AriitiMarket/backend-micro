/**
 * PAYMENT LEDGER MODEL
 * Immutable audit trail (append-only, no updates/deletes)
 */

const mongoose = require('mongoose');

const paymentLedgerSchema = new mongoose.Schema({
  // Foreign keys
  paymentId: { type: String, required: true, index: true },
  orderId: { type: String, default: null, index: true },
  userId: { type: String, default: null },
  sellerId: { type: String, default: null },
  
  // State transition
  oldStatus: { type: String, required: true },
  newStatus: { type: String, required: true, index: true },
  
  // Payment details
  amount: { type: Number, required: true },
  currency: { type: String, default: 'ETB' },
  
  // Who changed it
  actor: { type: String, required: true },
  actorType: { type: String, enum: ['SYSTEM', 'ADMIN', 'USER', 'PROVIDER'], default: 'SYSTEM' },
  reason: { type: String, default: '' },
  
  // Provider details (if applicable)
  transactionId: { type: String, default: null },
  providerResponse: mongoose.Schema.Types.Mixed,
  
  // Timestamp (immutable)
  timestamp: { type: Date, default: Date.now, index: true },
}, {
  collection: 'payment_ledger',
});

// Prevent updates/deletes (enforce immutability)
paymentLedgerSchema.pre('updateOne', function(next) {
  const err = new Error('Payment ledger entries are immutable');
  err.statusCode = 403;
  next(err);
});

paymentLedgerSchema.pre('findByIdAndUpdate', function(next) {
  const err = new Error('Payment ledger entries are immutable');
  err.statusCode = 403;
  next(err);
});

// Indexes for common queries
paymentLedgerSchema.index({ paymentId: 1, timestamp: -1 });
paymentLedgerSchema.index({ orderId: 1, timestamp: -1 });
paymentLedgerSchema.index({ newStatus: 1, timestamp: -1 });
paymentLedgerSchema.index({ timestamp: -1 });

module.exports = mongoose.model('PaymentLedger', paymentLedgerSchema);
