const reviewsService = require('../services/reviews.service');
const { ok } = require('../../../shared/utils/response');

/** Page/limit come from the query string; the service clamps them. */
function paging(req) {
  return { page: req.query.page, limit: req.query.limit };
}

/** Public: approved reviews of one product. */
async function getProductReviews(req, res, next) {
  try {
    const data = await reviewsService.getProductReviews(req.params.productId, paging(req));
    return ok(res, data);
  } catch (err) { return next(err); }
}

/** Public: approved reviews across one shop's products. */
async function getShopReviews(req, res, next) {
  try {
    const data = await reviewsService.getShopReviews(req.params.shopId, paging(req));
    return ok(res, data);
  } catch (err) { return next(err); }
}

/**
 * The signed-in author's own reviews, including those still awaiting
 * moderation. Identity comes only from the gateway-injected token claims.
 */
async function getMyReviews(req, res, next) {
  try {
    const userId = req.user ? req.user.id : null;
    const data = await reviewsService.getMyReviews(userId, paging(req));
    return ok(res, data);
  } catch (err) { return next(err); }
}

/** FIX #5: Admin - Get all pending reviews (not yet approved) */
async function getPendingReviews(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const data = await reviewsService.getPendingReviews(
      { page: Number(page), limit: Number(limit) }
    );
    return ok(res, data);
  } catch (err) { return next(err); }
}

/** FIX #5: Admin - Get all reviews for a product (pending + approved + rejected) */
async function getProductAllReviews(req, res, next) {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const data = await reviewsService.getProductAllReviews(
      productId,
      { page: Number(page), limit: Number(limit) }
    );
    return ok(res, data);
  } catch (err) { return next(err); }
}

/** FIX #5: Admin - Approve a review */
async function approveReview(req, res, next) {
  try {
    const { productId, reviewId } = req.params;
    const result = await reviewsService.approveReview(productId, reviewId);
    return ok(res, { success: true, review: result });
  } catch (err) { return next(err); }
}

/** FIX #5: Admin - Reject a review */
async function rejectReview(req, res, next) {
  try {
    const { productId, reviewId } = req.params;
    const { reason } = req.body || {};
    const result = await reviewsService.rejectReview(productId, reviewId, reason || 'Rejected by moderation');
    return ok(res, { success: true, review: result });
  } catch (err) { return next(err); }
}

module.exports = {
  getProductReviews,
  getShopReviews,
  getMyReviews,
  getPendingReviews,
  getProductAllReviews,
  approveReview,
  rejectReview
};
