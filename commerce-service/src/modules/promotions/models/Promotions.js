const mongoose = require('mongoose');

/**
 * Promotion — a commercial offer/campaign owned by one shop or platform-wide.
 *
 * Promotions are deliberately separate from the catalog and from events: a
 * promotion does not change a product's price, it advertises an offer that the
 * shop runs for a period of time.
 *
 * Promotions can now include promo codes for buyer entry during checkout.
 */
const promotionSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  // Denormalised snapshot so a listing can render the shop name without a join.
  shop: {
    _id: { type: String },
    name: { type: String },
  },
  title: { type: String, required: [true, 'Please enter a promotion title!'] },
  description: { type: String, default: '' },

  // Promo code - unique alphanumeric code for buyer entry
  code: { type: String, unique: true, sparse: true, index: true },

  // Discount configuration
  discountType: { type: String, enum: ['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY'], default: 'PERCENTAGE' },
  discountPercent: { type: Number, min: 0, max: 100, default: null },
  fixedAmount: { type: Number, min: 0, default: null },
  maxDiscountAmount: { type: Number, min: 0, default: null }, // Cap for percentage discounts

  // Eligibility rules
  minPurchaseAmount: { type: Number, min: 0, default: 0 },
  eligibleProductIds: [{ type: String }],
  eligibleCategoryIds: [{ type: String }],
  isPlatformWide: { type: Boolean, default: false }, // Platform-funded vs seller-funded
  firstOrderOnly: { type: Boolean, default: false },
  combinable: { type: Boolean, default: false }, // Can stack with other discounts

  // Usage limits
  totalUsageLimit: { type: Number, min: 0, default: null },
  perBuyerUsageLimit: { type: Number, min: 0, default: null },
  usedCount: { type: Number, min: 0, default: 0 },
  usageHistory: [{
    buyerId: { type: String },
    orderId: { type: String },
    usedAt: { type: Date, default: Date.now },
    discountAmount: { type: Number },
  }],

  // Timing and visibility
  startsAt: { type: Date, default: Date.now },
  endsAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'paused', 'expired', 'exhausted'], default: 'active' },
  // Owner-controlled listing flag. Public reads additionally require `status`
  // to be active and the current time to be inside the start/end window.
  showOnPublic: { type: Boolean, default: true },
  createdBy: { type: String, default: null }, // Identity user id (SELLER)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound index for efficient promo code lookup with shop scope
promotionSchema.index({ code: 1, shopId: 1 }, { unique: true, partialFilterExpression: { code: { $exists: true, $ne: null } } });

// Index for usage history queries
promotionSchema.index({ 'usageHistory.buyerId': 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
