const mongoose = require('mongoose');
const orderDisputeRepository = require('../repositories/orderDispute.repository');
const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderDisputeService {
  async createDispute(orderId, reason, evidence = {}, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const dispute = await orderDisputeRepository.create(
        {
          orderId: String(orderId),
          reason,
          initiator: context.userId,
          initiatorRole: context.role,
          evidence,
          status: 'OPEN',
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return dispute;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async updateDispute(disputeId, status, resolution = {}, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const dispute = await orderDisputeRepository.findById(disputeId);
      if (!dispute) {
        await session.abortTransaction();
        throw new ApiError('Dispute not found', 404);
      }

      const validStatuses = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED'];
      if (!validStatuses.includes(status)) {
        await session.abortTransaction();
        throw new ApiError('Invalid status', 400);
      }

      const updated = await orderDisputeRepository.update(
        disputeId,
        {
          status,
          resolution,
          resolvedBy: context.userId,
          resolvedAt: status === 'RESOLVED' ? new Date() : null,
          updatedAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getDispute(disputeId) {
    const dispute = await orderDisputeRepository.findById(disputeId);
    if (!dispute) {
      throw new ApiError('Dispute not found', 404);
    }
    return dispute;
  }

  async getSellerDisputes(sellerId, status) {
    const filter = {};
    if (status) filter.status = status;

    const disputes = await orderDisputeRepository.find({ filter });
    return disputes || [];
  }

  async getOpenDisputes() {
    return orderDisputeRepository.find({
      filter: { status: { $ne: 'RESOLVED' } },
    });
  }
}

module.exports = new OrderDisputeService();
