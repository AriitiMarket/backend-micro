const mongoose = require('mongoose');

/**
 * SETTLEMENT (PAYOUT) RECORD — money paid out to a seller for one or more
 * allocations.
 *
 * A successful buyer payment does NOT automatically mean a seller has been paid
 * out. Settlement is a separate, explicit action (manual admin payout or a
 * payment-provider payout when that is configured). This row records what was
 * paid, when, and under what reference, so "settled vs pending" is never
 * inferred from the payment status alone.
 *
 * Idempotency: `reference` (provider payout id or admin batch id) is unique so
 * the same payout can never be recorded twice.
 */
const settlementSchema = new mongoose.Schema({
  sellerId: { type: String, required: true, index: true },

  // The allocations this settlement pays for (may be several order allocations
  // batched into one payout).
  allocationIds: [{ type: String, index: true }],

  amount: { type: Number, required: true }, // amount paid to the seller
  currency: { type: String, default: 'ETB' },

  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
    default: 'PENDING',
    index: true,
  },

  // Provider payout reference / admin batch id — unique to prevent double payout.
  reference: { type: String, default: null, unique: true, sparse: true },
  provider: { type: String, default: null }, // e.g. 'COD', 'TELEBIRR', 'manual'

  paidAt: { type: Date, default: null },
  // Who initiated/approved the settlement (admin id when manual).
  initiatedBy: { type: String, default: null },
  initiatedByRole: { type: String, default: null },
  reason: { type: String, default: null },
  failureReason: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } });

settlementSchema.index({ sellerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
