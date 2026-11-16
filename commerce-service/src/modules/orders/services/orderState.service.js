/**
 * Order State Machine Enforcement & Operational Lifecycle Mapping
 * Unified service managing order state transitions, atomic operations, and operational stage translation
 */
'use strict';

const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const inventoryService = require('./inventory.service');
const notificationService = require('../../../shared/services/notification.service');
const allocationService = require('./allocation.service');
const walletsService = require('../../finance/services/wallets.service');
const { ORDER_STATUSES, ALLOWED_TRANSITIONS, normalizeStatus } = require('../constants/orderStatuses');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const VALID_TRANSITIONS = ALLOWED_TRANSITIONS;

// --- Operational Lifecycle Mapping Constants ---
const OPERATIONAL_STAGES = Object.freeze([
  'new',
  'accepted',
  'ready_for_pickup',
  'pickup_assigned',
  'picked_up',
  'in_transit',
  'delivered',
  'completed',
  'cancelled',
  'exception',
]);

const OPERATIONAL_STAGE_LABELS = Object.freeze({
  new: 'New',
  accepted: 'Accepted',
  ready_for_pickup: 'Ready for Pickup',
  pickup_assigned: 'Pickup Assigned',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  exception: 'Exception',
});

const UNSUPPORTED_STAGES = Object.freeze([
  { stage: 'preparing', reason: 'No commerce/delivery status records a merchant preparing step' },
  { stage: 'arrived_at_dropoff', reason: 'Delivery service records in_transit -> delivered only' },
]);

const EXCEPTION_ORDER_STATUSES = Object.freeze([
  'Refund Requested',
  'Refund Approved',
  'Refund Success',
  'Refund Rejected',
]);

const ORDER_STATUS_STAGE = Object.freeze({
  Processing: 'new',
  Confirmed: 'accepted',
  Shipped: 'in_transit',
  'In Transit': 'in_transit',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
  PENDING: 'new',
  CONFIRMED: 'accepted',
  SHIPPED: 'in_transit',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
});

const DELIVERY_STATUS_STAGE = Object.freeze({
  pending: 'ready_for_pickup',
  assigned: 'pickup_assigned',
  reassigned: 'pickup_assigned',
  pickup: 'picked_up',
  in_transit: 'in_transit',
  delivered: 'delivered',
  failed: 'exception',
  cancelled: 'cancelled',
});

const ORDER_LOOKUP = Object.freeze(
  Object.entries(ORDER_STATUS_STAGE).reduce((map, [key, value]) => {
    map[key.trim().toLowerCase()] = value;
    return map;
  }, {})
);

const DELIVERY_LOOKUP = Object.freeze(
  Object.entries(DELIVERY_STATUS_STAGE).reduce((map, [key, value]) => {
    map[key.trim().toLowerCase()] = value;
    return map;
  }, {})
);

const EXCEPTION_LOOKUP = Object.freeze(
  EXCEPTION_ORDER_STATUSES.reduce((map, status) => {
    map[status.trim().toLowerCase()] = status;
    return map;
  }, {})
);

const normalizeLifecycleStatus = (status) => String(status || '').trim().toLowerCase();

function mapOrderStatusToStage(status) {
  const normalized = normalizeLifecycleStatus(status);
  if (EXCEPTION_LOOKUP[normalized]) return 'exception';
  return ORDER_LOOKUP[normalized] || 'new';
}

function isSettled(order) {
  return String((order && order.paymentStatus) || '').toUpperCase() === 'CONFIRMED';
}

function mapOrderToOperationalStage(order, delivery) {
  if (!order) return { stage: 'new', source: 'none', reason: 'order missing' };

  const orderStatus = order.status;
  const deliveryStatus = delivery && delivery.status;
  const orderKey = normalizeLifecycleStatus(orderStatus);
  const deliveryKey = normalizeLifecycleStatus(deliveryStatus);

  if (orderKey === 'cancelled' || orderKey === 'canceled' || (deliveryKey === 'cancelled' && orderKey !== 'delivered')) {
    return { stage: 'cancelled', source: 'order/delivery', reason: 'Cancelled' };
  }

  if (EXCEPTION_LOOKUP[orderKey]) {
    return { stage: 'exception', source: 'order', reason: orderStatus };
  }

  if (deliveryKey === 'failed') {
    return { stage: 'exception', source: 'delivery', reason: 'Delivery failed' };
  }

  if (deliveryKey && DELIVERY_LOOKUP[deliveryKey]) {
    const stage = DELIVERY_LOOKUP[deliveryKey];
    if (stage === 'delivered') {
      return isSettled(order)
        ? { stage: 'completed', source: 'delivery+payment', reason: 'Delivered and settled' }
        : { stage: 'delivered', source: 'delivery', reason: 'Delivered, payment not settled' };
    }
    return { stage, source: 'delivery', reason: `delivery ${deliveryStatus}` };
  }

  if (ORDER_LOOKUP[orderKey]) {
    const stage = ORDER_LOOKUP[orderKey];
    if (stage === 'delivered') {
      return isSettled(order)
        ? { stage: 'completed', source: 'order+payment', reason: 'Delivered and settled' }
        : { stage: 'delivered', source: 'order', reason: 'Delivered, payment not settled' };
    }
    return { stage, source: 'order', reason: `order ${orderStatus}` };
  }

  return { stage: 'new', source: 'fallback', reason: `unmapped status "${orderStatus}"` };
}

