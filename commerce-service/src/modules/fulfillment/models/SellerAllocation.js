const mongoose = require('mongoose');

/**
 * SELLER ALLOCATION LEDGER — one row per seller per order (fulfillment group).
 *
 * The buyer makes ONE checkout and ONE payment, but the backend keeps a
 * separate seller-level record for every seller whose items are in the order.
 * This row is the authoritative answer to "how much does this seller get from
 * this order, and has it been settled?".
 *
 * Money model (all amounts in the order's currency, minor units NOT used —
 * ETB is the configured default and amounts are stored as decimal numbers):
 *
 *   grossSubtotal      = sum of this seller's priced line-item subtotals
 *   shippingFee        = delivery charge allocated to this seller
 *   taxAmount          = tax on this seller's lines
 *   discountAmount     = seller-specific discounts applied to this seller's lines
 *   platformCommission = platform's cut (configured commissionRate on grossSubtotal)
 *   netPayable         = grossSubtotal + shippingFee + tax - discount - commission
 *   refundAmount       = money refunded on this seller's lines (reduces netPayable)
 *   adjustmentAmount   = manual admin/seller adjustments (positive or negative)
 *   settledAmount      = amount already paid out to this seller
 *   pendingAmount      = netPayable - refunds - adjustments - settledAmount
 *
 * Reconciliation:
 *   sum(netPayable across all sellers in an order) + sum(platformCommission)
 *     == buyer payment amount (totalPrice)  [when tax/discount/provider-fees = 0]
 *
 * `status` tracks the allocation's lifecycle independent of the order lifecycle
 * and independent of whether the seller has been paid out (settlement).
 */
const sellerAllocationSchema = new mongoose.Schema({
  // Links back to the buyer order and (optionally) the payment transaction.
  orderId: { type: String, required: true, index: true },
  orderGroupId: { type: String, index: true, default: null },
  paymentId: { type: String, default: null, index: true },

  // The seller this row belongs to (enforced at query time — see service).
  sellerId: { type: String, required: true, index: true },
  shopId: { type: String, default: null, index: true },

  // --- Components (server-computed, never client-supplied) ---
  grossSubtotal: { type: Number, required: true, default: 0 },
  shippingFee: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  platformCommission: { type: Number, default: 0 },
  netPayable: { type: Number, required: true, default: 0 },

  // --- Adjustments / refunds (reduce what the seller is owed) ---
  refundAmount: { type: Number, default: 0 },
  adjustmentAmount: { type: Number, default: 0 },

  // --- Settlement tracking ---
  settledAmount: { type: Number, default: 0 },
  pendingAmount: { type: Number, default: 0 },
  settledAt: { type: Date, default: null },

  currency: { type: String, default: 'ETB' },
  status: {
    type: String,
    enum: ['PENDING', 'SETTLED', 'PARTIALLY_SETTLED', 'REFUNDED', 'CANCELLED'],
    default: 'PENDING',
    index: true,
  },

  // Idempotency: the allocation is computed exactly once per (order, seller)
  // unless explicitly recomputed. `computedAt` records when the ledger row was
  // last derived from a confirmed payment.
  computedAt: { type: Date, default: null },
  computationSource: { type: String, default: null }, // 'payment_confirmed', 'admin_recompute', 'refund'

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } });

// One allocation row per seller per order — prevents duplicate allocation.
sellerAllocationSchema.index({ orderId: 1, sellerId: 1 }, { unique: true });
sellerAllocationSchema.index({ orderGroupId: 1, status: 1 });
sellerAllocationSchema.index({ sellerId: 1, status: 1, createdAt: -1 });

sellerAllocationSchema.pre('save', function recomputeDerived(next) {
  const doc = this;
  const netPayable = Math.round(
    ((doc.grossSubtotal || 0) + (doc.shippingFee || 0) + (doc.taxAmount || 0)
      - (doc.discountAmount || 0) - (doc.platformCommission || 0)
      - (doc.refundAmount || 0) + (doc.adjustmentAmount || 0)) * 100
  ) / 100;
  doc.netPayable = netPayable;
  doc.pendingAmount = Math.round((netPayable - (doc.settledAmount || 0)) * 100) / 100;
  next();
});

module.exports = mongoose.model('SellerAllocation', sellerAllocationSchema);
