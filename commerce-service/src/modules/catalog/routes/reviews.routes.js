const express = require('express');
const router = express.Router();
const controller = require('../controllers/reviews.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// ── Public reads ──────────────────────────────────────────────────────────
// Guests and buyers both read reviews; only APPROVED reviews are returned, so
// an unmoderated or rejected review is never published here.
router.get('/get-product-reviews/:productId', controller.getProductReviews);
router.get('/get-shop-reviews/:shopId', controller.getShopReviews);

// ── Author's own reviews ──────────────────────────────────────────────────
// Includes pending/rejected ones so the author can see their submission is in
// the moderation queue.
router.get('/get-my-reviews', authenticate, controller.getMyReviews);

// ── FIX #5: Admin moderation endpoints ─────────────────────────────────
router.get('/admin/pending', authenticate, authorize('ADMIN'), controller.getPendingReviews);
router.get('/admin/product/:productId', authenticate, authorize('ADMIN'), controller.getProductAllReviews);
router.post('/admin/:productId/:reviewId/approve', authenticate, authorize('ADMIN'), controller.approveReview);
router.post('/admin/:productId/:reviewId/reject', authenticate, authorize('ADMIN'), controller.rejectReview);

// Writing a review stays on the product route (PUT /product/create-new-review),
// where the review is written into the product document it belongs to.

module.exports = router;
