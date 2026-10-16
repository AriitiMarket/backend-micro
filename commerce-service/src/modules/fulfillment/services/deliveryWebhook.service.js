const ordersRepository = require('../repositories/orders.repository');
const orderDeliveryService = require('./orderDelivery.service');
const paymentRepository = require('../repositories/payments.repository');
const orderService = require('./orders.service');
const allocationService = require('./allocation.service');
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

/**
 * The delivery state machine's own vocabulary, accepted from the delivery
 * service's webhook.
 *
 * This is the CONTRACT list, not the delivery service's full enum: it is
 * duplicated here because the two are separate services, and it is what decides
 * whether an inbound event is understood or rejected with a 400. It is written
 * out in full (rather than delegating to DELIVERY_TO_ORDER_STATUS keys) because a
 * delivery status that advances no order is still a status the webhook must
 * accept rather than 400 on.
 *
 * Kept byte-identical to `delivery-service/src/shared/constants` `DELIVERY_STATUSES`.
 */
const DELIVERY_STATUSES = [
  'pending', 'assigned', 'reassigned', 'pickup', 'in_transit', 'delivered', 'failed', 'cancelled',
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
async function notifyStatusUpdate(deliveryId, orderId, status, providerId, note, proofOfDelivery = null) {
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

  if (deliveryStatus === 'delivered' && String(order.paymentInfo?.method || '').toUpperCase() === 'COD') {
    const collected = Number(proofOfDelivery?.codCollectedAmount);
    if (proofOfDelivery?.codConfirmed !== true || !Number.isFinite(collected) || collected !== Number(order.totalPrice)) {
      const err = new Error('COD delivery requires confirmation of the exact order total');
      err.statusCode = 400;
      throw err;
    }
    if (order.paymentStatus !== 'CONFIRMED') {
      if (order.paymentStatus === 'SETTLING') {
        const err = new Error('COD settlement is already in progress; retry this delivery event');
        err.statusCode = 409;
        throw err;
      }
      const settlementClaim = await ordersRepository.claimCODSettlement(orderId);
      if (!settlementClaim) {
        const err = new Error('Could not claim COD settlement; retry this delivery event');
        err.statusCode = 409;
        throw err;
      }
      try {
        await orderService.deductInventoryOnPayment(order.cart || [], orderId);
        await paymentRepository.upsertByOrder(orderId, {
          userId: String(order.buyerId || order.user?.id || order.user?._id || ''),
          sellerId: String(order.sellerId || ''),
          paymentMethod: 'COD',
          amount: Number(order.totalPrice),
          currency: order.currency || 'ETB',
          status: 'COMPLETED',
          metadata: { settlementSource: 'delivery_cod', deliveryId: String(deliveryId), confirmedAt: new Date() },
        });
        await ordersRepository.updateFields(orderId, {
          paymentStatus: 'CONFIRMED',
          paymentSettlementStartedAt: null,
          paidAt: order.paidAt || new Date(),
          paymentInfo: { ...(order.paymentInfo?.toObject?.() || order.paymentInfo || {}), status: 'CONFIRMED' },
        });

        // Compute seller-level allocations from the confirmed payment. Idempotent:
        // a duplicate webhook finds paymentStatus already CONFIRMED (line 78) and
        // never re-enters this block, so allocations are created exactly once.
        try {
          const confirmedOrder = await ordersRepository.findById(orderId);
          await allocationService.allocateOrder(confirmedOrder, null);
        } catch (allocErr) {
          // Allocation must not fail a confirmed payment; log and continue.
          console.error('[deliveryWebhook] allocation failed for order', orderId, allocErr.message);
        }
      } catch (err) {
        await ordersRepository.releaseCODSettlement(orderId).catch(() => null);
        throw err;
      }
    }
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

  if (deliveryStatus === 'delivered' && String(order.paymentInfo?.method || '').toUpperCase() === 'COD') {
    orderFields.paymentStatus = 'CONFIRMED';
    orderFields.paymentSettlementStartedAt = null;
    orderFields.paidAt = order.paidAt || new Date();
    orderFields.paymentInfo = { ...(order.paymentInfo?.toObject?.() || order.paymentInfo || {}), status: 'CONFIRMED' };
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