function mapDeliveryStatusToStage(status) {
  return DELIVERY_LOOKUP[normalizeLifecycleStatus(status)] || 'exception';
}

function stageLabel(stage) {
  return OPERATIONAL_STAGE_LABELS[stage] || stage;
}

class OrderStateService {
  buildHandoffData(order) {
    const shipment = order.sellerShipments?.[0] || {};
    const destination = order.destination || {};
    const buyer = order.user || {};
    return {
      orderId: String(order._id),
      orderGroupId: order.orderGroupId,
      sellerId: order.sellerId || shipment.sellerId,
      buyerId: order.buyerId,
      shopId: order.shopId || shipment.shopId,
      paymentMethod: order.paymentInfo?.method || 'COD',
      paymentAmount: order.totalPrice,
      deliveryFee: Number(order.shippingFee) || 0,
      deliveryFeeRuleId: order.deliveryFeeRuleId || null,
      delivererShareRate: Number(order.delivererShareRate ?? 80),
      items: (order.cart || []).map((item) => ({
        productId: item.productId || item._id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit || 'pcs',
        condition: 'good',
        value: item.discountPrice || item.price || 0,
        image: item.image || (Array.isArray(item.images) ? item.images[0] : '') || '',
        images: Array.isArray(item.images) ? item.images : (item.image ? [item.image] : []),
      })),
      totalValue: Number(order.subtotal) || 0,
      origin: {
        ...(shipment.origin || {}),
        shopId: order.shopId || shipment.shopId || '',
        shopName: shipment.shopName || order.cart?.[0]?.shopName || '',
        businessId: shipment.businessId || null,
      },
      destination: {
        ...destination,
        zoneId: destination.zoneId || destination.deliveryZoneId || order.deliveryZoneId || null,
        portId: destination.portId || order.portId || null,
        portName: destination.portName || order.portName || '',
        contactName: destination.contactName || buyer.name || '',
        contactPhone: destination.contactPhone || destination.phone || '',
      },
      idempotencyKey: `order:${order._id}`,
    };
  }

  async deliverHandoff(order) {
    const { deliveryClient } = require('../../../app/clients/delivery.client');
    const orderDeliveryService = require('./orderDelivery.service');
    const orderId = String(order._id);
    const handoffData = this.buildHandoffData(order);

    await orderDeliveryService.queueHandoff(orderId);
    const result = await deliveryClient.createDeliveryRequest(handoffData);

    const requestId = result.body?.deliveryRequestId
      || result.body?.request?.id
      || result.body?.request?._id
      || null;

    if (result.ok && requestId) {
      await orderDeliveryService.attachRequest(orderId, requestId);
      return { ok: true, requestId };
    }
    if (result.status >= 400 && result.status < 500) {
      await orderDeliveryService.markHandoffAbandoned(orderId);
      console.warn(`[handoff] Order ${orderId} handoff abandoned: ${result.body?.message || 'Delivery service rejected'}`);
      return { ok: false, reason: 'rejected' };
    }
    await orderDeliveryService.waitForOrderApproval(orderId);
    return { ok: false, reason: 'pending' };
  }

  validateTransition(currentStatus, targetStatus) {
    const current = normalizeStatus(currentStatus);
    const target = normalizeStatus(targetStatus);

    const allowed = VALID_TRANSITIONS[current] || [];
    return allowed.includes(target);
  }

  async confirmOrder(orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const currentStatus = normalizeStatus(order.status);

      const ALREADY_CONFIRMED = [
        ORDER_STATUSES.CONFIRMED,
        ORDER_STATUSES.SHIPPED,
        ORDER_STATUSES.DELIVERED,
        ORDER_STATUSES.COMPLETED,
      ];
      if (ALREADY_CONFIRMED.includes(currentStatus)) {
        if (session.inTransaction()) await session.abortTransaction();
        return order;
      }

      if (!this.validateTransition(currentStatus, ORDER_STATUSES.CONFIRMED)) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError(
          `Cannot transition from ${currentStatus} to ${ORDER_STATUSES.CONFIRMED}`,
          409
        );
      }

      for (const item of (order.cart || [])) {
        const available = await inventoryService.getAvailableStock(item.productId);
        if (available < item.quantity) {
          if (session.inTransaction()) await session.abortTransaction();
          throw new ApiError(
            `Insufficient stock for ${item.name}: ${available} available, ${item.quantity} requested`,
            422
          );
        }
      }

      for (const item of (order.cart || [])) {
        await inventoryService.finalizeReservation(
          item.productId,
          item.quantity,
          orderId
        );
      }

      const previousStatus = currentStatus;
      order.status = ORDER_STATUSES.CONFIRMED;
      order.confirmedAt = new Date();
      order.confirmedBy = context.userId || null;

      await order.save({ session });
      await session.commitTransaction();

