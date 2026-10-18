/**
 * FIX #3: Returns/Refunds Unification Service
 * FIX #6: Refund Validation (prevent overpayment refunds)
 * 
 * Single service managing returns, refunds, and inventory restoration
 * with proper state synchronization with orders
 */

const mongoose = require('mongoose');
const orderRepository = require('../repositories/orders.repository');
const returnsRepository = require('../repositories/returns.repository');
const inventoryService = require('./inventory.service');
const orderStateService = require('./orderState.service');
const { ORDER_STATUSES } = require('../constants/orderStatuses');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class ReturnsService {
  /**
   * Submit return request
   * @param {string} orderId
   * @param {Object} returnData - { reason, items, comments, buyerId }
   * @returns {Promise<Object>} return record
   */
  async requestReturn(orderId, returnData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // Only delivered orders can be returned
      const currentStatus = order.status.toUpperCase().replace(/-/g, '_');
      if (currentStatus !== ORDER_STATUSES.DELIVERED) {
        await session.abortTransaction();
        throw new ApiError(
          `Cannot return order with status: ${order.status}`,
          422
        );
      }

      // Validate items in return request exist in order
      const returnItems = returnData.items || [];
      for (const item of returnItems) {
        const cartItem = order.cart?.find(
          c => String(c.productId) === String(item.productId)
        );
        if (!cartItem) {
          await session.abortTransaction();
          throw new ApiError(
            `Product ${item.productId} not in original order`,
            422
          );
        }
        if (item.quantity > cartItem.quantity) {
          await session.abortTransaction();
          throw new ApiError(
            `Cannot return more than ordered: ${cartItem.quantity}`,
            422
          );
        }
      }

      // Create return record
      const returnRecord = await returnsRepository.create(
        {
          orderId,
          buyerId: returnData.buyerId || order.buyerId,
          items: returnItems,
          reason: returnData.reason,
          comments: returnData.comments,
          status: 'PENDING',
          requestedAt: new Date(),
          totalRefundRequested: returnItems.reduce((sum, item) => {
            const cartItem = order.cart.find(
              c => String(c.productId) === String(item.productId)
            );
            return sum + (cartItem?.price || 0) * item.quantity;
          }, 0),
        },
        { session }
      );

      // Update order status to indicate return requested
      order.status = ORDER_STATUSES.REFUND_REQUESTED;
      order.returnId = returnRecord._id;
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.REFUND_REQUESTED,
        previousStatus: order.status,
        timestamp: new Date(),
        reason: 'Return requested by buyer',
      });

      await order.save({ session });
      await session.commitTransaction();

      return returnRecord;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Approve return (seller approval)
   * @param {string} returnId
   * @param {Object} context - { sellerId }
   * @returns {Promise<Object>}
   */
  async approveReturn(returnId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const returnRecord = await returnsRepository.findById(returnId, { session });
      if (!returnRecord) {
        await session.abortTransaction();
        throw new ApiError('Return not found', 404);
      }

      if (returnRecord.status !== 'PENDING') {
        await session.abortTransaction();
        throw new ApiError(
          `Cannot approve return with status: ${returnRecord.status}`,
          422
        );
      }

      // Update return status
      returnRecord.status = 'APPROVED';
      returnRecord.approvedAt = new Date();
      returnRecord.approvedBy = context.sellerId;

      await returnRecord.save({ session });

      // Sync with order: restore stock + update status
      const order = await orderRepository.findById(returnRecord.orderId, { session });
      if (order) {
        // Restore stock for all returned items
        for (const item of returnRecord.items) {
          await inventoryService.restoreStock(
            item.productId,
            item.quantity,
            returnId
          );
        }

        order.status = ORDER_STATUSES.REFUND_APPROVED;
        order.refundApprovedAt = new Date();
        if (!order.timeline) order.timeline = [];
        order.timeline.push({
          status: ORDER_STATUSES.REFUND_APPROVED,
          previousStatus: order.status,
          timestamp: new Date(),
          reason: 'Return approved by seller',
        });

        await order.save({ session });
      }

      await session.commitTransaction();
      return returnRecord;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * FIX #6: Process refund with validation
   * Prevents refunding more than order total
   * @param {string} returnId
   * @param {Object} refundData - { amount, method, notes }
   * @returns {Promise<Object>}
   */
  async processRefund(returnId, refundData = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const returnRecord = await returnsRepository.findById(returnId, { session });
      if (!returnRecord) {
        await session.abortTransaction();
        throw new ApiError('Return not found', 404);
      }

      if (returnRecord.status !== 'APPROVED') {
        await session.abortTransaction();
        throw new ApiError(
          `Can only refund approved returns, current status: ${returnRecord.status}`,
          422
        );
      }

      const order = await orderRepository.findById(returnRecord.orderId, { session });
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      // FIX #6: Validate refund amount does not exceed order total
      const orderTotal = order.total || 0;
      const refundAmount = refundData.amount || returnRecord.totalRefundRequested;

      // Check sum of all previous refunds for this order
      const previousRefunds = await returnsRepository.find(
        {
          filter: {
            orderId: order._id,
            status: 'COMPLETED',
          },
        },
        { session }
      );

      const totalPreviousRefunds = previousRefunds.reduce(
        (sum, r) => sum + (r.refundAmount || r.totalRefundRequested || 0),
        0
      );

      const totalRefunds = totalPreviousRefunds + refundAmount;

      if (totalRefunds > orderTotal) {
        await session.abortTransaction();
        throw new ApiError(
          `Refund amount (${totalRefunds}) exceeds order total (${orderTotal})`,
          422
        );
      }

      // Update return record with refund details
      returnRecord.status = 'COMPLETED';
      returnRecord.refundAmount = refundAmount;
      returnRecord.refundMethod = refundData.method || 'ORIGINAL_PAYMENT_METHOD';
      returnRecord.refundNotes = refundData.notes;
      returnRecord.refundProcessedAt = new Date();

      await returnRecord.save({ session });

      // Update order status to completed return
      order.status = ORDER_STATUSES.REFUND_SUCCESS;
      order.refundProcessedAt = new Date();
      order.refundAmount = refundAmount;
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.REFUND_SUCCESS,
        previousStatus: order.status,
        timestamp: new Date(),
        reason: `Refund of ${refundAmount} processed`,
      });

      await order.save({ session });
      await session.commitTransaction();

      return {
        returnId: returnRecord._id,
        orderId: order._id,
        refundAmount,
        refundMethod: returnRecord.refundMethod,
        status: 'COMPLETED',
        processedAt: returnRecord.refundProcessedAt,
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reject return request
   * @param {string} returnId
   * @param {Object} context - { sellerId, reason }
   * @returns {Promise<Object>}
   */
  async rejectReturn(returnId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const returnRecord = await returnsRepository.findById(returnId, { session });
      if (!returnRecord) {
        await session.abortTransaction();
        throw new ApiError('Return not found', 404);
      }

      if (returnRecord.status !== 'PENDING') {
        await session.abortTransaction();
        throw new ApiError(
          `Cannot reject return with status: ${returnRecord.status}`,
          422
        );
      }

      returnRecord.status = 'REJECTED';
      returnRecord.rejectedAt = new Date();
      returnRecord.rejectedBy = context.sellerId;
      returnRecord.rejectionReason = context.reason;

      await returnRecord.save({ session });

      // Update order status
      const order = await orderRepository.findById(returnRecord.orderId, { session });
      if (order) {
        order.status = ORDER_STATUSES.REFUND_REJECTED;
        if (!order.timeline) order.timeline = [];
        order.timeline.push({
          status: ORDER_STATUSES.REFUND_REJECTED,
          previousStatus: order.status,
          timestamp: new Date(),
          reason: `Return rejected: ${context.reason}`,
        });

        await order.save({ session });
      }

      await session.commitTransaction();
      return returnRecord;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get return details
   * @param {string} returnId
   * @returns {Promise<Object>}
   */
  async getReturn(returnId) {
    const returnRecord = await returnsRepository.findById(returnId);
    if (!returnRecord) {
      throw new ApiError('Return not found', 404);
    }
    return returnRecord;
  }
}

module.exports = new ReturnsService();
