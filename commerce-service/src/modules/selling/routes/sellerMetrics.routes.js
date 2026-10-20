/**
 * Seller Metrics Routes
 * FIX #13: KPI endpoints for seller dashboard
 */

const express = require('express');
const router = express.Router();
const sellerMetricsController = require('../controllers/sellerMetrics.controller');
const { requireShopOwner } = require('../../../middleware/requireShopOwner');
const { authenticate } = require('../../../app/middleware/authenticate');

router.use(authenticate);

/**
 * Get seller metrics (FIX #13)
 * GET /metrics/shop/:shopId?period=daily&startDate=2024-01-01&endDate=2024-01-31
 */
router.get('/shop/:shopId', requireShopOwner, (req, res, next) => {
  sellerMetricsController.getMetrics(req, res, next);
});

/**
 * Get dashboard summary (quick view)
 * GET /metrics/shop/:shopId/dashboard
 */
router.get('/shop/:shopId/dashboard', requireShopOwner, (req, res, next) => {
  sellerMetricsController.getDashboardSummary(req, res, next);
});

module.exports = router;
