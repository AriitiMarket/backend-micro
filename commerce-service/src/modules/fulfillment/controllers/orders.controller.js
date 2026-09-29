const orderService = require('../services/orders.service');
const orderDeliveryService = require('../services/orderDelivery.service');
const { ok, created } = require('../../../shared/utils/response');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');
const { isAdmin, isSeller } = require('../../../shared/utils/roles');

async function createOrder(req, res, next) {
  try {
    const payload = { ...req.body };
    payload.user = { id: req.user.id, email: req.user.email };
    const orders = await orderService.createOrder(payload);
    return created(res, { orders });
  } catch (err) { return next(err); }
}

async function getUserOrders(req, res, next) {
  try {
    if (!isAdmin(req.user) && req.params.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: cannot view other users orders', errors: [] });
    }
    const orders = await orderService.getUserOrders(req.params.userId);
    return ok(res, { orders });
  } catch (err) { return next(err); }
}

/**
 * Get orders for a specific seller.
 * - SELLER can only retrieve their own orders
 * - ADMIN can retrieve any seller's orders
 * - CUSTOMER cannot access this endpoint (handled by authorize middleware)
 */
async function getSellerOrders(req, res, next) {
  try {
    const { sellerId } = req.params;
    
    // Validate ownership: seller can only see their own orders
    await orderService.validateSellerOwnership(sellerId, req.user.id, req.user.role);
    
    const orders = await orderService.getSellerOrders(sellerId);
    return ok(res, { orders });
  } catch (err) { return next(err); }
}

/**
 * Update order status.
 * - SELLER can only update orders they own
 * - ADMIN can update any order
 */
async function updateOrderStatus(req, res, next) {
  try {
    const { orderId } = req.params;

    if (isSeller(req.user) && !isAdmin(req.user) && req.body.status !== ORDER_STATUSES.CONFIRMED) {
      return res.status(409).json({ success: false, code: 'DELIVERY_OWNS_SHIPMENT_STATUS', message: 'Sellers may confirm an order; shipment statuses are managed through Delivery', errors: [] });
    }
    
    // Validate ownership before updating
    await orderService.validateOrderOwnership(orderId, req.user.id, req.user.role);
    
    const order = await orderService.updateOrderStatus(orderId, req.body);
    return ok(res, { order });
  } catch (err) { return next(err); }
}

async function refundOrder(req, res, next) {
  try {
    const order = await orderService.refundOrder(req.params.orderId, req.body, req.user);
    return ok(res, { order, message: 'Refund request sent to the seller' });
  } catch (err) { return next(err); }
}

/**
 * Mark refund as successful.
 * - SELLER can only refund orders they own
 * - ADMIN can refund any order
 */
async function orderRefundSuccess(req, res, next) {
  try {
    const { orderId } = req.params;
    
    // Validate ownership before processing refund
    await orderService.validateOrderOwnership(orderId, req.user.id, req.user.role);
    
    const order = await orderService.refundSuccess(orderId, req.body);
    return ok(res, { order });
  } catch (err) { return next(err); }
}

/**
 * Get a single order by ID.
 * - SELLER can only get their own orders
 * - CUSTOMER can only get their own orders
 * - ADMIN can get any order
 */
async function getOrder(req, res, next) {
  try {
    const { orderId } = req.params;
    
    // Validate ownership: users can only access their own orders
    await orderService.validateOrderOwnership(orderId, req.user.id, req.user.role);
    
    const order = await orderService.getOrderById(orderId);
    return ok(res, { order });
  } catch (err) { return next(err); }
}

/**
 * PHASE 2: Confirm payment for an order.
 * - Atomically claims the confirmation (one winner — no double deduct)
 * - Deducts stock + consumes this order's reservation (idempotent per line)
 * - Rolls the claim back if the deduct fails, so the client may retry
 */
async function confirmPayment(req, res, next) {
  const err = new Error('Payment confirmation must come from a verified settlement event');
  err.statusCode = 409;
  err.code = 'PAYMENT_SETTLEMENT_REQUIRED';
  return next(err);
}

/**
 * PHASE 2: Cancel an order.
 * - Releases reserved inventory
 * - Sets order status to CANCELLED
 * - Sets paymentStatus appropriately
 * - Creates stock movement audit trail
 */
async function cancelOrder(req, res, next) {
  try {
    const { orderId } = req.params;
    const { reason } = req.body || {};
    
    // Validate ownership
    await orderService.validateOrderOwnership(orderId, req.user.id, req.user.role);
    
    const order = await orderService.cancelOrder(orderId, reason || 'Order cancelled by customer');
    
    return ok(res, { order, message: 'Order cancelled and inventory released' });
  } catch (err) { return next(err); }
}

/**
 * PHASE 2: Get real-time inventory availability.
 * Returns stock, reserved, and available quantities.
 */
async function getInventoryAvailability(req, res, next) {
  try {
    const { productId } = req.params;
    const availability = await orderService.getInventoryAvailability(productId);
    return ok(res, { availability });
  } catch (err) { return next(err); }
}

/**
 * Delivery info for one order — read from the ORDER ↔ DELIVERY bridge table.
 *
 * That table is what connects an order to its shipment (both services key it by
 * the order id), so this is the single endpoint that answers "what is happening
 * with this order's delivery?" without a cross-service call. Authorization
 * follows the ORDER's ownership (buyer / owning seller / admin), so a delivery
 * detail can never be used to probe someone else's shipment.
 */
async function getOrderDelivery(req, res, next) {
  try {
    await orderService.validateOrderOwnership(req.params.orderId, req.user.id, req.user.role);
    const delivery = await orderDeliveryService.getByOrderId(req.params.orderId);
    if (!delivery) {
      return res.status(404).json({ success: false, message: 'No delivery linked to this order', errors: [] });
    }
    return ok(res, { delivery });
  } catch (err) { return next(err); }
}

module.exports = {
  createOrder,
  getUserOrders,
  getSellerOrders,
  updateOrderStatus,
  refundOrder,
  orderRefundSuccess,
  getOrder,
  getOrderDelivery,
  confirmPayment,
  cancelOrder,
  getInventoryAvailability
};
