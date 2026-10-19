const mongoose = require('mongoose');
const orderSLARepository = require('../repositories/orderSLA.repository');
const orderRepository = require('../repositories/orders.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OrderSLAService {
  async setSLA(orderId, stateName, durationHours, context = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await orderRepository.findById(orderId);
      if (!order) {
        await session.abortTransaction();
        throw new ApiError('Order not found', 404);
      }

      const deadline = new Date();
      deadline.setHours(deadline.getHours() + durationHours);

      const sla = await orderSLARepository.create(
        {
          orderId: String(orderId),
          stateName,
          durationHours,
          deadline,
          setBy: context.userId,
          createdAt: new Date(),
        },
        { session }
      );

      await session.commitTransaction();
      return sla;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async checkSLACompliance(orderId) {
    const sla = await orderSLARepository.findByOrderId(orderId);
    if (!sla) return { compliant: true, reason: 'No SLA set' };

    const now = new Date();
    const compliant = now <= sla.deadline;
    const timeRemaining = sla.deadline - now;
    const hoursRemaining = Math.round(timeRemaining / 1000 / 60 / 60);

    return {
      compliant,
      deadline: sla.deadline,
      hoursRemaining,
      breached: !compliant,
    };
  }

  async getSLAStatus(orderId) {
    const sla = await orderSLARepository.findByOrderId(orderId);
    if (!sla) return null;

    const now = new Date();
    const timeRemaining = sla.deadline - now;
    const hoursRemaining = Math.round(timeRemaining / 1000 / 60 / 60);

    return {
      stateName: sla.stateName,
      deadline: sla.deadline,
      hoursRemaining,
      percentComplete: Math.min(
        100,
        Math.max(0, 100 - (hoursRemaining / sla.durationHours) * 100)
      ),
      breached: hoursRemaining < 0,
    };
  }

  async getSLABreaches(sellerId, period = 'week') {
    const days = period === 'week' ? 7 : period === 'month' ? 30 : 1;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const breaches = await orderSLARepository.find({
      filter: {
        createdAt: { $gte: startDate },
        deadline: { $lt: new Date() },
      },
    });

    return breaches || [];
  }
}

module.exports = new OrderSLAService();
