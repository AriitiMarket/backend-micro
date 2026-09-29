const mongoose = require('mongoose');

/**
 * Promotion — a commercial offer/campaign owned by one shop.
 *
 * Promotions are deliberately separate from the catalog and from events: a
 * promotion does not change a product's price, it advertises an offer that the
 * shop runs for a period of time.
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
  discountPercent: { type: Number, min: 0, max: 100, default: null },
  startsAt: { type: Date, default: Date.now },
  endsAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'paused'], default: 'active' },
  // Owner-controlled listing flag. Public reads additionally require `status`
  // to be active and the current time to be inside the start/end window.
  showOnPublic: { type: Boolean, default: true },
  createdBy: { type: String, default: null }, // Identity user id (SELLER)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Promotion', promotionSchema);
