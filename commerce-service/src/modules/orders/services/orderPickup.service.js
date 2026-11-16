'use strict';

/**
 * Order Pickup & Receipt Confirmation Service
 * Handles code-verified shop pickups and buyer receipt confirmation.
 */

const crypto = require('crypto');
const orderRepository = require('../repositories/orders.repository');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');
const { isAdmin } = require('../../../shared/utils/roles');
const notificationService = require('../../../shared/services/notification.service');

async function notifyOrderStatus(order, previousStatus, nextStatus) {
  try {
    await notificationService.notifyOrderStatus(order, previousStatus, nextStatus);
  } catch (err) {
    console.warn(`Notification failed for order ${order._id}: ${err.message}`);
  }
}

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderPickupService {
  /**
   * Verify 6-digit pickup code
   */
  async verifyPickup(orderId, suppliedCode, actorId) {
    const order = await orderRepository.findById(orderId, { pickupCode: true });
    if (!order) throw new ApiError('Order not found', 404);
    if (order.fulfilmentType !== 'pickup') throw new ApiError('This order is not a pickup order', 422);
    if (String(order.sellerId) !== String(actorId)) throw new ApiError('You cannot verify pickup for this order', 403);
    if (order.status === ORDER_STATUSES.DELIVERED || order.pickupCompletedAt) throw new ApiError('Pickup already completed', 409);
    if (order.status !== ORDER_STATUSES.SHIPPED) throw new ApiError('Order is not ready for pickup', 409);
    if (Number(order.pickupCodeAttempts || 0) >= 5) throw new ApiError('Pickup code verification is locked', 429);

    const code = String(suppliedCode || '');
    const suppliedHash = crypto.createHash('sha256').update(code).digest();
    const storedHash = Buffer.from(String(order.pickupCodeHash || ''), 'hex');
    const valid = /^\d{6}$/.test(code) && storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
    if (!valid) {
      const updated = await orderRepository.incrementPickupCodeAttempt(orderId);
      const locked = !updated || Number(updated.pickupCodeAttempts) >= 5;
      throw new ApiError(locked ? 'Pickup code verification is locked' : 'Invalid pickup code', locked ? 429 : 422);
    }
    const completed = await orderRepository.claimPickupCompletion(orderId, storedHash.toString('hex'), actorId);
    if (!completed) throw new ApiError('Pickup was already completed or the code is no longer valid', 409);
    await notifyOrderStatus(completed, ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED);
    return completed;
  }

  /**
   * Buyer confirms receipt of a delivered order.
   */
  async confirmReceipt(orderId, actor) {
    let order = await orderRepository.findById(orderId);
    let orderGroupId = order?.orderGroupId;

    if (!order) {
      const ordersInGroup = await orderRepository.findByOrderGroupId(orderId);
      if (ordersInGroup && ordersInGroup.length > 0) {
        orderGroupId = orderId;
        order = ordersInGroup[0];
      }
    }

    if (!order) throw new ApiError('Order not found', 404);

    const actorId = String(actor?.id || actor?.sub || '');
    const isBuyerOfOrder = String(order.buyerId || order.user?._id || order.user?.id || '') === actorId;
    if (!isBuyerOfOrder && !isAdmin(actor)) {
      throw new ApiError('You can only confirm receipt for your own order', 403);
    }

    const currentStatus = normalizeStatus(order.status);
    if (currentStatus !== ORDER_STATUSES.DELIVERED) {
      throw new ApiError(`Order must be in Delivered status to confirm receipt (current status: ${currentStatus})`, 409);
    }

    if (orderGroupId) {
      const groupOrders = await orderRepository.findByOrderGroupId(orderGroupId);
      for (const ord of groupOrders) {
        if (String(ord.buyerId) !== String(order.buyerId)) continue;
        const status = normalizeStatus(ord.status);
        if (status === ORDER_STATUSES.DELIVERED && !ord.buyerConfirmedReceipt) {
          ord.buyerConfirmedReceipt = true;
          ord.buyerConfirmedAt = new Date();
          if (!ord.timeline) ord.timeline = [];
          ord.timeline.push({
            status: ORDER_STATUSES.DELIVERED,
            previousStatus: status,
            timestamp: new Date(),
            actor: actorId,
            actorRole: 'BUYER',
            reason: 'Buyer confirmed receipt of consolidated order',
          });
          await ord.save();
        }
      }
      return await orderRepository.findById(order._id);
    }

    if (order.buyerConfirmedReceipt) {
      return order;
    }

    order.buyerConfirmedReceipt = true;
    order.buyerConfirmedAt = new Date();
    if (!order.timeline) order.timeline = [];
    order.timeline.push({
      status: ORDER_STATUSES.DELIVERED,
      previousStatus: currentStatus,
      timestamp: new Date(),
      actor: actorId,
      actorRole: 'BUYER',
      reason: 'Buyer confirmed receipt of order',
    });

    await order.save();
    return order;
  }
}

module.exports = new OrderPickupService();
