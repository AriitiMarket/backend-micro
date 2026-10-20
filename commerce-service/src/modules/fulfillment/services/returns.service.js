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
const walletsService = require('./wallets.service');
const walletsRepository = require('../repositories/wallets.repository');
const allocationRepository = require('../repositories/sellerAllocation.repository');
const { ORDER_STATUSES, normalizeStatus } = require('../constants/orderStatuses');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function orderSellerIds(order) {
  return [...new Set([
    order && order.sellerId,
    ...((order && order.sellerShipments) || []).map((shipment) => shipment.sellerId || shipment.shopId),
  ].filter(Boolean).map(String))];
}

function assertReturnManager(order, context = {}) {
  if (String(context.role || '').toUpperCase() === 'ADMIN') return;
  if (!context.sellerId || !orderSellerIds(order).includes(String(context.sellerId))) {
    throw new ApiError('You do not manage this order', 403);
  }
}

class ReturnsService {
  async getSellerReturnsDashboard(shopId) {
    const rows = await returnsRepository.find(
      { shopId: String(shopId) },
      { limit: 100, sort: { createdAt: -1 } }
    );
    const countStatus = (...statuses) => rows.filter((row) => statuses.includes(String(row.status || '').toUpperCase())).length;
    return {
      returns: rows.map((row) => ({
        id: String(row._id),
        orderId: row.orderId,
        customerName: row.buyerName || row.buyerId,
        buyerId: row.buyerId,
        reason: row.reason || row.description || 'Return requested',
        items: Array.isArray(row.items) ? row.items : [],
        amount: Number(row.totalRefundRequested || row.returnAmount || 0),
        currency: 'ETB',
        status: String(row.status || 'PENDING').toUpperCase(),
        requestedAt: row.requestedAt || row.createdAt,
        rejectionReason: row.rejectionReason || '',
      })),
      dashboard: {
        pending: countStatus('PENDING', 'REQUESTED'),
        approved: countStatus('APPROVED'),
        inspecting: countStatus('PICKED_UP', 'RETURNED'),
        completed: countStatus('COMPLETED', 'REFUNDED'),
        totalValue: rows.reduce((sum, row) => sum + Number(row.totalRefundRequested || row.returnAmount || 0), 0),
      },
    };
  }

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

      const orderBuyerId = String(order.buyerId || order.user?.id || order.user?._id || '');
      if (String(returnData.role || '').toUpperCase() !== 'ADMIN'
        && String(returnData.buyerId || '') !== orderBuyerId) {
        throw new ApiError('You can only request a return for your own order', 403);
      }

      // Only delivered orders can be returned
      const currentStatus = normalizeStatus(order.status);
      if (currentStatus !== ORDER_STATUSES.DELIVERED) {
        await session.abortTransaction();
        throw new ApiError(
          `Cannot return order with status: ${order.status}`,
          422
        );
      }

      // Validate items in return request exist in order
      const returnItems = returnData.items || [];
      if (!returnItems.length) throw new ApiError('At least one return item is required', 400);
      const normalizedItems = [];
      for (const item of returnItems) {
        const cartItem = order.cart?.find(
          c => String(c.productId || c._id) === String(item.productId || item._id)
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
        normalizedItems.push({
          productId: String(cartItem.productId || cartItem._id),
          productName: cartItem.name || cartItem.productName || '',
          quantity: Number(item.quantity),
          unitPrice: Number(cartItem.price || cartItem.discountPrice || 0),
          subtotal: Number(cartItem.price || cartItem.discountPrice || 0) * Number(item.quantity),
        });
      }

      const totalRefundRequested = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
      const sellerId = order.sellerId || orderSellerIds(order)[0];
      if (!sellerId) throw new ApiError('Order seller could not be determined', 422);
      const validReasons = ['DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'DEFECTIVE', 'OTHER'];
      const reason = String(returnData.reason || 'OTHER').toUpperCase();
      const normalizedReason = validReasons.includes(reason) ? reason : 'OTHER';

      // Create return record
      const returnRecord = await returnsRepository.create(
        {
          orderId,
          buyerId: orderBuyerId,
          sellerId,
          shopId: order.shopId || order.sellerShipments?.[0]?.shopId || null,
          items: normalizedItems,
          reason: normalizedReason,
          description: String(returnData.comments || returnData.reason || '').slice(0, 1000),
          comments: returnData.comments,
          status: 'PENDING',
          requestedAt: new Date(),
          totalRefundRequested,
          returnAmount: totalRefundRequested,
          originalOrderAmount: Number(order.totalPrice || order.total || 0),
        },
        { session }
      );

      // Update order status to indicate return requested
      const previousStatus = order.status;
      order.status = ORDER_STATUSES.REFUND_REQUESTED;
      order.returnId = returnRecord._id;
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.REFUND_REQUESTED,
        previousStatus,
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

      const orderForAuthorization = await orderRepository.findById(returnRecord.orderId, { session });
      if (!orderForAuthorization) throw new ApiError('Order not found', 404);
      assertReturnManager(orderForAuthorization, context);

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
            returnId,
            { session }
          );
        }

