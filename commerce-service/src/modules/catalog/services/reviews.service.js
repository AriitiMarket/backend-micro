const reviewRepository = require('../repositories/reviews.repository');
const { PUBLIC_STATUS } = require('../repositories/reviews.repository');
const productService = require('./products.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Minimal author shape.
 *
 * The stored `reviews.user` object is whatever identity was trusted at write
 * time and may carry an email or a role, so it is never returned verbatim. The
 * id is exposed only on the author's OWN list (they already know who they are);
 * public listings get a display name only.
 */
function authorOf(review, { withId = false } = {}) {
  const user = (review && review.user) || {};
  // Never surface a raw email as the public display name (buyers' emails were
  // rendering as review author names). Own lists may still see their email
  // because they already know it; everyone else gets a generic label.
  const name = user.name || (withId ? user.email : null) || 'Aritii customer';
  const author = { name };
  if (withId) author.id = String(user._id || user.id || '') || null;
  return author;
}

/**
 * One review, shaped identically for every caller (public, buyer, admin), so no
 * screen can receive a differently-shaped record for the same review.
 */
function reviewDto(product, review, { withAuthorId = false } = {}) {
  return {
    _id: String(review._id),
    productId: String(product._id),
    productName: product.name || null,
    shop: product.shop
      ? { _id: String(product.shop._id || product.shopId || ''), name: product.shop.name || null }
      : null,
    rating: Number(review.rating) || 0,
    comment: review.comment || '',
    status: review.moderationStatus || 'pending',
    createdAt: review.createdAt || null,
    author: authorOf(review, { withId: withAuthorId }),
  };
}

/** Newest first; `createdAt` is missing on very old documents. */
function byNewest(a, b) {
  return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

/** Clamp paging input to something the database and the client can both trust. */
function pageOf(list, { page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const start = (safePage - 1) * safeLimit;
  return {
    reviews: list.slice(start, start + safeLimit),
    total: list.length,
    page: safePage,
    limit: safeLimit,
  };
}

class ReviewsService {
  /** Approved reviews of one product. Public. */
  async getProductReviews(productId, opts = {}) {
    const product = await reviewRepository.findProductById(productId);
    if (!product) throw new ApiError('Product not found', 404);

    const approved = (product.reviews || [])
      .filter((review) => review.moderationStatus === PUBLIC_STATUS)
      .sort(byNewest)
      .map((review) => reviewDto(product, review));

    return pageOf(approved, opts);
  }

  /** Approved reviews across every product of a shop. Public. */
  async getShopReviews(shopId, opts = {}) {
    const products = await reviewRepository.findProductsWithReviewsByShop(shopId);

    const approved = products
      .flatMap((product) =>
        (product.reviews || [])
          .filter((review) => review.moderationStatus === PUBLIC_STATUS)
          .map((review) => reviewDto(product, review))
      )
      .sort(byNewest);

    return pageOf(approved, opts);
  }

  /**
   * The caller's own reviews, in EVERY moderation state.
   *
   * An author must be able to see the review they just submitted is awaiting
   * moderation, so this is the one read that is not limited to approved reviews.
   */
  async getMyReviews(userId, opts = {}) {
    if (!userId) throw new ApiError('Authentication required', 401);

    const products = await reviewRepository.findProductsReviewedBy(userId);
    const mine = [];

    for (const product of products) {
      for (const review of product.reviews || []) {
        const authorId = String((review.user && (review.user._id || review.user.id)) || '');
        if (!authorId || authorId !== String(userId)) continue;
        mine.push(reviewDto(product, review, { withAuthorId: true }));
      }
    }

    return pageOf(mine.sort(byNewest), opts);
  }

  /** FIX #5: Admin - Get all pending reviews across all products */
  async getPendingReviews(opts = {}) {
    // ProductService owns the canonical embedded-review query and pagination.
    return productService.listPendingReviews(opts);
  }

  /** FIX #5: Admin - Get all reviews for a product (all statuses) */
  async getProductAllReviews(productId, opts = {}) {
    const product = await reviewRepository.findProductById(productId);
    if (!product) throw new ApiError('Product not found', 404);

    const allReviews = (product.reviews || [])
      .sort(byNewest)
      .map((review) => reviewDto(product, review, { withAuthorId: true }));

    return pageOf(allReviews, opts);
  }

  /** FIX #5: Admin - Approve a review by product and review ID */
  async approveReview(productId, reviewId, adminId) {
    const product = await reviewRepository.findProductById(productId);
    if (!product) throw new ApiError('Product not found', 404);
    if (!(product.reviews || []).some((review) => String(review._id) === String(reviewId))) {
      throw new ApiError('Review not found', 404);
    }
    // Reuse the canonical writer: it loads a writable document, updates
    // moderation fields and recomputes the product's approved-only rating.
    return (await productService.moderateReview(productId, reviewId, { action: 'approve', adminId })).review;
  }

  /** FIX #5: Admin - Reject a review with optional reason */
  async rejectReview(productId, reviewId, reason = '', adminId) {
    const product = await reviewRepository.findProductById(productId);
    if (!product) throw new ApiError('Product not found', 404);
    if (!(product.reviews || []).some((review) => String(review._id) === String(reviewId))) {
      throw new ApiError('Review not found', 404);
    }
    return (await productService.moderateReview(productId, reviewId, {
      action: 'reject',
      reason,
      adminId,
    })).review;
  }
}


module.exports = new ReviewsService();
module.exports.reviewDto = reviewDto;
module.exports.authorOf = authorOf;
module.exports.ApiError = ApiError;
