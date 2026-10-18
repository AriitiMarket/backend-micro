const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Please enter your product name!'] },
  description: { type: String, required: [true, 'Please enter your product description!'] },
  category: { type: String, required: [true, 'Please enter your product category!'] },
  tags: { type: String },
  sku: { type: String, default: '' },
  originalPrice: { type: Number },
  discountPrice: { type: Number, required: [true, 'Please enter your product discount price!'] },
  stock: { type: Number, required: [true, 'Please enter your product stock!'], default: 0 },
  reserved: { type: Number, default: 0, required: true },
  lowStockThreshold: { type: Number, default: 5 },
  images: [{ type: String }],
  reviews: [
    {
      user: { type: Object },
      rating: { type: Number },
      comment: { type: String },
      productId: { type: String },
      // Moderation state. Reviews are created as 'pending' so nothing is
      // published before an admin reviews it (see products.service.createReview
      // and /order/admin/reviews/*).
      moderationStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
      },
      moderatedAt: { type: Date, default: null },
      moderatedBy: { type: String, default: null },
      rejectionReason: { type: String, default: null },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  ratings: { type: Number },
  // ── Lifecycle ───────────────────────────────────────────────────────────
  // Seller-controlled publish/draft — there is NO admin approval step: an
  // approved seller publishes their own products. Admin moderation is the
  // independent `isActive` kill-switch (POST /product/bulk) below: a product
  // is publicly visible only when BOTH pass (isActive !== false AND status is
  // PUBLISHED). Documents created before this field existed behave as
  // PUBLISHED (missing status = live), so the existing catalogue is untouched.
  //
  // ARCHIVED is the seller's retired state: the product is hidden from buyers
  // and from the seller's active workflow but the row (and its stock ledger and
  // review history) is retained and can be restored. It is the reversible
  // counterpart to the hard `DELETE /product/delete-shop-product/:id`.
  // Only the three states above are public: ARCHIVED never matches the
  // "PUBLISHED or absent" visibility gate, so no extra filter is needed.
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'], default: 'DRAFT' },
  publishedAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now },
  currency: { type: String, default: 'ETB' },
  // Resolved Category _id (optional FK); `category` stays the display title so
  // legacy documents and existing UIs keep working.
  categoryId: { type: String, default: null },
  // Admin visibility kill-switch (activate/deactivate). Kept separate from
  // `status` so admin suppression and seller draft are independent concerns.
  isActive: { type: Boolean, default: true },
  shopId: { type: String, required: true },
  shop: { type: Object, required: true },
  sellerId: { type: String },
  sold_out: { type: Number, default: 0 },
  
  // FIX #8: Backorder/Preorder Support
  allowBackorder: { type: Boolean, default: false },
  backorderLimit: { type: Number, default: 0 }, // Max backorders allowed
  currentBackorders: { type: Number, default: 0 }, // Current backorder count
  backorderStatus: { type: String, enum: ['OPEN', 'CLOSED', 'FULL'], default: 'CLOSED' },
  
  // Preorder support (scheduled availability)
  allowPreorder: { type: Boolean, default: false },
  preorderAvailableDate: { type: Date, default: null }, // When product will be available
  preorderStock: { type: Number, default: 0 }, // Max preorder quantity
  currentPreorders: { type: Number, default: 0 }, // Current preorder count
  preorderPrice: { type: Number, default: null }, // Can differ from regular price
  preorderStatus: { type: String, enum: ['OPEN', 'CLOSED', 'FULFILLED'], default: 'CLOSED' },
  
  createdAt: { type: Date, default: Date.now },
});

// Indexes (the collection previously had none — every list/search was a scan).
productSchema.index({ shopId: 1, createdAt: -1 });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1, status: 1, createdAt: -1 });
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
// SKU must be unique per shop — but `sku` is optional, and 17 legacy rows store
// it as '' rather than omitting it. A PARTIAL unique index therefore applies
// only to real SKUs (`sku > ''` excludes both '' and a missing field), so
// existing products without a SKU never collide.
productSchema.index(
  { shopId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $gt: '' } }, name: 'uniq_shop_sku' }
);

// `updatedAt` maintenance — covers both .save() and findOneAndUpdate paths.
productSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});
productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() || {};
  // Pipeline updates are ARRAYS — spreading one into an object would corrupt
  // it, so they are left untouched (they set updatedAt themselves where needed).
  if (Array.isArray(update)) return next();
  if (update.$set && update.$set.updatedAt) return next();
  this.setUpdate({
    ...update,
    $set: { ...(update.$set || {}), updatedAt: new Date() },
  });
  next();
});

module.exports = mongoose.model('Product', productSchema);
