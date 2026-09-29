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

module.exports = { getProductReviews, getShopReviews, getMyReviews };
