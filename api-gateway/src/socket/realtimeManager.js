/**
 * ENHANCED: Real-time WebSocket Manager
 * Complete implementation for order, delivery, and admin notifications
 */

class RealtimeManager {
  constructor(io) {
    this.io = io;
    this.setupNamespaces();
  }

  /**
   * Setup all WebSocket namespaces
   */
  setupNamespaces() {
    // Order tracking namespace
    this.io.of('/orders').on('connection', (socket) => {
      socket.on('subscribe_order', (data) => {
        const { orderId, userId } = data;
        socket.join(`order:${orderId}`);
        socket.userId = userId;
      });

      socket.on('unsubscribe_order', (data) => {
        const { orderId } = data;
        socket.leave(`order:${orderId}`);
      });
    });

    // Delivery tracking namespace
    this.io.of('/delivery').on('connection', (socket) => {
      socket.on('subscribe_delivery', (data) => {
        const { deliveryId, userId } = data;
        socket.join(`delivery:${deliveryId}`);
        socket.userId = userId;
      });

      socket.on('unsubscribe_delivery', (data) => {
        const { deliveryId } = data;
        socket.leave(`delivery:${deliveryId}`);
      });

      socket.on('request_tracking', (data) => {
        const { deliveryId } = data;
        socket.emit('tracking_requested', { deliveryId });
      });
    });

    // Admin notifications namespace
    this.io.of('/admin').on('connection', (socket) => {
      socket.on('subscribe_admin', (data) => {
        const { adminId, role } = data;
        socket.join(`admin:${adminId}`);
        socket.join(`admin:${role}`); // e.g., admin:REGION_ADMIN
        socket.adminId = adminId;
        socket.role = role;
      });
    });

    // Seller notifications namespace
    this.io.of('/sellers').on('connection', (socket) => {
      socket.on('subscribe_seller', (data) => {
        const { sellerId, shopId } = data;
        socket.join(`seller:${sellerId}`);
        socket.join(`shop:${shopId}`);
        socket.sellerId = sellerId;
      });
    });

    // Provider notifications namespace
    this.io.of('/providers').on('connection', (socket) => {
      socket.on('subscribe_provider', (data) => {
        const { providerId } = data;
        socket.join(`provider:${providerId}`);
        socket.providerId = providerId;
      });
    });
  }

  /**
   * Emit order status change to buyer + seller
   */
  emitOrderStatusChanged(orderId, buyerId, sellerId, status, details) {
    this.io.of('/orders').to(`order:${orderId}`).emit('order_status_changed', {
      orderId,
      status,
      timestamp: new Date(),
      details
    });

    // Notify seller
    this.io.of('/sellers').to(`seller:${sellerId}`).emit('seller_order_update', {
      orderId,
      status,
      timestamp: new Date(),
      action: `Order ${status}`
    });
  }

  /**
   * Emit delivery status to buyer + provider
   */
  emitDeliveryStatusChanged(deliveryId, orderId, providerId, buyerId, status, eta) {
    this.io.of('/delivery').to(`delivery:${deliveryId}`).emit('delivery_status_changed', {
      deliveryId,
      orderId,
      status,
      eta,
      timestamp: new Date()
    });

    // Notify provider
    this.io.of('/providers').to(`provider:${providerId}`).emit('delivery_assignment', {
      deliveryId,
      orderId,
      status,
      action: status === 'ASSIGNED' ? 'New assignment' : `Status: ${status}`
    });
  }

  /**
   * Emit admin alert (new application, dispute, high-value order, etc)
   */
  emitAdminAlert(alert type, data, adminRole = 'PLATFORM_ADMIN') {
    this.io.of('/admin').to(`admin:${adminRole}`).emit('admin_alert', {
      type,
      data,
      severity: data.severity || 'INFO',
      timestamp: new Date(),
      actionRequired: data.actionRequired || false
    });
  }

  /**
   * Emit payment confirmation to buyer + seller
   */
  emitPaymentConfirmed(orderId, buyerId, sellerId, amount) {
    this.io.of('/orders').to(`order:${orderId}`).emit('payment_confirmed', {
      orderId,
      amount,
      timestamp: new Date()
    });

    this.io.of('/sellers').to(`seller:${sellerId}`).emit('seller_payment_received', {
      orderId,
      amount,
      timestamp: new Date()
    });
  }

  /**
   * Emit GPS location update to buyer
   */
  emitGPSUpdate(deliveryId, buyerId, location, eta) {
    this.io.of('/delivery').to(`delivery:${deliveryId}`).emit('gps_update', {
      deliveryId,
      location: {
        lat: location.lat,
        lng: location.lng,
        timestamp: new Date()
      },
      eta,
      accuracy: location.accuracy
    });
  }

  /**
   * Emit seller application update
   */
  emitApplicationUpdate(sellerId, applicationId, status, message) {
    this.io.of('/sellers').to(`seller:${sellerId}`).emit('application_updated', {
      applicationId,
      status,
      message,
      timestamp: new Date(),
      actionUrl: `/seller/applications/${applicationId}`
    });
  }

  /**
   * Emit dispute notification
   */
  emitDisputeNotification(disputeId, buyerId, sellerId, adminId, action) {
    // Notify buyer
    this.io.of('/orders').to(`order:${disputeId}`).emit('dispute_notification', {
      disputeId,
      action,
      timestamp: new Date()
    });

    // Notify seller
    this.io.of('/sellers').to(`seller:${sellerId}`).emit('dispute_notification', {
      disputeId,
      action,
      timestamp: new Date()
    });

    // Notify admin
    this.io.of('/admin').to(`admin:PLATFORM_ADMIN`).emit('dispute_alert', {
      disputeId,
      buyerId,
      sellerId,
      action,
      timestamp: new Date()
    });
  }

  /**
   * Broadcast system announcement
   */
  broadcastAnnouncement(title, message, severity = 'INFO') {
    this.io.emit('system_announcement', {
      title,
      message,
      severity,
      timestamp: new Date()
    });
  }

  /**
   * Get online user count
   */
  getOnlineCount(namespace = '/orders') {
    const ns = this.io.of(namespace);
    return ns.sockets.size;
  }
}

module.exports = RealtimeManager;
