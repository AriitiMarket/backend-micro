/**
 * Returns Routes
 * Unified returns/refunds workflow (FIX #3, #6, #15)
 */

const express = require('express');
const router = express.Router();
const returnsController = require('../controllers/returns.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { requireShopOwner } = require('../../../middleware/requireShopOwner');

/**
 * Request return (buyer initiated)
 * POST /returns/order/:orderId/request
 */
router.post('/order/:orderId/request', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  returnsController.requestReturn(req, res, next);
});

/**
 * Approve return (seller action, FIX #3)
 * POST /returns/:returnId/approve
 * Triggers inventory restoration
 */
router.post('/:returnId/approve', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  returnsController.approveReturn(req, res, next);
});

/**
 * Process refund (FIX #6)
 * POST /returns/:returnId/refund
 * Body: { amount, method, notes }
 * Validates refund amount does not exceed order total
 */
router.post('/:returnId/refund', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  returnsController.processRefund(req, res, next);
});

/**
 * Reject return (seller action)
 * POST /returns/:returnId/reject
 * Body: { reason }
 */
router.post('/:returnId/reject', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  returnsController.rejectReturn(req, res, next);
});

/**
 * Get return details
 * GET /returns/:returnId
 */
router.get('/:returnId', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), (req, res, next) => {
  returnsController.getReturn(req, res, next);
});

/**
 * Get seller returns dashboard (FIX #15)
 * GET /returns/shop/:shopId/dashboard
 */
router.get('/shop/:shopId/dashboard', authenticate, authorize(['SELLER', 'ADMIN']), requireShopOwner, (req, res, next) => {
  returnsController.getSellerReturnsDashboard(req, res, next);
});

// ADMIN: List all returns
router.get('/admin/list', authenticate, authorize('ADMIN'), (req, res, next) => {
  returnsController.listReturns(req, res, next);
});

// ADMIN: Get returns stats
router.get('/admin/stats', authenticate, authorize('ADMIN'), (req, res, next) => {
  returnsController.getStats(req, res, next);
});

module.exports = router;