      try {
        if (order.buyerId) {
          await notificationService.notifyOrderConfirmed(order);
        }
      } catch (err) {
        console.warn(`Notification failed for order ${orderId}: ${err.message}`);
      }

      if (order.fulfilmentType === 'pickup') return order;

      try {
        await this.deliverHandoff(order);
      } catch (err) {
        console.error(`[confirmOrder] Delivery handoff failed for order ${orderId}:`, err.message);
        const orderDeliveryService = require('./orderDelivery.service');
        await orderDeliveryService.waitForOrderApproval(orderId);
      }

      return order;
    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async transitionOrder(orderId, newStatus, context = {}, options = {}) {
    const session = options.session || await mongoose.startSession();
    const ownsSession = !options.session;
    
    try {
      if (ownsSession) session.startTransaction();

      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (ownsSession && session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const currentStatus = normalizeStatus(order.status);
      const targetStatus = normalizeStatus(newStatus);

      if (currentStatus === targetStatus) {
        if (ownsSession && session.inTransaction()) await session.abortTransaction();
        return order;
      }

      if (!this.validateTransition(currentStatus, targetStatus)) {
        if (ownsSession && session.inTransaction()) await session.abortTransaction();
        throw new ApiError(
          `Cannot transition from ${currentStatus} to ${targetStatus}`,
          409
        );
      }

      const previousStatus = order.status;
      order.status = targetStatus;

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

      if (!ownsSession || options.deferSideEffects) return order;

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
        console.error(
          `Allocation/wallet credit failed for order ${order._id}:`,
          allocErr.message
        );
      }

      try {
        await notificationService.notifyOrderStatus(order, previousStatus, targetStatus);
      } catch (err) {
        console.warn(`Notification failed for order ${orderId}: ${err.message}`);
      }

      return order;
    } catch (err) {
      if (ownsSession && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      if (ownsSession) await session.endSession();
    }
  }

  async approveReturn(orderId, returnId) {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();

      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        if (session.inTransaction()) await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      for (const item of (order.cart || [])) {
        await inventoryService.restoreStock(item.productId, item.quantity, returnId);
      }

      order.status = ORDER_STATUSES.REFUND_APPROVED;
      order.returnId = returnId;
      order.refundApprovedAt = new Date();

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
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getOrderTimeline(orderId) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    return order.timeline || [];
  }

  // Lifecycle proxy methods on the service instance
  mapOrderToOperationalStage(order, delivery) { return mapOrderToOperationalStage(order, delivery); }
  mapOrderStatusToStage(status) { return mapOrderStatusToStage(status); }
  mapDeliveryStatusToStage(status) { return mapDeliveryStatusToStage(status); }
  stageLabel(stage) { return stageLabel(stage); }
  isSettled(order) { return isSettled(order); }
}

const serviceInstance = new OrderStateService();

// Attach operational lifecycle constants and functions directly to the export
serviceInstance.OPERATIONAL_STAGES = OPERATIONAL_STAGES;
serviceInstance.OPERATIONAL_STAGE_LABELS = OPERATIONAL_STAGE_LABELS;
serviceInstance.UNSUPPORTED_STAGES = UNSUPPORTED_STAGES;
serviceInstance.ORDER_STATUS_STAGE = ORDER_STATUS_STAGE;
serviceInstance.DELIVERY_STATUS_STAGE = DELIVERY_STATUS_STAGE;
serviceInstance.EXCEPTION_ORDER_STATUSES = EXCEPTION_ORDER_STATUSES;
serviceInstance.ORDER_LOOKUP = ORDER_LOOKUP;
serviceInstance.DELIVERY_LOOKUP = DELIVERY_LOOKUP;
serviceInstance.mapOrderToOperationalStage = mapOrderToOperationalStage;
serviceInstance.mapOrderStatusToStage = mapOrderStatusToStage;
serviceInstance.mapDeliveryStatusToStage = mapDeliveryStatusToStage;
serviceInstance.stageLabel = stageLabel;
serviceInstance.isSettled = isSettled;

module.exports = serviceInstance;
module.exports.OPERATIONAL_STAGES = OPERATIONAL_STAGES;
module.exports.OPERATIONAL_STAGE_LABELS = OPERATIONAL_STAGE_LABELS;
module.exports.UNSUPPORTED_STAGES = UNSUPPORTED_STAGES;
module.exports.ORDER_STATUS_STAGE = ORDER_STATUS_STAGE;
module.exports.DELIVERY_STATUS_STAGE = DELIVERY_STATUS_STAGE;
module.exports.EXCEPTION_ORDER_STATUSES = EXCEPTION_ORDER_STATUSES;
module.exports.ORDER_LOOKUP = ORDER_LOOKUP;
module.exports.DELIVERY_LOOKUP = DELIVERY_LOOKUP;
module.exports.mapOrderToOperationalStage = mapOrderToOperationalStage;
module.exports.mapOrderStatusToStage = mapOrderStatusToStage;
module.exports.mapDeliveryStatusToStage = mapDeliveryStatusToStage;
module.exports.stageLabel = stageLabel;
module.exports.isSettled = isSettled;
