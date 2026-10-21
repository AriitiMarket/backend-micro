const mongoose = require('mongoose');
const orderPriorityRepository = require('../repositories/orderPriority.repository');
const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderPriorityService {
  async setPriority(orderId, priority, reason = '', context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        throw new ApiError('Order not found', 404);
      }

      const validPriorities = ['NORMAL', 'HIGH', 'VIP', 'URGENT'];
      if (!validPriorities.includes(priority)) {
        throw new ApiError('Invalid priority level', 400);
      }

      let priorityRecord = await orderPriorityRepository.findByOrderId(orderId);

      if (priorityRecord) {
        priorityRecord = await orderPriorityRepository.update(
          priorityRecord._id,
          {
            priority,
            reason,
            setBy: context.userId || 'SYSTEM',
            markedAt: new Date(),
          },
          { session }
        );
      } else {
        priorityRecord = await orderPriorityRepository.create(
          {
            orderId: String(orderId),
            priority,
            reason,
            setBy: context.userId || 'SYSTEM',
            markedAt: new Date(),
          },
          { session }
        );
      }

      await session.commitTransaction();
      return priorityRecord;
    } catch (err) {
      if (session?.inTransaction && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getPriority(orderId) {
    const priority = await orderPriorityRepository.findByOrderId(orderId);
    if (!priority) {
      return { orderId, priority: 'NORMAL' };
    }
    return priority;
  }

  async getVIPOrders() {
    const vipOrders = await orderPriorityRepository.findByPriority(['VIP', 'URGENT']);
    return vipOrders || [];
  }

  async resetPriority(orderId, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const priority = await orderPriorityRepository.findByOrderId(orderId);
      if (!priority) {
        throw new ApiError('Priority not found', 404);
      }

      const updated = await orderPriorityRepository.update(
        priority._id,
        {
          priority: 'NORMAL',
          resetAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return updated;
    } catch (err) {
      if (session?.inTransaction && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getPriorityStats() {
    const stats = await orderPriorityRepository.getStats();
    return stats || {
      total: 0,
      byPriority: { NORMAL: 0, HIGH: 0, VIP: 0, URGENT: 0 },
    };
  }
}

module.exports = new OrderPriorityService();
