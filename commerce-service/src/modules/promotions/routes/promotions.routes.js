const express = require('express');
const router = express.Router();
const controller = require('../controllers/promotions.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// ── Public / buyer reads (no token required) ──────────────────────────────
// Only live, publicly listed promotions are returned to an anonymous caller.
router.get('/get-all-promotions', controller.listPromotions);
router.get('/get-promotion/:id', controller.getPromotion);
// Owner-aware: a shop owner gets their drafts too, everyone else the public set.
router.get('/get-all-promotions/:shopId', controller.listShopPromotions);

// ── Seller writes ─────────────────────────────────────────────────────────
// SELLER only; the service additionally proves the caller owns the shop.
router.post('/create-promotion', authenticate, authorize('SELLER'), controller.createPromotion);
router.put('/update-promotion/:id', authenticate, authorize('SELLER'), controller.updatePromotion);
router.delete('/delete-promotion/:id', authenticate, authorize('SELLER'), controller.deletePromotion);

module.exports = router;
