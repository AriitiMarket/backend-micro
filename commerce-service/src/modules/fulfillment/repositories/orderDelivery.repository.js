const OrderDelivery = require('../models/OrderDeliveries');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

/**
 * Data access for the ORDER ↔ DELIVERY bridge. The key is always the ORDER id
 * (unique): the Delivery Service stores `orderId` on its own records, so both
 * services resolve a shipment with the same identifier.
 */
class OrderDeliveryRepository {
  /** Create the link when the order is created (checkout). */
  create(data) { return OrderDelivery.create(data); }

  /** The delivery info for one order — null when the order never linked. */
  findByOrderId(orderId) {
    if (!orderId || !isValidObjectId(orderId)) return Promise.resolve(null);
    return OrderDelivery.findOne({ orderId: String(orderId) });
  }

  /** Same, for the admin/seller surfaces that may carry a non-ObjectId id. */
  findByOrderIdLoose(orderId) {
    if (!orderId) return Promise.resolve(null);
    return OrderDelivery.findOne({ orderId: String(orderId) });
  }

  /**
   * Batched read for ORDER LISTS: one query for N orders (never one query per
   * row). Only the delivery-owned summary fields are projected — a list has no
   * use for the pickup/destination snapshots.
   */
  findSummariesByOrderIds(orderIds = []) {
    const ids = (orderIds || []).map(String).filter(Boolean);
    if (!ids.length) return Promise.resolve([]);
    return OrderDelivery.find(
      { orderId: { $in: ids } },
      { orderId: 1, deliveryId: 1, deliveryRequestId: 1, status: 1, statusUpdatedAt: 1, updatedAt: 1 }
    ).lean();
  }

  /**
   * Idempotent write keyed by the order id — used by delivery status events, so
   * replayed webhooks simply update the same row (upsert: an event may arrive
   * before checkout finished writing the link).
   */
  upsertByOrderId(orderId, fields = {}) {
    return OrderDelivery.findOneAndUpdate(
      { orderId: String(orderId) },
      { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
  }

  /** Attach the delivery-service identifiers once a request/delivery exists. */
  attach(orderId, fields = {}) {
    if (!orderId || !isValidObjectId(orderId)) return Promise.resolve(null);
    return OrderDelivery.findOneAndUpdate(
      { orderId: String(orderId) },
      { $set: { ...fields, updatedAt: new Date() } },
      { new: true }
    );
  }

  findWithoutDeliveryRequest(limit = 100) {
    return OrderDelivery.find({ handoffStatus: { $in: ['PENDING', null] }, deliveryRequestId: null }, { orderId: 1 })
      .sort({ createdAt: 1 }).limit(Math.min(Math.max(Number(limit) || 100, 1), 500)).lean();
  }

  /** Remove the link (checkout compensation — the order row goes away too). */
  deleteByOrderId(orderId) {
    if (!orderId || !isValidObjectId(orderId)) return Promise.resolve(null);
    return OrderDelivery.deleteOne({ orderId: String(orderId) });
  }
}

module.exports = new OrderDeliveryRepository();
