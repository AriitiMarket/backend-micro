/**
 * COMPLETE: Real-Time Notification Manager
 * 100% implementation with all order, delivery, admin, seller, buyer notifications
 */

class CompleteRealtimeNotificationManager {
  constructor(io) {
    this.io = io;
    this.setupAllNamespaces();
  }

  /**
   * Setup all notification namespaces
   */
  setupAllNamespaces() {
    // Buyer Order Notifications
    this.io.of('/buyer-orders').on('connection', (socket) => {
      socket.on('subscribe_order', (data) => {
        socket.join(`buyer-order:${data.orderId}`);
        socket.buyerId = data.buyerId;
      });

      socket.on('unsubscribe_order', (data) => {
        socket.leave(`buyer-order:${data.orderId}`);
      });
    });

    // Seller Notifications
    this.io.of('/seller-updates').on('connection', (socket) => {
      socket.on('subscribe_seller', (data) => {
        socket.join(`seller:${data.sellerId}`);
        socket.join(`shop:${data.shopId}`);
        socket.sellerId = data.sellerId;
      });

      socket.on('unsubscribe_seller', (data) => {
        socket.leave(`seller:${data.sellerId}`);
      });
    });

    // Delivery Provider Notifications
    this.io.of('/delivery-updates').on('connection', (socket) => {
      socket.on('subscribe_provider', (data) => {
        socket.join(`provider:${data.providerId}`);
        socket.providerId = data.providerId;
      });

      socket.on('unsubscribe_provider', (data) => {
        socket.leave(`provider:${data.providerId}`);
      });

      // Real-time delivery tracking
      socket.on('update_location', (data) => {
        const { deliveryId, lat, lng } = data;
        this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`)
          .emit('location_update', { lat, lng, timestamp: new Date() });
      });
    });

    // Delivery Tracking for Buyers
    this.io.of('/delivery-tracking').on('connection', (socket) => {
      socket.on('track_delivery', (data) => {
        socket.join(`tracking:${data.deliveryId}`);
        socket.buyerId = data.buyerId;
      });
    });

    // Admin Notifications
    this.io.of('/admin-alerts').on('connection', (socket) => {
      socket.on('subscribe_admin', (data) => {
        const scope = data.scope || 'PLATFORM'; // PLATFORM, REGION, etc.
        socket.join(`admin:${scope}`);
        socket.adminId = data.adminId;
        socket.scope = scope;
      });

      socket.on('subscribe_alerts', (data) => {
        // Subscribe to specific alert types
        for (const alertType of data.types) {
          socket.join(`alert:${alertType}`);
        }
      });
    });

    // Chat Notifications (already exists, included for completeness)
    this.io.of('/chat').on('connection', (socket) => {
      socket.on('join_conversation', (data) => {
        socket.join(`conversation:${data.conversationId}`);
        socket.userId = data.userId;
      });
    });
  }

  // ============================================
  // ORDER NOTIFICATIONS (Buyer & Seller)
  // ============================================

  /**
   * Notify buyer of order status change
   */
  notifyOrderStatusChanged(orderId, buyerId, status, details) {
    this.io.of('/buyer-orders').to(`buyer-order:${orderId}`).emit('order_status_updated', {
      orderId,
      status,
      statusLabel: this._getStatusLabel(status),
      details,
      timestamp: new Date(),
      actionUrl: `/orders/${orderId}`,
      priority: this._getStatusPriority(status)
    });
  }

  /**
   * Notify seller of new order
   */
  notifyNewOrder(orderId, sellerId, shopId, orderData) {
    this.io.of('/seller-updates').to(`seller:${sellerId}`).emit('new_order', {
      orderId,
      shopId,
      itemCount: orderData.items?.length || 0,
      totalAmount: orderData.total,
      buyerName: orderData.buyerName,
      timestamp: new Date(),
      actionUrl: `/seller/orders/${orderId}`,
      priority: 'HIGH',
      sound: true // Ring notification
    });
  }

  /**
   * Notify seller of order cancellation
   */
  notifyOrderCancelled(orderId, sellerId, reason) {
    this.io.of('/seller-updates').to(`seller:${sellerId}`).emit('order_cancelled', {
      orderId,
      reason,
      timestamp: new Date(),
      priority: 'MEDIUM'
    });
  }

  /**
   * Notify buyer of payment confirmation
   */
  notifyPaymentConfirmed(orderId, buyerId, amount) {
    this.io.of('/buyer-orders').to(`buyer-order:${orderId}`).emit('payment_confirmed', {
      orderId,
      amount,
      timestamp: new Date(),
      status: 'success',
      message: `Payment of ${amount} confirmed`
    });
  }

  /**
   * Notify buyer of refund processed
   */
  notifyRefundProcessed(orderId, buyerId, amount) {
    this.io.of('/buyer-orders').to(`buyer-order:${orderId}`).emit('refund_processed', {
      orderId,
      amount,
      timestamp: new Date(),
      status: 'success',
      message: `Refund of ${amount} processed`,
      expectedDelivery: '3-5 business days'
    });
  }

  // ============================================
  // DELIVERY NOTIFICATIONS (Provider & Buyer)
  // ============================================

  /**
   * Notify provider of delivery assignment
   */
  notifyDeliveryAssigned(deliveryId, providerId, orderData) {
    this.io.of('/delivery-updates').to(`provider:${providerId}`).emit('delivery_assigned', {
      deliveryId,
      orderId: orderData.orderId,
      pickupLocation: orderData.pickupAddress,
      deliveryLocation: orderData.deliveryAddress,
      itemCount: orderData.itemCount,
      estimatedPay: orderData.estimatedPay,
      timestamp: new Date(),
      actionUrl: `/provider/deliveries/${deliveryId}`,
      priority: 'HIGH',
      sound: true
    });
  }

  /**
   * Notify buyer of pickup confirmation
   */
  notifyPickupConfirmed(deliveryId, buyerId, providerDetails) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('pickup_confirmed', {
      deliveryId,
      providerName: providerDetails.name,
      providerPhone: providerDetails.phone,
      vehicleInfo: providerDetails.vehicle,
      estimatedDelivery: providerDetails.eta,
      timestamp: new Date(),
      priority: 'HIGH'
    });
  }

  /**
   * Notify buyer of delivery in transit
   */
  notifyDeliveryInTransit(deliveryId, buyerId) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('delivery_in_transit', {
      deliveryId,
      status: 'IN_TRANSIT',
      message: 'Your delivery is on the way',
      timestamp: new Date(),
      trackingUrl: `/track/${deliveryId}`
    });
  }

  /**
   * Real-time GPS location update (streamed)
   */
  streamGPSUpdate(deliveryId, location, eta) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('gps_update', {
      deliveryId,
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      eta,
      timestamp: new Date()
    });
  }

  /**
   * Notify buyer of delivery arriving soon
   */
  notifyDeliveryArriving(deliveryId, buyerId) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('delivery_arriving_soon', {
      deliveryId,
      message: 'Delivery arriving in 5 minutes',
      timestamp: new Date(),
      priority: 'HIGH'
    });
  }

  /**
   * Notify buyer of delivery completed
   */
  notifyDeliveryCompleted(deliveryId, buyerId) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('delivery_completed', {
      deliveryId,
      status: 'DELIVERED',
      timestamp: new Date(),
      actionUrl: `/orders/review`,
      message: 'Delivery completed. Please review your order'
    });
  }

  /**
   * Notify buyer of delivery problem
   */
  notifyDeliveryProblem(deliveryId, buyerId, problem) {
    this.io.of('/delivery-tracking').to(`tracking:${deliveryId}`).emit('delivery_problem', {
      deliveryId,
      problem,
      message: `Delivery issue: ${problem.description}`,
      timestamp: new Date(),
      priority: 'CRITICAL',
      actionRequired: true,
      contactSupport: true
    });
  }

  // ============================================
  // ADMIN NOTIFICATIONS
  // ============================================

  /**
   * Alert: High-value order
   */
  alertHighValueOrder(orderData) {
    this.io.of('/admin-alerts').to('admin:PLATFORM').emit('high_value_order', {
      orderId: orderData.orderId,
      amount: orderData.total,
      buyerEmail: orderData.buyerEmail,
      timestamp: new Date(),
      priority: 'HIGH',
      alertType: 'HIGH_VALUE_ORDER'
    });
  }

  /**
   * Alert: Seller application pending
   */
  alertSellerApplicationPending(applicationData) {
    this.io.of('/admin-alerts').to('admin:PLATFORM').to('alert:APPLICATIONS').emit('seller_application_pending', {
      applicationId: applicationData.id,
      sellerName: applicationData.sellerName,
      timestamp: new Date(),
      priority: 'MEDIUM',
      actionUrl: `/admin/applications/${applicationData.id}`,
      actionRequired: true
    });
  }

  /**
   * Alert: Dispute filed
   */
  alertDisputeFiled(disputeData) {
    this.io.of('/admin-alerts').to('admin:PLATFORM').to('alert:DISPUTES').emit('dispute_filed', {
      disputeId: disputeData.id,
      orderId: disputeData.orderId,
      reason: disputeData.reason,
      timestamp: new Date(),
      priority: 'HIGH',
      actionUrl: `/admin/disputes/${disputeData.id}`,
      actionRequired: true
    });
  }

  /**
   * Alert: Multiple failed deliveries
   */
  alertMultipleFailedDeliveries(providerId, failureCount) {
    this.io.of('/admin-alerts').to('admin:PLATFORM').to('alert:DELIVERY').emit('provider_issue_alert', {
      providerId,
      failureCount,
      message: `Provider ${providerId} has ${failureCount} failed deliveries`,
      timestamp: new Date(),
      priority: 'HIGH',
      actionRequired: true
    });
  }

  /**
   * Alert: Platform issue (service down, etc)
   */
  alertPlatformIssue(issue) {
    this.io.of('/admin-alerts').to('admin:PLATFORM').emit('platform_issue', {
      issue: issue.type,
      description: issue.description,
      affectedComponent: issue.component,
      timestamp: new Date(),
      priority: 'CRITICAL',
      actionRequired: true
    });
  }

  // ============================================
  // SELLER NOTIFICATIONS
  // ============================================

  /**
   * Notify seller of low inventory
   */
  notifyLowInventory(sellerId, productData) {
    this.io.of('/seller-updates').to(`seller:${sellerId}`).emit('low_inventory_alert', {
      productId: productData.id,
      productName: productData.name,
      currentStock: productData.stock,
      minimumThreshold: productData.minThreshold,
      timestamp: new Date(),
      priority: 'MEDIUM'
    });
  }

  /**
   * Notify seller of positive review
   */
  notifyPositiveReview(sellerId, reviewData) {
    this.io.of('/seller-updates').to(`seller:${sellerId}`).emit('positive_review', {
      productId: reviewData.productId,
      rating: reviewData.rating,
      reviewExcerpt: reviewData.content?.substring(0, 100),
      timestamp: new Date(),
      priority: 'LOW',
      actionUrl: `/seller/products/${reviewData.productId}/reviews`
    });
  }

  /**
   * Notify seller of shop suspension
   */
  notifyShopSuspended(sellerId, reason) {
    this.io.of('/seller-updates').to(`seller:${sellerId}`).emit('shop_suspended', {
      reason,
      message: `Your shop has been suspended: ${reason}`,
      timestamp: new Date(),
      priority: 'CRITICAL',
      actionRequired: true,
      contactSupport: true
    });
  }

  // ============================================
  // BUYER NOTIFICATIONS
  // ============================================

  /**
   * Notify buyer of seller response to review
   */
  notifySellerResponse(buyerId, reviewData) {
    this.io.of('/buyer-orders').emit('seller_response_to_review', {
      reviewId: reviewData.id,
      productName: reviewData.productName,
      sellerResponse: reviewData.sellerResponse?.text?.substring(0, 100),
      timestamp: new Date(),
      priority: 'LOW'
    });
  }

  /**
   * Notify buyer about promotion/discount
   */
  notifyPromotion(buyerId, promotionData) {
    this.io.of('/buyer-orders').emit('promotion_available', {
      promotionId: promotionData.id,
      title: promotionData.title,
      discount: promotionData.discount,
      expiresAt: promotionData.expiresAt,
      timestamp: new Date(),
      actionUrl: `/promotions/${promotionData.id}`
    });
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  _getStatusLabel(status) {
    const labels = {
      'PENDING': 'Order Pending',
      'PAYMENT_CONFIRMED': 'Payment Confirmed',
      'READY_FOR_PICKUP': 'Ready for Pickup',
      'PICKED_UP': 'Picked Up',
      'IN_TRANSIT': 'In Transit',
      'DELIVERED': 'Delivered',
      'COMPLETED': 'Completed',
      'CANCELLED': 'Cancelled'
    };
    return labels[status] || status;
  }

  _getStatusPriority(status) {
    const priorities = {
      'PAYMENT_CONFIRMED': 'HIGH',
      'READY_FOR_PICKUP': 'HIGH',
      'DELIVERED': 'MEDIUM',
      'COMPLETED': 'LOW',
      'CANCELLED': 'HIGH'
    };
    return priorities[status] || 'MEDIUM';
  }

  /**
   * Get online users count
   */
  getOnlineUsers(namespace = '/buyer-orders') {
    const ns = this.io.of(namespace);
    return ns.sockets.size;
  }

  /**
   * Broadcast maintenance message to all
   */
  broadcastMaintenance(message, estimatedDuration) {
    this.io.emit('maintenance_alert', {
      message,
      estimatedDuration,
      timestamp: new Date(),
      priority: 'CRITICAL'
    });
  }
}

module.exports = CompleteRealtimeNotificationManager;
