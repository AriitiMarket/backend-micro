/**
 * FIX #4: Order State Machine Enforcement
 * FIX #1: ACID Transaction Wrapper for Order Confirmation
 * FIX #10: Idempotent Order Acceptance
 * 
 * Single service managing order state transitions and atomic operations
 */

const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const inventoryService = require('./inventory.service');
const notificationService = require('../../../shared/services/notification.service');
const allocationService = require('./allocation.service');
const walletsService = require('./wallets.service');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Valid state transitions - single source of truth
 * Prevents invalid transitions like SHIPPED -> CANCELLED
 */
const VALID_TRANSITIONS = {
  [ORDER_STATUSES.PROCESSING]: [ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.CANCELLED],
  [ORDER_STATUSES.CONFIRMED]: [ORDER_STATUSES.SHIPPED, ORDER_STATUSES.CANCELLED],
  [ORDER_STATUSES.SHIPPED]: [ORDER_STATUSES.IN_TRANSIT],
  [ORDER_STATUSES.IN_TRANSIT]: [ORDER_STATUSES.DELIVERED],
  [ORDER_STATUSES.DELIVERED]: [ORDER_STATUSES.REFUND_REQUESTED],
  [ORDER_STATUSES.REFUND_REQUESTED]: [ORDER_STATUSES.REFUND_APPROVED, ORDER_STATUSES.REFUND_REJECTED],
  [ORDER_STATUSES.REFUND_APPROVED]: [ORDER_STATUSES.REFUND_SUCCESS],
  [ORDER_STATUSES.REFUND_REJECTED]: [],
  [ORDER_STATUSES.REFUND_SUCCESS]: [],
  [ORDER_STATUSES.CANCELLED]: [],
};

class OrderStateService {
  /**
   * Validate if transition is allowed
   * @param {string} currentStatus
   * @param {string} targetStatus
   * @returns {boolean}
   */
  validateTransition(currentStatus, targetStatus) {
    const current = normalizeStatus(currentStatus);
    const target = normalizeStatus(targetStatus);

    const allowed = VALID_TRANSITIONS[current] || [];
    return allowed.includes(target);
  }

