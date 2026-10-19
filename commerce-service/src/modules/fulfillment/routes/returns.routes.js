/**
 * Returns Routes
 * Unified returns/refunds workflow (FIX #3, #6, #15)
 */

const express = require('express');
const router = express.Router();
const returnsController = require('../controllers/returns.controller');
const { requireShopOwner } = require('../../../middleware/requireShopOwner');
const { verifyToken } = require('../../../middleware/auth');

router.use(verifyToken);

/**
 * Request return (buyer initiated)
 * POST /returns/order/:orderId/request
 */
router.post('/order/:orderId/request', (req, res, next) => {
  returnsController.requestReturn(req, res, next);
});

/**
 * Approve return (seller action, FIX #3)
 * POST /returns/:returnId/approve
 * Triggers inventory restoration
 */
router.post('/:returnId/approve', (req, res, next) => {
  returnsController.approveReturn(req, res, next);
});

/**
 * Process refund (FIX #6)
 * POST /returns/:returnId/refund
 * Body: { amount, method, notes }
 * Validates refund amount does not exceed order total
 */
router.post('/:returnId/refund', (req, res, next) => {
  returnsController.processRefund(req, res, next);
});

/**
 * Reject return (seller action)
 * POST /returns/:returnId/reject
 * Body: { reason }
 */
router.post('/:returnId/reject', (req, res, next) => {
  returnsController.rejectReturn(req, res, next);
});

/**
 * Get return details
 * GET /returns/:returnId
 */
router.get('/:returnId', (req, res, next) => {
  returnsController.getReturn(req, res, next);
});

/**
 * Get seller returns dashboard (FIX #15)
 * GET /returns/shop/:shopId/dashboard
 */
router.get('/shop/:shopId/dashboard', requireShopOwner, (req, res, next) => {
  returnsController.getSellerReturnsDashboard(req, res, next);
});

module.exports = router;