        const previousStatus = order.status;
        order.status = ORDER_STATUSES.REFUND_APPROVED;
        order.refundApprovedAt = new Date();
        if (!order.timeline) order.timeline = [];
        order.timeline.push({
          status: ORDER_STATUSES.REFUND_APPROVED,
          previousStatus,
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
  async processRefund(returnId, refundData = {}, context = {}) {
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
      assertReturnManager(order, context);

      // FIX #6: Validate refund amount does not exceed order total
      const orderTotal = Number(order.totalPrice || order.total || 0);
      const refundAmount = Number(refundData.amount ?? returnRecord.totalRefundRequested);
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        throw new ApiError('Refund amount must be greater than zero', 400);
      }

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
      const previousStatus = order.status;
      order.status = ORDER_STATUSES.REFUND_SUCCESS;
      order.refundProcessedAt = new Date();
      order.refundAmount = refundAmount;
      if (!order.timeline) order.timeline = [];
      order.timeline.push({
        status: ORDER_STATUSES.REFUND_SUCCESS,
        previousStatus,
        timestamp: new Date(),
        reason: `Refund of ${refundAmount} processed`,
      });

      await order.save({ session });

      // NEW: Reverse seller wallet credits for this refund
      try {
        const allocations = await allocationRepository.findByOrder(order._id);
        if (allocations && allocations.length > 0) {
          // Calculate refund per seller proportionally
          const totalGross = allocations.reduce((sum, a) => sum + Number(a.grossSubtotal || 0), 0);

          for (const allocation of allocations) {
            try {
              // Calculate seller's share of refund
              const sellerShare = totalGross > 0
                ? (Number(allocation.grossSubtotal || 0) / totalGross) * refundAmount
                : 0;

              if (sellerShare <= 0) continue;

              // Get seller's wallet
              const wallet = await walletsRepository.getWalletBySellerId(allocation.sellerId);
              if (!wallet) continue;

              // Credit refund back to wallet (reduces both pending and available proportionally)
              await walletsService.creditRefund(
                wallet._id,
                sellerShare,
                order._id,
                {
                  actor: context.userId,
                  actorType: context.actorType || 'ADMIN',
                  reason: `Refund: ${refundData.notes || refundData.reason || 'Return processed'}`
                }
              );

              console.log(
                `Refund credited to seller ${allocation.sellerId}: -${sellerShare}`
              );
            } catch (walletErr) {
              console.error(
                `Failed to credit refund for seller ${allocation.sellerId}:`,
                walletErr
              );
              // Don't throw - refund is already processed in main logic
            }
          }
        }
      } catch (walletErr) {
        console.error('Failed to process wallet refunds:', walletErr);
      }

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

      const orderForAuthorization = await orderRepository.findById(returnRecord.orderId, { session });
      if (!orderForAuthorization) throw new ApiError('Order not found', 404);
      assertReturnManager(orderForAuthorization, context);

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
        const previousStatus = order.status;
        order.status = ORDER_STATUSES.REFUND_REJECTED;
        if (!order.timeline) order.timeline = [];
        order.timeline.push({
          status: ORDER_STATUSES.REFUND_REJECTED,
          previousStatus,
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
  async getReturn(returnId, context = {}) {
    const returnRecord = await returnsRepository.findById(returnId);
    if (!returnRecord) {
      throw new ApiError('Return not found', 404);
    }
    if (String(context.role || '').toUpperCase() !== 'ADMIN'
      && String(returnRecord.buyerId) !== String(context.userId || '')
      && !orderSellerIds(await orderRepository.findById(returnRecord.orderId)).includes(String(context.userId || ''))) {
      throw new ApiError('You do not have access to this return', 403);
    }
    return returnRecord;
  }
/**
   * List all returns with pagination and filters (admin)
   * @param {Object} options - { page, limit, status, buyerId, sellerId }
   * @returns {Promise<Object>} { returns, total, page, limit, totalPages }
   */
  async listReturns(options = {}) {
    const { page = 1, limit = 20, status, buyerId, sellerId } = options;
    const skip = (page - 1) * limit;

    const filter = {};
    if (status) filter.status = status;
    if (buyerId) filter.buyerId = buyerId;
    if (sellerId) filter.sellerId = sellerId;

    const [returns, total] = await Promise.all([
      returnsRepository.find(filter, { limit, skip, sort: { createdAt: -1 } }),
      returnsRepository.count(filter)
    ]);

    return {
      returns,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Get returns statistics (admin)
   * @param {Object} options - { startDate, endDate }
   * @returns {Promise<Object>}
   */
  async getStats(options = {}) {
    const { startDate, endDate } = options;

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    const [total, pending, approved, rejected, completed, totalRefunded] = await Promise.all([
      returnsRepository.count(dateFilter),
      returnsRepository.count({ ...dateFilter, status: 'PENDING' }),
      returnsRepository.count({ ...dateFilter, status: 'APPROVED' }),
      returnsRepository.count({ ...dateFilter, status: 'REJECTED' }),
      returnsRepository.count({ ...dateFilter, status: 'COMPLETED' }),
      returnsRepository.sumRefundAmount(dateFilter)
    ]);

    return {
      total,
      pending,
      approved,
      rejected,
      completed,
      totalRefunded: totalRefunded || 0
    };
  }
}

module.exports = new ReturnsService();
