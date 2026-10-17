const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/orders.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');
const { validateCreateOrder } = require('../../../shared/validators/commerce.validators');

// Anyone with buyer access can place an order — every account is a BUYER.
router.post('/create-order', authenticate, authorize('BUYER'), validateCreateOrder, ordersController.createOrder);

// Buyer endpoints (BUYER gate; the seller branches are never reachable here).
// Ownership is enforced in the controller/service on every one of them.
router.get('/get-all-orders/user/:userId', authenticate, authorize('BUYER', { exact: true }), ordersController.getUserOrders);
router.get('/order/:orderId', authenticate, authorize('BUYER', { exact: true }), ordersController.getOrder);
router.put('/refund-order/:orderId', authenticate, authorize('BUYER', { exact: true }), ordersController.refundOrder);

// Seller endpoints (only SELLER role)
router.get('/get-all-orders/seller/:sellerId', authenticate, authorize('SELLER'), ordersController.getSellerOrders);
router.put('/update-order-status/:orderId', authenticate, authorize('SELLER'), ordersController.updateOrderStatus);
router.put('/order-refund-success/:orderId', authenticate, authorize('SELLER'), ordersController.orderRefundSuccess);

// PHASE 2: Payment confirmation and order cancellation (buyer only)
router.post('/confirm-payment/:orderId', authenticate, authorize('BUYER', { exact: true }), ordersController.confirmPayment);
router.post('/cancel/:orderId', authenticate, authorize('BUYER', { exact: true }), ordersController.cancelOrder);

// ORDER ↔ DELIVERY bridge: delivery info for one order. Authorization follows
// the ORDER's ownership (buyer / owning seller / admin), validated in the
// controller, so a shipment detail can never probe someone else's order.
//
// NOTE on the path: this router is mounted at `/order`, so the handler path must
// NOT repeat the prefix (`/order/...` here would only ever match the doubled
// public path `/order/order/.../delivery`, exactly like the sibling
// `GET /order/order/:orderId` detail route).
router.get('/:orderId/delivery', authenticate, ordersController.getOrderDelivery);

// PHASE 2: Inventory availability endpoint
router.get('/availability/:productId', authenticate, ordersController.getInventoryAvailability);

module.exports = router;
