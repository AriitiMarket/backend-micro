'use strict';

/**
 * Reviews Service
 * Handles review creation, verified purchaser checking, pending review listing, and moderation.
 */

const productRepository = require('../repositories/products.repository');
const orderRepository = require('../../orders/repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Public rating = mean of APPROVED reviews only. Returns 0 when nothing has been
 * approved, so an unmoderated product never advertises a rating.
 */
function averageApprovedRating(reviews = []) {
  const approved = reviews.filter(
    (rev) => rev.moderationStatus === 'approved' && Number.isFinite(Number(rev.rating))
  );
  if (!approved.length) return 0;
  const total = approved.reduce((sum, rev) => sum + Number(rev.rating), 0);
  return Math.round((total / approved.length) * 10) / 10;
}

/**
 * The author id of a candidate review.
 * Accepts `id`, `sub`, and `_id`.
 */
function resolveReviewerId(user) {
  if (!user) return null;
  const raw = user.id || user.sub || user._id;
  return raw ? String(raw) : null;
}

/** Author id for an author already stored on an embedded review. */
function reviewAuthorId(review) {
  const user = (review && review.user) || null;
  if (!user) return null;
  const raw = user._id || user.id || user.sub;
  return raw ? String(raw) : null;
}

/** Single review DTO shared by the pending list and the moderation responses */
function toReviewDto(product, review) {
  if (!review) return null;
  return {
    reviewId: String(review._id),
    productId: String(product._id),
    productName: product.name || null,
    rating: review.rating,
    comment: review.comment,
    user: review.user,
    status: review.moderationStatus || 'pending',
    createdAt: review.createdAt,
    moderatedAt: review.moderatedAt,
    moderatedBy: review.moderatedBy,
  };
}

class ReviewsService {
  /**
   * Submit (or update) the caller's review of a product.
   */
  async createReview({ productId, orderId, user, rating, comment }) {
    const product = await productRepository.findById(productId);
    if (!product) throw new ApiError('Product not found', 404);

    const reviewerId = resolveReviewerId(user);
    if (!reviewerId) throw new ApiError('Authentication required', 401);
    const ratingValue = Number(rating);

    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      throw new ApiError('Rating must be between 1 and 5', 400);
    }
    if (comment !== undefined && comment !== null && String(comment).length > 2000) {
      throw new ApiError('Review comment must be at most 2000 chars', 400);
    }

    if (product.shop && product.shop.ownerId && String(product.shop.ownerId) === reviewerId) {
      throw new ApiError('You cannot review your own product', 403);
    }
    const purchased = await orderRepository.existsOwnedOrder(reviewerId, productId);
    if (!purchased) {
      throw new ApiError('Only verified purchasers can review this product', 403);
    }

    const review = {
      user,
      rating: ratingValue,
      comment: comment !== undefined && comment !== null ? String(comment) : '',
      productId,
      moderationStatus: 'pending',
      moderatedAt: null,
      moderatedBy: null,
      rejectionReason: null,
    };
    const existing = (product.reviews || []).find(
      (rev) => reviewAuthorId(rev) === reviewerId
    );

    if (existing) {
      existing.rating = review.rating;
      existing.comment = review.comment;
      existing.user = user;
      existing.moderationStatus = 'pending';
      existing.moderatedAt = null;
      existing.moderatedBy = null;
      existing.rejectionReason = null;
    } else {
      product.reviews.push(review);
    }
    product.ratings = averageApprovedRating(product.reviews);
    await product.save({ validateBeforeSave: false });
    if (orderId) {
      const ownsOrder = await orderRepository.ownsOrderContaining(orderId, reviewerId, productId);
      if (ownsOrder) {
        await orderRepository.findByIdAndUpdate(orderId, {
          $set: { 'cart.$[elem].isReviewed': true },
        }, {
          arrayFilters: [{ $or: [{ 'elem._id': productId }, { 'elem.productId': productId }] }],
        });
      }
    }
    return { message: 'Review submitted for moderation' };
  }

  /**
   * Reviews awaiting moderation, newest product first.
   */
  async listPendingReviews({ page = 1, limit = 10 } = {}) {
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const pendingMatch = {
      $or: [
        { 'reviews.moderationStatus': 'pending' },
        { 'reviews.moderationStatus': { $exists: false } },
        { 'reviews.moderationStatus': null },
      ],
    };

    const [result] = await productRepository.aggregate([
      { $unwind: '$reviews' },
      { $match: pendingMatch },
      { $sort: { createdAt: -1, 'reviews._id': 1 } },
      {
        $facet: {
          items: [
            { $skip: (safePage - 1) * safeLimit },
            { $limit: safeLimit },
            {
              $project: {
                _id: 0,
                reviewId: { $toString: '$reviews._id' },
                productId: { $toString: '$_id' },
                productName: '$name',
                rating: '$reviews.rating',
                comment: '$reviews.comment',
                user: '$reviews.user',
                status: { $ifNull: ['$reviews.moderationStatus', 'pending'] },
                createdAt: '$reviews.createdAt',
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const items = (result && result.items) || [];
    const total = (result && result.total && result.total[0] && result.total[0].count) || 0;

    return {
      reviews: items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 0,
    };
  }

  /**
   * Approves or rejects one review and recomputes the product's public rating.
   */
  async moderateReview(productId, reviewId, options) {
    if (options === undefined && reviewId && typeof reviewId === 'object') {
      options = reviewId;
      reviewId = productId;
      productId = undefined;
    }
    const { action, reason, adminId } = options || {};
    if (!['approve', 'reject'].includes(action)) {
      throw new ApiError('action must be "approve" or "reject"', 400);
    }
    if (action === 'reject' && !String(reason || '').trim()) {
      throw new ApiError('A rejection reason is required', 400);
    }

    const product = await productRepository.updateReviewModeration(reviewId, {
      productId,
      status: action === 'approve' ? 'approved' : 'rejected',
      moderatedBy: adminId,
      reason,
    });
    if (!product) throw new ApiError('Review not found', 404);

    product.ratings = averageApprovedRating(product.reviews);
    await product.save({ validateBeforeSave: false });

    const review = product.reviews.id
      ? product.reviews.id(reviewId)
      : (product.reviews || []).find((rev) => String(rev._id) === String(reviewId));

    return {
      review: toReviewDto(product, review),
      ratings: product.ratings,
    };
  }
}

module.exports = new ReviewsService();
module.exports.averageApprovedRating = averageApprovedRating;
module.exports.resolveReviewerId = resolveReviewerId;
module.exports.reviewAuthorId = reviewAuthorId;
module.exports.toReviewDto = toReviewDto;
