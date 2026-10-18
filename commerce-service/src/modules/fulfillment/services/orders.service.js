/**
 * FIX #7: Server-side Pagination for Orders
 * FIX #12: Delivery Coverage Check on Order Acceptance
 * FIX #1: ACID Transaction Integration
 * FIX #4: State Machine Integration
 * 
 * Unified orders service with pagination, delivery validation,
 * and atomic transaction support
 */

const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const inventoryService = require('./inventory.service');
const orderStateService = require('./orderState.service');
const shopsService = require('../../selling/services/shops.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrdersService {
  /**
   * Create order with stock reservation (FIX #2)
   * @param {Object} orderData
   * @returns {Promise<Object>}
   */
  async createOrder(orderData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Reserve stock for all items
      const reservations = [];
      for (const item of (orderData.cart || [])) {
        const reservation = await inventoryService.reserveStock(
          item.productId,
          item.quantity,
          orderData.orderId,
          'STANDARD'
        );
        reservations.push(reservation);
      }

      // Create order record
      const order = await orderRepository.create(
        {
          ...orderData,
          status: 'PROCESSING',
          createdAt: new Date(),
          reservations,
        },
        { session }
      );

      await session.commitTransaction();
      return order;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * FIX #7: Get orders with server-side pagination
   * Prevents hanging on 10K+ orders
   * @param {string} shopId
   * @param {Object} options - { limit, offset, status, sortBy, sortOrder }
   * @returns {Promise<Object>} { orders, total, page, limit, hasMore }
   */
  async getShopOrders(shopId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      status,
      sortBy = 'createdAt',
      sortOrder = -1,
    } = options;

    // Validate pagination params
    const validatedLimit = Math.min(Math.max(1, limit), 100); // 1-100 items per page
    const validatedOffset = Math.max(0, offset);

    // Build filter
    const filter = { shopId };
    if (status) {
      filter.status = { $regex: status, $options: 'i' };
    }

    // Query with pagination
    const [orders, total] = await Promise.all([
      orderRepository.find({
        filter,
        limit: validatedLimit,
        offset: validatedOffset,
        sort: { [sortBy]: sortOrder },
      }),
      orderRepository.countByFilter(filter),
    ]);

    const page = Math.floor(validatedOffset / validatedLimit) + 1;
    const totalPages = Math.ceil(total / validatedLimit);

    return {
      orders,
      total,
      page,
      limit: validatedLimit,
      totalPages,
      hasMore: page < totalPages,
      offset: validatedOffset,
    };
  }

  /**
   * Get all orders of a single shop (with seller context)
   * @param {string} shopId
   * @param {Object} query - { page, limit, status }
   * @returns {Promise<Object>}
   */
  async getAllOrdersOfShop(shopId, query = {}) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(parseInt(query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    return this.getShopOrders(shopId, {
      limit,
      offset,
      status: query.status,
      sortBy: query.sortBy || 'createdAt',
      sortOrder: query.sortOrder === 'asc' ? 1 : -1,
    });
  }

  /**
   * FIX #12: Confirm order with delivery coverage check
   * Verifies buyer zone is in shop's delivery coverage
   * @param {string} orderId
   * @param {Object} context - { userId, userRole }
   * @returns {Promise<Object>}
   */
  async confirmOrder(orderId, context = {}) {
    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        throw new ApiError('Order not found', 404);
      }

      // Get shop and buyer info
      const shop = await shopsService.getShopById(order.shopId);
      if (!shop) {
        throw new ApiError('Shop not found', 404);
      }

      // FIX #12: Check delivery coverage
      const buyerZone = order.destination?.zone || order.buyer?.zone;
      const deliveryCoverage = shop.deliveryCoverage || [];

      if (
        deliveryCoverage.length > 0 &&
        !deliveryCoverage.includes(buyerZone)
      ) {
        throw new ApiError(
          `Order destination zone (${buyerZone}) not in shop delivery coverage: ${deliveryCoverage.join(
            ', '
          )}`,
          422
        );
      }

      // Use atomic confirmation from orderStateService
      return await orderStateService.confirmOrder(orderId, context);
    } catch (err) {
      throw err;
    }
  }

  /**
   * Transition order status
   * @param {string} orderId
   * @param {string} newStatus
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async updateOrderStatus(orderId, newStatus, context = {}) {
    return orderStateService.transitionOrder(orderId, newStatus, context);
  }

  /**
   * Get order timeline
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getOrderTimeline(orderId) {
    return orderStateService.getOrderTimeline(orderId);
  }

  /**
   * Cancel order (releases reservation)
   * @param {string} orderId
   * @param {Object} context - { userId, reason }
   * @returns {Promise<Object>}
   */
  async cancelOrder(orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Release all reservations with current session
      for (const item of (order.cart || [])) {
        await inventoryService.releaseReservation(
          item.productId,
          item.quantity,
          orderId,
          { session }
        );
      }

      // Update status
      order.status = 'CANCELLED';
      order.cancelledAt = new Date();
      order.cancelledBy = context.userId;
      order.cancellationReason = context.reason;

      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: 'CANCELLED',
        previousStatus: order.status,
        timestamp: new Date(),
        reason: context.reason,
      });

      await order.save({ session });
      await session.commitTransaction();

      return order;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Bulk order action (FIX #14 backend support)
   * @param {Array} orderIds
   * @param {string} action - 'ACCEPT' | 'REJECT' | 'SHIP'
   * @param {Object} context
   * @returns {Promise<Object>} { successCount, failureCount, errors }
   */
  async bulkOrderAction(orderIds, action, context = {}) {
    const results = {
      successCount: 0,
      failureCount: 0,
      errors: [],
    };

    for (const orderId of orderIds) {
      try {
        if (action === 'ACCEPT') {
          await this.confirmOrder(orderId, context);
        } else if (action === 'REJECT') {
          await this.cancelOrder(orderId, context);
        } else if (action === 'SHIP') {
          await this.updateOrderStatus(
            orderId,
            'SHIPPED',
            { ...context, reason: 'Bulk shipped' }
          );
        }
        results.successCount++;
      } catch (err) {
        results.failureCount++;
        results.errors.push({
          orderId,
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * Get available stock (considering reservations)
   * @param {string} productId
   * @returns {Promise<number>}
   */
  async getAvailableStock(productId) {
    return inventoryService.getAvailableStock(productId);
  }

  /**
   * Refund order - transition to Refund Requested state
   * @param {string} orderId
   * @param {Object} data - { status }
   * @param {Object} context - { id, role }
   * @returns {Promise<Object>}
   */
  async refundOrder(orderId, data = {}, context = {}) {
    const order = await orderRepository.findById(orderId);
    if (!order) {
      throw new ApiError('Order not found', 404);
    }

    // Access control: only buyer or admin can request refund
    const buyerId = order.buyerId || order.user?._id || order.user?.id;
    if (context.role === 'CUSTOMER' && buyerId !== context.id) {
      throw new ApiError('Forbidden', 403);
    }

    // Use state machine for transition
    return orderStateService.transitionOrder(orderId, 'Refund Requested', context);
  }

  /**
   * Refund success - transition order and restock
   * @param {string} orderId
   * @param {Object} data - { status }
   * @returns {Promise<Object>}
   */
  async refundSuccess(orderId, data = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Transition to Refund Success
      await orderStateService.transitionOrder(orderId, 'Refund Success', {}, { session });

      // Restock items if not already restocked
      if (!order.restocked) {
        for (const item of (order.cart || [])) {
          await inventoryService.releaseReservation(
            item.productId,
            item.quantity,
            orderId,
            { session }
          );
        }
      }

      const updated = await orderRepository.findById(orderId);
      await session.commitTransaction();
      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Deduct inventory on payment confirmation
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async deductInventoryOnPayment(orderId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Deduct from actual inventory
      for (const item of (order.cart || [])) {
        await inventoryService.deductFromInventory(
          item.productId,
          item.quantity,
          { session }
        );
      }

      const updated = await orderRepository.findById(orderId);
      await session.commitTransaction();
      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reserve inventory for agreement/request orders
   * @param {string} productId
   * @param {number} quantity
   * @param {string} orderId
   * @param {string} type - 'AGREEMENT' | 'STANDARD'
   * @returns {Promise<Object>}
   */
  async reserveInventory(productId, quantity, orderId, type = 'STANDARD') {
    return inventoryService.reserveStock(productId, quantity, orderId, type);
  }

  /**
   * Create order from agreement
   * @param {Object} agreementData
   * @returns {Promise<Object>}
   */
  async createAgreementOrder(agreementData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Create order with agreement reference
      const order = await orderRepository.create(
        {
          ...agreementData,
          status: 'PROCESSING',
          isAgreement: true,
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return order;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = new OrdersService();
