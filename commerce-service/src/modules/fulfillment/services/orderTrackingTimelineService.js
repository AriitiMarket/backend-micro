/**
 * Order tracking timeline service
 * Buyer-friendly timeline with ETAs, actual times, exceptions
 */

class OrderTrackingTimelineService {
  /**
   * Get complete timeline with all milestones
   */
  static async getTimeline(orderId) {
    const order = await Order.findById(orderId)
      .populate('delivery')
      .populate('seller', 'name phone');

    if (!order) throw new Error('Order not found');

    const timeline = this._buildTimeline(order);

    return {
      orderId,
      status: order.status,
      timeline,
      currentStage: this._getCurrentStage(order),
      exceptions: await this._getExceptions(orderId),
      nextAction: this._getNextAction(order)
    };
  }

  /**
   * Get milestone with ETA vs actual
   */
  static async getMilestoneDetails(orderId, milestone) {
    const order = await Order.findById(orderId);
    
    const milestones = {
      'payment': {
        name: 'Payment Confirmed',
        estimatedDays: 0,
        actualTime: order.paymentConfirmedAt,
        description: 'Your payment has been received and confirmed'
      },
      'processing': {
        name: 'Processing',
        estimatedDays: 1,
        actualTime: order.processingStartedAt,
        description: 'Your order is being prepared for shipment'
      },
      'ready': {
        name: 'Ready for Pickup',
        estimatedDays: 2,
        actualTime: order.readyForPickupAt,
        description: 'Your order is ready for delivery partner pickup'
      },
      'pickup': {
        name: 'Picked Up',
        estimatedDays: 2,
        actualTime: order.pickedUpAt,
        description: 'Your order has been picked up',
        providerInfo: this._getProviderInfo(order)
      },
      'transit': {
        name: 'In Transit',
        estimatedDays: 4,
        actualTime: order.inTransitAt,
        description: 'Your order is on its way',
        trackingUrl: `/track/${order._id}`
      },
      'out_for_delivery': {
        name: 'Out for Delivery',
        estimatedDays: 4,
        actualTime: order.outForDeliveryAt,
        description: 'Your order is out for delivery today',
        estimatedDelivery: order.estimatedDeliveryDate
      },
      'delivered': {
        name: 'Delivered',
        estimatedDays: 4,
        actualTime: order.deliveredAt,
        description: 'Your order has been delivered'
      }
    };

    const m = milestones[milestone];
    return {
      ...m,
      delayedDays: this._calculateDelay(m),
      isDelayed: this._isDelayed(m)
    };
  }

  /**
   * Get driver/provider contact
   */
  static async getProviderContact(orderId) {
    const order = await Order.findById(orderId)
      .populate('delivery.providerId', 'name phone vehicle rating');

    if (!order?.delivery?.providerId) {
      return { available: false, message: 'Provider not assigned yet' };
    }

    return {
      available: true,
      provider: {
        name: order.delivery.providerId.name,
        phone: order.delivery.providerId.phone, // Should be masked for security
        vehicle: order.delivery.providerId.vehicle,
        rating: order.delivery.providerId.rating,
        estimatedArrival: order.estimatedDeliveryDate
      },
      contactUrl: `/contact/provider/${order.delivery.providerId._id}`
    };
  }

  /**
   * Get stage notifications
   */
  static async getStageNotifications(orderId) {
    return OrderNotification.find({ orderId })
      .sort({ createdAt: -1 })
      .lean();
  }

  // Helpers

  static _buildTimeline(order) {
    const stages = [
      { stage: 'payment', timestamp: order.paymentConfirmedAt, name: 'Payment Confirmed' },
      { stage: 'processing', timestamp: order.processingStartedAt, name: 'Processing' },
      { stage: 'ready', timestamp: order.readyForPickupAt, name: 'Ready for Pickup' },
      { stage: 'pickup', timestamp: order.pickedUpAt, name: 'Picked Up' },
      { stage: 'transit', timestamp: order.inTransitAt, name: 'In Transit' },
      { stage: 'out_for_delivery', timestamp: order.outForDeliveryAt, name: 'Out for Delivery' },
      { stage: 'delivered', timestamp: order.deliveredAt, name: 'Delivered' }
    ];

    return stages
      .filter(s => s.timestamp)
      .map(s => ({
        stage: s.stage,
        name: s.name,
        timestamp: s.timestamp,
        completed: true
      }));
  }

  static _getCurrentStage(order) {
    const stageMap = {
      'PAYMENT_PENDING': 'payment',
      'CONFIRMED': 'processing',
      'READY_FOR_PICKUP': 'ready',
      'PICKED_UP': 'pickup',
      'IN_TRANSIT': 'transit',
      'OUT_FOR_DELIVERY': 'out_for_delivery',
      'DELIVERED': 'delivered'
    };

    return stageMap[order.status] || 'payment';
  }

  static async _getExceptions(orderId) {
    return OrderException.find({ orderId }).lean();
  }

  static _getNextAction(order) {
    const actions = {
      'PAYMENT_PENDING': { action: 'Complete payment', url: '/payment' },
      'CONFIRMED': { action: 'Awaiting pickup', url: null },
      'DELIVERED': { action: 'Leave review', url: `/orders/${order._id}/review` }
    };

    return actions[order.status] || null;
  }

  static _getProviderInfo(order) {
    if (!order.delivery?.providerId) return null;
    return {
      name: order.delivery.providerId.name,
      phone: order.delivery.providerId.phone
    };
  }

  static _calculateDelay(milestone) {
    if (!milestone.actualTime) return 0;
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() + milestone.estimatedDays);
    const delayMs = milestone.actualTime - expectedDate;
    return Math.max(0, Math.ceil(delayMs / (1000 * 60 * 60 * 24)));
  }

  static _isDelayed(milestone) {
    return this._calculateDelay(milestone) > 0;
  }
}

module.exports = OrderTrackingTimelineService;
