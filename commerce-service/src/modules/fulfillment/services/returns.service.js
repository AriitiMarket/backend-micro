/**
 * FIX #9: Returns Service
 * Manages return request workflow
 */
const Returns = require('../models/Returns');
const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class ReturnsService {
  /**
   * Create a return request
   */
  async createReturn(orderId, buyerId, data) {
    const order = await orderRepository.findById(orderId);
    if (!order) throw new ApiError('Order not found', 404);
    if (String(order.buyerId) !== String(buyerId)) {
      throw new ApiError('Forbidden: this is not your order', 403);
    }

    // Check if order can be returned (must be delivered)
    if (order.status !== 'DELIVERED') {
      throw new ApiError('Only delivered orders can be returned', 400);
    }

    // Check if return already exists
    const existing = await Returns.findOne({ orderId, status: { $in: ['REQUESTED', 'APPROVED', 'PICKED_UP', 'RETURNED'] } });
    if (existing) {
      throw new ApiError('An active return already exists for this order', 400);
    }

    // Get seller info from first shipment
    const shipment = (order.sellerShipments || [])[0];
    if (!shipment) throw new ApiError('Order has no seller information', 400);

    // Create return
    const returnRequest = new Returns({
      orderId,
      buyerId,
      sellerId: shipment.sellerId,
      shopId: shipment.shopId,
      reason: data.reason,
      description: data.description,
      images: data.images || [],
      items: data.items || order.cart,
      returnAmount: data.returnAmount || order.totalPrice,
      originalOrderAmount: order.totalPrice
    });

    await returnRequest.save();
    return returnRequest;
  }

  /**
   * Get return request
   */
  async getReturn(returnId, userId, userRole) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    // Check authorization
    const isOwner = String(returnRequest.buyerId) === String(userId);
    const isSeller = String(returnRequest.sellerId) === String(userId);
    const isAdmin = userRole === 'ADMIN';

    if (!isOwner && !isSeller && !isAdmin) {
      throw new ApiError('Forbidden', 403);
    }

    return returnRequest;
  }

  /**
   * List returns for buyer
   */
  async getBuyerReturns(buyerId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;
    const returns = await Returns.find({ buyerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Returns.countDocuments({ buyerId });

    return { returns, total, page, limit };
  }

  /**
   * List returns for seller
   */
  async getSellerReturns(sellerId, { page = 1, limit = 20, status } = {}) {
    const query = { sellerId };
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const returns = await Returns.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Returns.countDocuments(query);

    return { returns, total, page, limit };
  }

  /**
   * List returns for admin
   */
  async listReturns({ page = 1, limit = 20, status, buyerId, sellerId } = {}) {
    const query = {};
    if (status) query.status = status;
    if (buyerId) query.buyerId = buyerId;
    if (sellerId) query.sellerId = sellerId;

    const skip = (page - 1) * limit;
    const returns = await Returns.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Returns.countDocuments(query);

    return { returns, total, page, limit };
  }

  /**
   * Admin approve return
   */
  async approveReturn(returnId, adminId, notes = '') {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    if (returnRequest.status !== 'REQUESTED') {
      throw new ApiError('Only requested returns can be approved', 400);
    }

    returnRequest.status = 'APPROVED';
    returnRequest.approvedAt = new Date();
    returnRequest.adminNotes = notes;
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Admin reject return
   */
  async rejectReturn(returnId, adminId, rejectionReason) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    if (returnRequest.status !== 'REQUESTED') {
      throw new ApiError('Only requested returns can be rejected', 400);
    }

    returnRequest.status = 'REJECTED';
    returnRequest.rejectedAt = new Date();
    returnRequest.rejectionReason = rejectionReason;
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Seller/Admin mark as picked up
   */
  async markPickedUp(returnId, userId) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    if (returnRequest.status !== 'APPROVED') {
      throw new ApiError('Only approved returns can be picked up', 400);
    }

    returnRequest.status = 'PICKED_UP';
    returnRequest.pickedUpAt = new Date();
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Seller/Admin confirm goods received
   */
  async confirmReturned(returnId, userId) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    if (returnRequest.status !== 'PICKED_UP') {
      throw new ApiError('Only picked up returns can be confirmed as returned', 400);
    }

    returnRequest.status = 'RETURNED';
    returnRequest.returnedAt = new Date();
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Process refund
   */
  async processRefund(returnId, paymentId) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    if (returnRequest.status !== 'RETURNED') {
      throw new ApiError('Return must be confirmed received before refunding', 400);
    }

    returnRequest.status = 'REFUNDED';
    returnRequest.refundStatus = 'PROCESSED';
    returnRequest.refundPaymentId = paymentId;
    returnRequest.refundProcessedAt = new Date();
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Mark return as cancelled
   */
  async cancelReturn(returnId, userId, userRole) {
    const returnRequest = await Returns.findById(returnId);
    if (!returnRequest) throw new ApiError('Return not found', 404);

    // Buyer can only cancel REQUESTED returns
    if (userRole === 'BUYER' && returnRequest.status !== 'REQUESTED') {
      throw new ApiError('Only requested returns can be cancelled by buyer', 400);
    }

    // Seller/Admin can cancel before refund
    if (['REFUNDED'].includes(returnRequest.status)) {
      throw new ApiError('Cannot cancel a refunded return', 400);
    }

    returnRequest.status = 'CANCELLED';
    await returnRequest.save();

    return returnRequest;
  }

  /**
   * Get return statistics
   */
  async getStats({ startDate, endDate } = {}) {
    const query = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = startDate;
      if (endDate) query.createdAt.$lte = endDate;
    }

    const stats = await Returns.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$returnAmount' }
        }
      }
    ]);

    const byReason = await Returns.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$reason',
          count: { $sum: 1 }
        }
      }
    ]);

    return {
      byStatus: stats,
      byReason,
      total: stats.reduce((sum, s) => sum + s.count, 0),
      totalAmount: stats.reduce((sum, s) => sum + (s.totalAmount || 0), 0)
    };
  }
}

module.exports = new ReturnsService();
