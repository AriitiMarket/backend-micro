const orderDeliveryRepository = require('../repositories/orderDelivery.repository');

/**
 * ORDER ↔ DELIVERY bridge service — the one place that reads/writes the link
 * between a marketplace order and its shipment.
 *
 * Write side:
 *   checkout      -> `linkForOrder`  (order id + the delivery brief handed to
 *                                    the Delivery Service)
 *   request sent  -> `attachRequest` (deliveryRequestId, once it exists)
 *   status event  -> `recordDeliveryEvent` (delivery-owned status/actor/note)
 * Read side:
 *   `getByOrderId` -> what any role needs to show delivery info for an order.
 */
class OrderDeliveryService {
  /**
   * Create the link as part of the checkout. It is written INSIDE the checkout
   * transaction boundary: an order row without its link would immediately be
   * the "two sources of truth" problem this table exists to avoid, so a failure
   * here rolls the order back like any other failure.
   *
   * The brief stored here is exactly what `_createDeliveryRequest` sends to the
   * Delivery Service — either side can re-derive the delivery info from it.
   */
  async linkForOrder(order, shipment, destinationSnapshot) {
    if (!order) return null;
    return orderDeliveryRepository.create({
      orderId: String(order._id),
      handoffStatus: 'WAITING_APPROVAL',
      status: null,
      createdFrom: 'checkout',
      pickupLocationId: (shipment && shipment.origin && (shipment.origin.sectorId || shipment.origin.cityId || shipment.origin.areaId)) || null,
      destinationLocationId: (destinationSnapshot && (destinationSnapshot.sectorId || destinationSnapshot.cityId || destinationSnapshot.areaId)) || null,
      pickupAddress: shipment ? shipment.origin : null,
      deliveryAddress: destinationSnapshot || null,
      items: (shipment ? shipment.items : []).map((item) => ({
        name: item.name || '',
        quantity: item.quantity,
        value: item.discountPrice || item.price || 0,
      })),
      totalValue: (shipment && shipment.subtotal) || 0,
    });
  }

  /**
   * Record the identifiers once the delivery request exists. Best-effort: the
   * request is fired after the checkout commits, so a failure here is logged
   * and retried by the next status event (the link itself already exists).
   */
  async attachRequest(orderId, deliveryRequestId) {
    try {
      return await orderDeliveryRepository.attach(orderId, { deliveryRequestId: String(deliveryRequestId), handoffStatus: 'COMPLETED' });
    } catch (err) {
      console.error(`[orderDelivery] attach request failed for order ${orderId}:`, err.message);
      return null;
    }
  }

  markHandoffAbandoned(orderId) {
    return orderDeliveryRepository.attach(orderId, { handoffStatus: 'ABANDONED' });
  }

  queueHandoff(orderId) {
    return orderDeliveryRepository.attach(orderId, { handoffStatus: 'PENDING' });
  }

  waitForOrderApproval(orderId) {
    return orderDeliveryRepository.attach(orderId, { handoffStatus: 'WAITING_APPROVAL' });
  }

  /**
   * Apply a delivery-owned status event (from the Delivery Service webhook).
   * Always upserts by order id, so an event can arrive before checkout wrote
   * the link and still land.
   */
  async recordDeliveryEvent({ orderId, deliveryId, deliveryRequestId, providerId, serviceId, status, note }) {
    if (!orderId) return null;
    const fields = {};
    if (deliveryId) fields.deliveryId = String(deliveryId);
    if (deliveryRequestId) fields.deliveryRequestId = String(deliveryRequestId);
    if (providerId) fields.providerId = String(providerId);
    if (serviceId) fields.serviceId = String(serviceId);
    if (status) fields.status = status;
    if (note) fields.note = String(note).slice(0, 500);
    if (status) fields.statusUpdatedAt = new Date();
    return orderDeliveryRepository.upsertByOrderId(orderId, fields);
  }

  /** The delivery info for one order (null when it never shipped). */
  getByOrderId(orderId) {
    if (!orderId) return Promise.resolve(null);
    return orderDeliveryRepository.findByOrderIdLoose(orderId);
  }

  findWithoutDeliveryRequest(limit) {
    return orderDeliveryRepository.findWithoutDeliveryRequest(limit);
  }

  /**
   * Delivery summaries for a LIST of orders, in ONE query — what order lists
   * (buyer / seller / admin) attach to each row so shipment progress is visible
   * without a cross-service call or a per-row request.
   */
  getSummariesByOrderIds(orderIds = []) {
    return orderDeliveryRepository.findSummariesByOrderIds(orderIds);
  }

  /** Checkout compensation: the order row goes, so does its link. */
  async removeByOrderId(orderId) {
    try {
      await orderDeliveryRepository.deleteByOrderId(orderId);
    } catch (err) {
      console.error(`[orderDelivery] cleanup failed for order ${orderId}:`, err.message);
    }
  }
}

module.exports = new OrderDeliveryService();
