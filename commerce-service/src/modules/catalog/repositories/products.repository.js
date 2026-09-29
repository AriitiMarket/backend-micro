const Product = require('../models/Products');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class ProductRepository {
  create(data) { return Product.create(data); }
  // Non-ObjectId ids return null so callers answer 404 instead of a CastError
  // 400/500 — same guard orders.repository and shops.repository already use.
  findById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Product.findById(id);
  }
  findByShop(shopId, extraFilter = {}) { return Product.find({ shopId, ...extraFilter }); }
  /**
   * Duplicate-SKU guard. SKUs are unique per shop (partial unique index
   * `uniq_shop_sku`); this lookup produces the friendly 409 before the driver
   * ever rejects the write. `excludeId` lets an update ignore its own document.
   */
  findByShopAndSku(shopId, sku, excludeId = null) {
    const filter = { shopId: String(shopId), sku: String(sku) };
    if (excludeId) filter._id = { $ne: excludeId };
    return Product.findOne(filter).select('_id sku name');
  }
  findAll(extraFilter = {}, sort = { createdAt: -1 }) {
    return Product.find({ ...extraFilter }).sort(sort);
  }
  /** Number of products owned by a shop — used to enforce maxProductsPerSeller. */
  countByShop(shopId) {
    return Product.countDocuments({ shopId: String(shopId) });
  }
  /**
   * Product counts for a bounded set of shops in ONE aggregation — used by the
   * owner's shop list, which needs a real count per shop (never a guess).
   */
  countByShops(shopIds = []) {
    if (!shopIds.length) return Promise.resolve([]);
    return Product.aggregate([
      { $match: { shopId: { $in: shopIds.map(String) } } },
      { $group: { _id: '$shopId', count: { $sum: 1 } } },
    ]);
  }
  /** Filtered + paginated query used by the admin list. */
  findFiltered(filter, { sort = { createdAt: -1 }, skip = 0, limit = 0 } = {}) {
    let q = Product.find(filter).sort(sort);
    if (skip > 0) q = q.skip(skip);
    if (limit > 0) q = q.limit(limit);
    return q;
  }
  count(filter = {}) {
    return Product.countDocuments(filter);
  }
  findByIdAndUpdate(id, data, opts = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Product.findByIdAndUpdate(id, data, { new: true, runValidators: true, ...opts });
  }
  // runValidators: schema min/range rules used to be bypassable on update
  // because findByIdAndUpdate skipped validation by default.
  updateById(id, data) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Product.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }
  deleteById(id) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return Product.findByIdAndDelete(id);
  }
  updateStock(productId, delta) {
    if (!isValidObjectId(productId)) return Promise.resolve(null);
    return Product.findByIdAndUpdate(productId, { $inc: { stock: delta } }, { new: true });
  }

  /**
   * Atomically decrement stock only if sufficient quantity is available.
   * Returns the updated product or null if stock is insufficient.
   */
  async decrementStock(productId, quantity) {
    const result = await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: quantity } },
      { $inc: { stock: -quantity } },
      { new: true }
    );
    return result;
  }

  /**
   * Atomically increment stock.
   */
  incrementStock(productId, quantity) {
    return Product.findByIdAndUpdate(productId, { $inc: { stock: quantity, sold_out: -quantity } }, { new: true });
  }

  /**
   * Atomically reserve `quantity` units only when available (stock - reserved)
   * is sufficient. A single conditional update — no read-modify-write race.
   * Returns the updated product, or null when availability is insufficient.
   */
  reserveAvailable(productId, quantity) {
    return Product.findOneAndUpdate(
      {
        _id: productId,
        $expr: { $gte: [{ $subtract: ['$stock', { $ifNull: ['$reserved', 0] }] }, quantity] },
      },
      { $inc: { reserved: quantity } },
      { new: true }
    );
  }

  /**
   * Atomically release up to `quantity` reserved units, clamped at 0.
   * Pipeline update so concurrent releases can never drive reserved negative.
   */
  releaseReserved(productId, quantity) {
    return Product.findOneAndUpdate(
      { _id: productId },
      [{ $set: { reserved: { $max: [0, { $subtract: [{ $ifNull: ['$reserved', 0] }, quantity] }] } } }],
      { new: true }
    );
  }

  // --- Review moderation --------------------------------------------------
  // Reviews live INSIDE the product document (see models/Products.js), so
  // moderation is an embedded-subdocument update keyed by the review's own _id.

  /** Raw aggregation hook (used to page over embedded reviews, not products). */
  aggregate(pipeline = []) {
    return Product.aggregate(pipeline);
  }

  /** Sets the moderation state of one embedded review. Null when not found. */
  updateReviewModeration(reviewId, { status, moderatedBy, reason = null }) {
    return Product.findOneAndUpdate(
      { 'reviews._id': reviewId },
      {
        $set: {
          'reviews.$.moderationStatus': status,
          'reviews.$.moderatedAt': new Date(),
          'reviews.$.moderatedBy': moderatedBy || null,
          'reviews.$.rejectionReason': status === 'rejected' ? reason : null,
        },
      },
      { new: true }
    );
  }

  /** Bulk visibility update. Returns the driver's matched/modified counts. */
  setActiveForIds(productIds, isActive) {
    return Product.updateMany(
      { _id: { $in: productIds } },
      { $set: { isActive } }
    );
  }

  /**
   * Atomic conditional deduct used on payment confirmation: requires enough
   * stock and consumes the order's own reservation (clamped at 0). Returns the
   * updated product, or null when stock is insufficient.
   */
  deductReserved(productId, quantity) {
    return Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: quantity } },
      [
        {
          $set: {
            stock: { $subtract: ['$stock', quantity] },
            reserved: {
              $max: [0, { $subtract: [{ $ifNull: ['$reserved', 0] }, quantity] }],
            },
            updatedAt: new Date(),
          },
        },
      ],
      { new: true }
    );
  }

  /**
   * Return units to stock (refund / cancel-after-confirm). `sold_out` is
   * clamped at 0 so a return can never drive the counter negative.
   */
  returnStock(productId, quantity) {
    return Product.findOneAndUpdate(
      { _id: productId },
      [
        {
          $set: {
            stock: { $add: [{ $ifNull: ['$stock', 0] }, quantity] },
            sold_out: { $max: [0, { $subtract: [{ $ifNull: ['$sold_out', 0] }, quantity] }] },
            updatedAt: new Date(),
          },
        },
      ],
      { new: true }
    );
  }

  /**
   * Reverse of `deductReserved` — only used to compensate a failed movement
   * write so the confirmation can be retried cleanly. Reserved may drift
   * upward here (conservative: never causes an oversell).
   */
  compensateDeduct(productId, quantity) {
    return Product.findByIdAndUpdate(
      productId,
      { $inc: { stock: quantity, reserved: quantity } },
      { new: true }
    );
  }

  // --- Lifecycle (seller publish/draft — atomic, guarded transitions) -------

  /**
   * DRAFT (or legacy missing-status... no: legacy = PUBLISHED, so only real
   * DRAFTs match) → PUBLISHED. Sets publishedAt on first publish.
   * Returns the updated product, or null when the guard did not match
   * (already published — caller treats it as an idempotent success).
   */
  publish(id) {
    return Product.findOneAndUpdate(
      { _id: id, status: 'DRAFT' },
      [
        {
          $set: {
            status: 'PUBLISHED',
            updatedAt: new Date(),
            publishedAt: { $ifNull: ['$publishedAt', new Date()] },
          },
        },
      ],
      { new: true }
    );
  }

  /**
   * PUBLISHED (or legacy missing-status) → DRAFT.
   * Returns the updated product, or null when already a draft.
   */
  draft(id) {
    return Product.findOneAndUpdate(
      { _id: id, $or: [{ status: 'PUBLISHED' }, { status: { $exists: false } }, { status: null }] },
      { $set: { status: 'DRAFT', updatedAt: new Date() } },
      { new: true }
    );
  }

  /**
   * ANY live state → ARCHIVED (retired but recoverable). The guard excludes
   * rows that are already archived, so a repeat call is an idempotent no-op the
   * caller can treat as success. Sets `archivedAt` on the first archive only.
   */
  archive(id) {
    return Product.findOneAndUpdate(
      { _id: id, status: { $ne: 'ARCHIVED' } },
      [
        {
          $set: {
            status: 'ARCHIVED',
            updatedAt: new Date(),
            archivedAt: { $ifNull: ['$archivedAt', new Date()] },
          },
        },
      ],
      { new: true }
    );
  }

  /**
   * ARCHIVED → DRAFT (restore). A restored product always lands in DRAFT, never
   * straight back on the storefront: publication stays a deliberate seller act.
   * Returns null when the product was not archived (caller treats it as
   * idempotent success).
   */
  unarchive(id) {
    return Product.findOneAndUpdate(
      { _id: id, status: 'ARCHIVED' },
      { $set: { status: 'DRAFT', archivedAt: null, updatedAt: new Date() } },
      { new: true }
    );
  }
}

module.exports = new ProductRepository();
