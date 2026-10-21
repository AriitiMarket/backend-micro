/**
 * Orders Routes
 * Endpoints for order management with all fixes integrated
 */

const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/orders.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { requireShopOwner } = require('../../../middleware/requireShopOwner');
const { isSeller, isAdmin } = require('../../../shared/utils/roles');

// The signed membership-status claim is authoritative too. Some valid sessions
// still carry BUYER as their active role and omit SELLER from capabilities even
// though Identity reports an ACTIVE seller membership. Permit that verified
// membership, while preserving the standard gate for pending/suspended roles.
function authorizeSellerOrders(req, res, next) {
  const sellerStatus = String(req.user?.roleStatuses?.SELLER || '').toUpperCase();
  if (isAdmin(req.user) || sellerStatus === 'ACTIVE' || (isSeller(req.user) && !sellerStatus)) {
    return next();
  }
  return authorize(['SELLER', 'ADMIN'])(req, res, next);
}

/**
 * Get all orders for a shop (FIX #7: with pagination)
 * GET /orders/shop/:shopId?page=1&limit=20&status=PROCESSING&sortBy=createdAt
 */
router.get('/shop/:shopId', authenticate, authorize(['SELLER', 'ADMIN']), requireShopOwner, (req, res, next) => {
  ordersController.getAllOrdersOfShop(req, res, next);
});

/**
 * Confirm order (FIX #1, #10, #12)
 * POST /orders/:orderId/confirm
 * - ACID transaction
 * - Idempotent
 * - Checks delivery coverage
 */
router.post('/:orderId/confirm', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.confirmOrder(req, res, next);
});

/**
 * Buyer confirms receipt of order after delivery
 * POST /orders/:orderId/confirm-receipt
 */
router.post('/:orderId/confirm-receipt', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  ordersController.confirmReceipt(req, res, next);
});

/**
 * Buyer confirms receipt of consolidated order group after delivery
 * POST /orders/group/:orderGroupId/confirm-receipt
 */
router.post('/group/:orderGroupId/confirm-receipt', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  ordersController.confirmReceiptGroup(req, res, next);
});

// Shop staff verifies the buyer's one-time pickup code; no delivery assignment
// or deliverer wallet transaction is created for this fulfilment path.
router.post('/:orderId/verify-pickup', authenticate, authorize(['SELLER']), (req, res, next) => {
  ordersController.verifyPickup(req, res, next);
});

/**
 * Update order status (FIX #4, #8)
 * PATCH /orders/:orderId/status
 * - State machine validation
 * - Timeline tracking
 */
router.patch('/:orderId/status', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.updateOrderStatus(req, res, next);
});

// Legacy PUT route alias for status updates
router.put('/update-order-status/:orderId', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  if (req.body?.status === 'Confirmed') {
    return ordersController.confirmOrder(req, res, next);
  }
  ordersController.updateOrderStatus(req, res, next);
});

/**
 * Get order timeline (FIX #8)
 * GET /orders/:orderId/timeline
 */
router.get('/:orderId/timeline', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.getOrderTimeline(req, res, next);
});

/**
 * Cancel order
 * POST /orders/:orderId/cancel
 */
router.post('/:orderId/cancel', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.cancelOrder(req, res, next);
});

/**
 * Get available stock (FIX #2)
 * GET /orders/product/:productId/available-stock
 */
router.get('/product/:productId/available-stock', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.getAvailableStock(req, res, next);
});

/**
 * Bulk order action (FIX #14 backend)
 * POST /orders/bulk-action
 * Body: { orderIds: [...], action: 'ACCEPT' | 'REJECT' | 'SHIP' }
 */
router.post('/bulk-action', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.bulkOrderAction(req, res, next);
});

// Create order (buyer)
router.post('/create-order', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  ordersController.createOrder(req, res, next);
});

// Get buyer orders
router.get('/get-all-orders/user/:userId', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  ordersController.getBuyerOrders(req, res, next);
});

// Get seller orders
// Resolve the seller from the verified gateway identity so the client cannot
// accidentally pass a shop/profile id that differs from the authenticated user.
router.get('/get-all-orders/seller/me', authenticate, authorizeSellerOrders, (req, res, next) => {
  req.params.sellerId = req.user.id;
  ordersController.getSellerOrders(req, res, next);
});

router.get('/get-all-orders/seller/:sellerId', authenticate, authorizeSellerOrders, (req, res, next) => {
  ordersController.getSellerOrders(req, res, next);
});

// Get order details
router.get('/order/:orderId', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.getOrderDetails(req, res, next);
});

// Approve refund (seller/business)
router.put('/order-refund-success/:orderId', authenticate, authorize(['SELLER', 'ADMIN']), (req, res, next) => {
  ordersController.approveRefund(req, res, next);
});

// Request refund (buyer)
router.put('/refund-order/:orderId', authenticate, authorize(['BUYER', 'ADMIN']), (req, res, next) => {
  ordersController.refundOrder(req, res, next);
});

module.exports = router;
