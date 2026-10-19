/**
 * ORDER HOLD SERVICE
 * Temporarily pause orders
 * Reuses patterns from orderState.service.js and allocation.service.js
 */

const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const orderHoldRepository = require('../repositories/orderHold.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderHoldService {
  /**
   * Put order on hold with reason
   * @param {string} orderId
   * @param {string} reason - Why is order on hold
   * @param {string} holdByRole - 'ADMIN', 'SELLER', 'SYSTEM'
   * @param {string} userId - Who put it on hold
   * @returns {Promise<Object>}
   */
  async holdOrder(orderId, reason, holdByRole, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Verify order exists
      const order = await orderRepository.findById(orderId);
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Check if already on hold
      const existingHold = await orderHoldRepository.findByOrderId(orderId);
      if (existingHold && !existingHold.releasedAt) {
        await session.abortTransaction();
        throw new ApiError('Order is already on hold', 409);
      }

      // Create hold record
      const hold = await orderHoldRepository.create(
        {
          orderId: String(orderId),
          reason,
          holdByRole,
          heldByUserId: String(userId),
          heldAt: new Date(),
          releasedAt: null,
        },
        { session }
      );

      await session.commitTransaction();
      return hold;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Release hold on order
   * @param {string} orderId
   * @param {string} releaseReason - Why released
   * @param {string} userId - Who released it
   * @returns {Promise<Object>}
   */
  async releaseHold(orderId, releaseReason, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Find active hold
      const hold = await orderHoldRepository.findByOrderId(orderId);
      if (!hold || hold.releasedAt) {
        await session.abortTransaction();
        throw new ApiError('Order is not on hold', 409);
      }

      // Release hold
      const released = await orderHoldRepository.update(
        hold._id,
        {
          releasedAt: new Date(),
          releaseReason,
          releasedByUserId: String(userId),
        },
        { session }
      );

      await session.commitTransaction();
      return released;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get current hold status for order
   * @param {string} orderId
   * @returns {Promise<Object|null>}
   */
  async getHoldStatus(orderId) {
    const hold = await orderHoldRepository.findByOrderId(orderId);
    
    if (!hold) return null;
    if (hold.releasedAt) return null; // Not on hold
    
    return {
      reason: hold.reason,
      heldAt: hold.heldAt,
      heldByRole: hold.holdByRole,
      durationMinutes: Math.round(
        (new Date() - new Date(hold.heldAt)) / 1000 / 60
      ),
    };
  }

  /**
   * Get all held orders for seller
   * @param {string} sellerId
   * @returns {Promise<Array>}
   */
  async getHeldOrdersByS eller(sellerId) {
    // Get held orders for this seller
    const holds = await orderHoldRepository.findByRole('SELLER', {
      filter: { releasedAt: null },
    });

    if (!holds || holds.length === 0) return [];

    // Get actual orders to verify they belong to seller
    const orderIds = holds.map(h => h.orderId);
    const orders = await orderRepository.findBySellerOrShop(sellerId);
    const sellerOrderIds = orders.map(o => String(o._id));

    return holds
      .filter(h => sellerOrderIds.includes(String(h.orderId)))
      .map(h => ({
        orderId: h.orderId,
        reason: h.reason,
        heldAt: h.heldAt,
        durationMinutes: Math.round(
          (new Date() - new Date(h.heldAt)) / 1000 / 60
        ),
      }));
  }

  /**
   * Get hold history for order
   * @param {string} orderId
   * @returns {Promise<Array>}
   */
  async getHoldHistory(orderId) {
    return orderHoldRepository.findAll({ orderId: String(orderId) });
  }
}

module.exports = new OrderHoldService();