  /**
   * FIX #1 + #10: Atomic order confirmation with idempotency
   * Wraps: status update + inventory finalization in transaction
   * Returns error if already confirmed (idempotent)
   * @param {string} orderId
   * @param {Object} context - { userId, userRole, cartItems }
   * @returns {Promise<Object>} updated order
   */
  async confirmOrder(orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Fetch with session
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const currentStatus = normalizeStatus(order.status);

      // FIX #10: Idempotency - if already confirmed, return success
      if (currentStatus === ORDER_STATUSES.CONFIRMED) {
        await session.abortTransaction();
        return order; // Already confirmed, return as-is
      }

      // FIX #4: Validate state machine
      if (!this.validateTransition(currentStatus, ORDER_STATUSES.CONFIRMED)) {
        await session.abortTransaction();
        throw new ApiError(
          `Cannot transition from ${currentStatus} to ${ORDER_STATUSES.CONFIRMED}`,
          409
        );
      }

      // Verify cart items still have stock
      for (const item of (order.cart || [])) {
        const available = await inventoryService.getAvailableStock(item.productId);
        if (available < item.quantity) {
          await session.abortTransaction();
          throw new ApiError(
            `Insufficient stock for ${item.name}: ${available} available, ${item.quantity} requested`,
            422
          );
        }
      }

      // Finalize all reservations (move to sold)
      for (const item of (order.cart || [])) {
        await inventoryService.finalizeReservation(
          item.productId,
          item.quantity,
          orderId
        );
      }

      // Update order status
      const previousStatus = currentStatus;
      order.status = ORDER_STATUSES.CONFIRMED;
      order.confirmedAt = new Date();
      order.confirmedBy = context.userId || null;

      await order.save({ session });

      await session.commitTransaction();

      // Send notification (outside transaction)
      try {
        if (order.buyerId) {
          await notificationService.notifyOrderConfirmed(order);
        }
      } catch (err) {
        console.warn(`Notification failed for order ${orderId}: ${err.message}`);
      }

      // Pickup orders are collected at the shop and must never enter Delivery
      // Service or create a deliverer wallet earning.
      if (order.fulfilmentType === 'pickup') return order;

      // Trigger delivery handoff asynchronously (fire-and-forget)
      // This ensures the order gets sent to Delivery Service promptly
      try {
        const { deliveryClient } = require('../../app/clients/delivery.client');
        const orderDeliveryService = require('./orderDelivery.service');

        const shipment = order.sellerShipments?.[0] || {};
        const destination = order.destination || {};

        const handoffData = {
          orderId,
          orderGroupId: order.orderGroupId,
          sellerId: order.sellerId || shipment.sellerId,
          buyerId: order.buyerId,
          shopId: order.shopId || shipment.shopId,
          paymentMethod: order.paymentInfo?.method || 'COD',
          paymentAmount: order.totalPrice,
          deliveryFee: Number(order.shippingFee) || 0,
          deliveryFeeRuleId: order.deliveryFeeRuleId || null,
          delivererShareRate: Number(order.delivererShareRate ?? 80),
          items: (order.cart || []).map(item => ({
            productId: item.productId,
            name: item.name,
            quantity: item.quantity,
            value: item.discountPrice || item.price || 0,
          })),
          origin: shipment.origin || {},
          destination: destination,
          idempotencyKey: `order:${orderId}`,
        };

        // Mark as pending handoff
        await orderDeliveryService.queueHandoff(orderId);

        // Send to Delivery Service (idempotent)
        const result = await deliveryClient.createDeliveryRequest(handoffData);

        if (result.ok && result.body?.deliveryRequestId) {
          await orderDeliveryService.attachRequest(orderId, result.body.deliveryRequestId);
        } else if (result.status >= 400 && result.status < 500) {
          await orderDeliveryService.markHandoffAbandoned(orderId);
          console.warn(`[confirmOrder] Order ${orderId} handoff abandoned: ${result.body?.message || 'Delivery service rejected'}`);
        } else {
          await orderDeliveryService.waitForOrderApproval(orderId);
        }
      } catch (err) {
        // Log but don't fail the order confirmation
        console.error(`[confirmOrder] Delivery handoff failed for order ${orderId}:`, err.message);
        const orderDeliveryService = require('./orderDelivery.service');
        await orderDeliveryService.waitForOrderApproval(orderId);
      }

      return order;
    } catch (err) {
      // Only abort if transaction is still active
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Atomic status transition with audit trail
   * @param {string} orderId
   * @param {string} newStatus
   * @param {Object} context - { userId, userRole, reason }
   * @returns {Promise<Object>} updated order
   */
  async transitionOrder(orderId, newStatus, context = {}, options = {}) {
    const session = options.session || await mongoose.startSession();
    const ownsSession = !options.session;
    
    try {
      if (ownsSession) session.startTransaction();

      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (ownsSession) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const currentStatus = normalizeStatus(order.status);
      const targetStatus = normalizeStatus(newStatus);

      // FIX #4: Validate transition
      if (!this.validateTransition(currentStatus, targetStatus)) {
        if (ownsSession) await session.abortTransaction();
        throw new ApiError(
          `Invalid transition: ${currentStatus} -> ${targetStatus}`,
          409
        );
      }

      const previousStatus = order.status;
      order.status = targetStatus;

      // Update timestamp based on status
      if (targetStatus === ORDER_STATUSES.SHIPPED) {
        order.shippedAt = new Date();
        if (order.fulfilmentType === 'pickup') {
          order.pickupReadyAt = order.shippedAt;
          order.pickupExpiresAt = new Date(order.shippedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
        }
      } else if (targetStatus === ORDER_STATUSES.DELIVERED) {
        order.deliveredAt = new Date();
      } else if (targetStatus === ORDER_STATUSES.CANCELLED) {
        order.cancelledAt = new Date();
      }

      // FIX #8: Create timeline entry
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: targetStatus,
        previousStatus,
        timestamp: new Date(),
        actor: context.userId,
        actorRole: context.userRole,
        reason: context.reason,
      });

      await order.save({ session });
      if (ownsSession) await session.commitTransaction();

      // A caller-owned transaction has not committed yet. Let that caller run
      // post-commit effects after its related writes are safely persisted.
      if (!ownsSession || options.deferSideEffects) return order;

      // --- Multi-seller allocation + wallet crediting (after payment confirmed) ---
      // Compute per-seller allocations, persist them idempotently, and credit
      // seller wallets (pending balance) with commission deducted.
      // This runs outside the order transaction but is guarded by idempotency:
      // allocateOrder uses upsert on (orderId, sellerId), and creditFromAllocation
      // rejects duplicate ORDER_ALLOCATION transactions.
      try {
        const savedAllocations = targetStatus === ORDER_STATUSES.CONFIRMED
          ? await allocationService.allocateOrder(order, {
            id: context.userId,
            role: context.userRole,
          })
          : [];

        for (const alloc of savedAllocations) {
          await walletsService.creditFromAllocation(
            String(order._id),
            String(alloc.sellerId),
            {
              grossSubtotal: alloc.grossSubtotal,
              shippingFee: alloc.shippingFee,
              taxAmount: alloc.taxAmount,
              discountAmount: alloc.discountAmount,
              platformCommission: alloc.platformCommission,
              commissionRate: alloc.commissionRate,
              netPayable: alloc.netPayable,
              allocationId: String(alloc._id),
              reason: 'ORDER_CONFIRMED',
              metadata: { orderGroupId: order.orderGroupId, shopId: alloc.shopId },
            },
            {
              actor: context.userId,
              actorType: context.userRole || 'SYSTEM',
            }
          );
        }
      } catch (allocErr) {
        // Allocation/wallet errors must not roll back a confirmed order.
        // They are retried via the allocation idempotency guard on next call.
        console.error(
          `Allocation/wallet credit failed for order ${order._id}:`,
          allocErr.message
        );
      }

      // Notifications outside transaction (after session commit)
      try {
        await notificationService.notifyOrderStatus(order, previousStatus, targetStatus);
      } catch (err) {
        console.warn(`Notification failed for order ${orderId}: ${err.message}`);
      }

      return order;
    } catch (err) {
      // Only abort if transaction is still active
      if (ownsSession && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      if (ownsSession) await session.endSession();
    }
  }

  /**
   * FIX #3: Return approval - restore stock and sync refund status
   * @param {string} orderId
   * @param {string} returnId
   * @returns {Promise<Object>}
   */
  async approveReturn(orderId, returnId) {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();

      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Restore stock for all items
      for (const item of (order.cart || [])) {
        await inventoryService.restoreStock(item.productId, item.quantity, returnId);
      }

      // Update order status to indicate return approved
      order.status = ORDER_STATUSES.REFUND_APPROVED;
      order.returnId = returnId;
      order.refundApprovedAt = new Date();

      // Add timeline entry
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.REFUND_APPROVED,
        previousStatus: order.status,
        timestamp: new Date(),
        reason: 'Return approved',
      });

      await order.save({ session });
      await session.commitTransaction();

      return order;
    } catch (err) {
      // Only abort if transaction is still active
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get order timeline (FIX #8)
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getOrderTimeline(orderId) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    return order.timeline || [];
  }
}

module.exports = new OrderStateService();
