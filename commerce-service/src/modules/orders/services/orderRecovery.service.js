'use strict';

/**
 * Order Recovery Service
 * Recovers stuck delivery handoffs for confirmed orders.
 */

const orderRepository = require('../repositories/orders.repository');
const orderDeliveryService = require('./orderDelivery.service');
const orderStateService = require('./orderState.service');

class OrderRecoveryService {
  /**
   * Recover delivery handoffs for orders that are confirmed but haven't been handed off to Delivery Service.
   */
  async recoverDeliveryHandoffs(limit = 100) {
    const orders = await orderRepository.find({
      filter: {
        status: 'Confirmed',
        requestId: null,
        fulfilmentType: { $ne: 'pickup' },
      },
      limit,
      sort: { createdAt: 1 },
    });

    if (!orders.length) {
      return { processed: 0, succeeded: 0, failed: 0, abandoned: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    let abandoned = 0;

    for (const order of orders) {
      const orderId = String(order._id);

      const existingLink = await orderDeliveryService.getByOrderId(orderId);
      if (existingLink?.deliveryRequestId) {
        continue;
      }

      try {
        const result = await orderStateService.deliverHandoff(order);

        if (result.ok) {
          succeeded++;
        } else if (result.reason === 'rejected') {
          abandoned++;
        } else {
          failed++;
        }
      } catch (err) {
        await orderDeliveryService.waitForOrderApproval(orderId);
        console.error(`[recoverDeliveryHandoffs] Order ${orderId} handoff failed:`, err.message);
        failed++;
      }
    }

    return { processed: orders.length, succeeded, failed, abandoned };
  }
}

module.exports = new OrderRecoveryService();
