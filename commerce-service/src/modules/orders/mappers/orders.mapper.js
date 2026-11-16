'use strict';

/**
 * Order Response DTO Mapper
 * Strips sensitive/internal fields (such as pickupCodeHash, raw internals, __v)
 */

function toOrderResponse(order) {
  if (!order) return null;
  const doc = typeof order.toObject === 'function' ? order.toObject() : { ...order };

  // Never leak pickup code hash or internal operational flags to clients
  delete doc.pickupCodeHash;
  delete doc.__v;

  return {
    id: doc._id || doc.id,
    orderGroupId: doc.orderGroupId,
    requestId: doc.requestId,
    buyerId: doc.buyerId,
    sellerId: doc.sellerId,
    shopId: doc.shopId,
    status: doc.status,
    cart: doc.cart || [],
    shippingAddress: doc.shippingAddress || doc.destination,
    user: doc.user,
    totalPrice: doc.totalPrice,
    subtotal: doc.subtotal,
    shippingFee: doc.shippingFee,
    currency: doc.currency || 'ETB',
    paymentStatus: doc.paymentStatus,
    paymentInfo: doc.paymentInfo,
    fulfilmentType: doc.fulfilmentType,
    sellerShipments: doc.sellerShipments || [],
    timeline: doc.timeline || [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    deliveredAt: doc.deliveredAt,
    cancelledAt: doc.cancelledAt,
  };
}

function toOrderListResponse(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.map(toOrderResponse).filter(Boolean);
}

module.exports = {
  toOrderResponse,
  toOrderListResponse,
};
