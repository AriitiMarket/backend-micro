/**
 * Orders Routes
 * Endpoints for order management with all fixes integrated
 */

const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/orders.controller');
const { requireShopOwner } = require('../../../middleware/requireShopOwner');
const { verifyToken } = require('../../../middleware/auth'); // Assuming auth middleware exists

/**
 * All routes require authentication
 */
router.use(verifyToken);

/**
 * Get all orders for a shop (FIX #7: with pagination)
 * GET /orders/shop/:shopId?page=1&limit=20&status=PROCESSING&sortBy=createdAt
 */
router.get('/shop/:shopId', requireShopOwner, (req, res, next) => {
  ordersController.getAllOrdersOfShop(req, res, next);
});

/**
 * Confirm order (FIX #1, #10, #12)
 * POST /orders/:orderId/confirm
 * - ACID transaction
 * - Idempotent
 * - Checks delivery coverage
 */
router.post('/:orderId/confirm', (req, res, next) => {
  ordersController.confirmOrder(req, res, next);
});

/**
 * Update order status (FIX #4, #8)
 * PATCH /orders/:orderId/status
 * - State machine validation
 * - Timeline tracking
 */
router.patch('/:orderId/status', (req, res, next) => {
  ordersController.updateOrderStatus(req, res, next);
});

/**
 * Get order timeline (FIX #8)
 * GET /orders/:orderId/timeline
 */
router.get('/:orderId/timeline', (req, res, next) => {
  ordersController.getOrderTimeline(req, res, next);
});

/**
 * Cancel order
 * POST /orders/:orderId/cancel
 */
router.post('/:orderId/cancel', (req, res, next) => {
  ordersController.cancelOrder(req, res, next);
});

/**
 * Get available stock (FIX #2)
 * GET /orders/product/:productId/available-stock
 */
router.get('/product/:productId/available-stock', (req, res, next) => {
  ordersController.getAvailableStock(req, res, next);
});

/**
 * Bulk order action (FIX #14 backend)
 * POST /orders/bulk-action
 * Body: { orderIds: [...], action: 'ACCEPT' | 'REJECT' | 'SHIP' }
 */
router.post('/bulk-action', (req, res, next) => {
  ordersController.bulkOrderAction(req, res, next);
});

module.exports = router;
