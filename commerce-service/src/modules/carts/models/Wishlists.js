const mongoose = require('mongoose');

const wishlistItemSchema = new mongoose.Schema({
  // The service sets `_id` equal to productId so client code can match items
  // on the product id (same convention cart items end up with).
  _id: { type: String, default: () => String(new mongoose.Types.ObjectId()) },
  productId: { type: String, required: true, index: true },
  shopId: { type: String, default: '' },
  // Display snapshot denormalized from the authoritative product document —
  // client-supplied name/price are never trusted.
  name: { type: String, required: true },
  price: { type: Number, required: true, default: 0 },
  originalPrice: { type: Number, default: 0 },
  image: { type: String, default: '' },
  shopName: { type: String, default: '' },
  ratings: { type: Number, default: 0 },
  stock: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const wishlistSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  items: [wishlistItemSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// One wishlist line per product per user, enforced at the database level.
wishlistSchema.index({ userId: 1, 'items.productId': 1 }, { unique: true });

module.exports = mongoose.model('Wishlist', wishlistSchema);
