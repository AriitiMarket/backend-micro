// Review reads.
//
// SOURCE OF TRUTH: reviews are EMBEDDED subdocuments of the product (see
// products/models/Products.js). Each carries its own moderation state and
// `product.ratings` is the average of APPROVED reviews only, so the moderation
// flow and the public rating can never disagree.
//
// A standalone `Reviews` collection used to sit beside this file, wired to no
// route, which risked a second, divergent answer to "what do the reviews say?".
// It has been removed; this repository is the only reader of review data.
const Product = require('../models/Products');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

// Only approved reviews are ever published to buyers and guests.
const PUBLIC_STATUS = 'approved';

/** Allowlisted review fields — never `rejectionReason`/`moderatedBy`. */
const REVIEW_PROJECTION = {
  _id: 1,
  name: 1,
  shopId: 1,
  'shop._id': 1,
  'shop.name': 1,
  'reviews._id': 1,
  'reviews.user': 1,
  'reviews.rating': 1,
  'reviews.comment': 1,
  'reviews.moderationStatus': 1,
  'reviews.createdAt': 1,
};

class ReviewRepository {
  /** The product holding the reviews, or null for a malformed/missing id. */
  findProductById(productId) {
    if (!isValidObjectId(productId)) return Promise.resolve(null);
    return Product.findById(productId).select(REVIEW_PROJECTION).lean();
  }

  /** Every product of a shop that carries at least one review. */
  findProductsWithReviewsByShop(shopId) {
    return Product.find({ shopId, 'reviews.0': { $exists: true } })
      .select(REVIEW_PROJECTION)
      .lean();
  }

  /**
   * Products carrying a review authored by `userId`.
   *
   * The author id is stored under `reviews.user._id` (and, for documents written
   * before the id was normalised, `reviews.user.id`), so both are matched.
   */
  findProductsReviewedBy(userId) {
    return Product.find({
      $or: [{ 'reviews.user._id': userId }, { 'reviews.user.id': userId }],
    })
      .select(REVIEW_PROJECTION)
      .lean();
  }
}

module.exports = new ReviewRepository();
module.exports.PUBLIC_STATUS = PUBLIC_STATUS;
module.exports.REVIEW_PROJECTION = REVIEW_PROJECTION;
