const ordersRepository = require('../repositories/orders.repository');
const orderDeliveryService = require('./orderDelivery.service');
const { ORDER_STATUSES, normalizeStatus, canTransition } = require('../constants/orderStatuses');

/**
 * Delivery status (owned by the DELIVERY service) → Commerce order status
 * (owned here).
 *
 * Only the FORWARD journey is mapped. `failed` / `cancelled` / `reassigned`
 * deliberately do NOT move the marketplace order: a failed delivery and a
 * cancelled order are different events, and silently cancelling (or delivering)
 * an order from a delivery event would create a second source of truth for the
 * money. Those states are recorded on the order as `deliveryStatus` and the
 * admin/seller keeps the decision.
 */
const DELIVERY_TO_ORDER_STATUS = {
  pickup: ORDER_STATUSES.SHIPPED,
  in_transit: ORDER_STATUSES.IN_TRANSIT,
  delivered: ORDER_STATUSES.DELIVERED,
};

/** The delivery state machine's own vocabulary (delivery-service constants). */
const DELIVERY_STATUSES = [
  'pending', 'assigned', 'pickup', 'in_transit', 'delivered', 'failed', 'cancelled', 'reassigned',
];

/**
 * Apply a delivery status change to the Commerce order.
 *
 * Contract:
 *   * the order's OWN state machine is authoritative — a delivery event may
 *     only advance the order along a legal transition (never backwards, never
 *     out of Cancelled);
 *   * replaying the same event is a no-op success (idempotent);
 *   * the delivery link (`deliveryId`, `deliveryStatus`, `deliveryUpdatedAt`) is
 *     always recorded, even when the order status does not move;
 *   * an unknown order or an unknown delivery status is a 404/400, never a 500.
 */
async function notifyStatusUpdate(deliveryId, orderId, status, providerId, note) {
  if (!orderId) return { success: false, message: 'No orderId provided' };
  if (!status) return { success: false, message: 'No status provided' };

  const deliveryStatus = String(status).trim().toLowerCase();
  if (!DELIVERY_STATUSES.includes(deliveryStatus)) {
    const err = new Error(`Unknown delivery status: ${status}`);
    err.statusCode = 400;
    throw err;
  }

  const order = await ordersRepository.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const currentStatus = normalizeStatus(order.status);
  const targetStatus = DELIVERY_TO_ORDER_STATUS[deliveryStatus];

  // 1) ALWAYS record the event on the ORDER ↔ DELIVERY bridge (upsert by order
  //    id). This is the table both sides resolve a shipment through.
  await orderDeliveryService.recordDeliveryEvent({
    orderId,
    deliveryId,
    providerId,
    serviceId: null,
    status: deliveryStatus,
    note,
  });

  // 2) Advance the ORDER only along its own state machine (Commerce is the
  //    source of truth for the money; Delivery owns the shipment).
  const orderFields = {};
  let orderStatusApplied = false;
  if (targetStatus && currentStatus === targetStatus) {
    orderStatusApplied = true; // replayed event — already there
  } else if (targetStatus && canTransition(currentStatus, targetStatus)) {
    orderFields.status = targetStatus;
    if (targetStatus === ORDER_STATUSES.DELIVERED) orderFields.deliveredAt = new Date();
    if (targetStatus === ORDER_STATUSES.CANCELLED) orderFields.cancelledAt = new Date();
    orderStatusApplied = true;
  }

  if (Object.keys(orderFields).length > 0) {
    await ordersRepository.updateFields(orderId, orderFields);
  }

  return {
    success: true,
    orderId: String(orderId),
    deliveryStatus,
    orderStatus: orderFields.status || currentStatus,
    orderStatusApplied,
  };
}

module.exports = { notifyStatusUpdate, DELIVERY_TO_ORDER_STATUS };
