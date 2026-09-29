const express = require('express');
const router = express.Router();
const controller = require('../controllers/reviews.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

// ── Public reads ──────────────────────────────────────────────────────────
// Guests and buyers both read reviews; only APPROVED reviews are returned, so
// an unmoderated or rejected review is never published here.
router.get('/get-product-reviews/:productId', controller.getProductReviews);
router.get('/get-shop-reviews/:shopId', controller.getShopReviews);

// ── Author's own reviews ──────────────────────────────────────────────────
// Includes pending/rejected ones so the author can see their submission is in
// the moderation queue.
router.get('/get-my-reviews', authenticate, controller.getMyReviews);

// Writing a review stays on the product route (PUT /product/create-new-review),
// where the review is written into the product document it belongs to.

module.exports = router;
