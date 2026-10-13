/**
 * Admin mobile console service
 * Critical operations and monitoring on mobile
 */

class AdminMobileConsoleService {
  /**
   * Get admin dashboard (mobile)
   */
  static async getMobileDashboard(adminId) {
    const [platformMetrics, criticalAlerts, pendingApplications] = await Promise.all([
      this._getPlatformMetrics(),
      this._getCriticalAlerts(),
      Application.countDocuments({ status: 'PENDING' })
    ]);

    return {
      status: 'operational',
      criticalAlerts: criticalAlerts.length,
      pendingApprovals: pendingApplications,
      metrics: platformMetrics,
      actionItems: this._getActionItems(criticalAlerts, pendingApplications)
    };
  }

  /**
   * Quick critical operations
   */
  static async performCriticalOperation(adminId, operation, data) {
    const operations = {
      'suspend_seller': () => this._suspendSeller(data.sellerId, data.reason),
      'approve_seller': () => this._approveSeller(data.applicationId),
      'disable_product': () => this._disableProduct(data.productId, data.reason),
      'refund_order': () => this._refundOrder(data.orderId, data.amount),
      'resolve_dispute': () => this._resolveDispute(data.disputeId, data.decision)
    };

    if (!operations[operation]) throw new Error('Invalid operation');

    const result = await operations[operation]();

    // Log action
    await AdminLog.create({
      adminId,
      operation,
      targetId: data.sellerId || data.applicationId || data.productId || data.orderId,
      result: result.success ? 'SUCCESS' : 'FAILED',
      timestamp: new Date()
    });

    return result;
  }

  /**
   * Monitor critical metrics
   */
  static async getMetricsAlert(metric) {
    const alerts = {
      'payment_failures': { threshold: 0.05, unit: 'rate' }, // 5%
      'delivery_delays': { threshold: 0.1, unit: 'rate' },   // 10%
      'order_cancellations': { threshold: 0.15, unit: 'rate' }, // 15%
      'seller_disputes': { threshold: 10, unit: 'count' }     // 10+ open
    };

    const threshold = alerts[metric];
    if (!threshold) throw new Error('Unknown metric');

    const current = await this._getCurrentMetric(metric);
    const isAlert = threshold.unit === 'rate'
      ? current > threshold.threshold
      : current >= threshold.threshold;

    return {
      metric,
      current,
      threshold: threshold.threshold,
      isAlert,
      severity: isAlert ? 'CRITICAL' : 'OK'
    };
  }

  /**
   * Get pending applications for quick review
   */
  static async getPendingApplications(limit = 10) {
    return Application.find({ status: 'PENDING' })
      .select(['_id', 'sellerName', 'shopName', 'category', 'createdAt'])
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get support tickets needing attention
   */
  static async getSupportTickets(limit = 10) {
    return Ticket.find({ status: { $in: ['OPEN', 'IN_PROGRESS'] } })
      .select(['_id', 'subject', 'priority', 'createdAt', 'updatedAt'])
      .sort({ priority: -1, createdAt: 1 })
      .limit(limit)
      .lean();
  }

  static async _getPlatformMetrics() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [orders, revenue, users] = await Promise.all([
      Order.countDocuments({ createdAt: { $gte: today } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } }
      ]),
      User.countDocuments({ createdAt: { $gte: today } })
    ]);

    return {
      todayOrders: orders,
      todayRevenue: revenue[0]?.total || 0,
      newUsers: users
    };
  }

  static async _getCriticalAlerts() {
    const alerts = [];

    // Check payment failures
    const failureRate = await this._getPaymentFailureRate();
    if (failureRate > 0.05) {
      alerts.push({ type: 'PAYMENT_FAILURES', severity: 'CRITICAL', rate: failureRate });
    }

    // Check delivery delays
    const delayRate = await this._getDeliveryDelayRate();
    if (delayRate > 0.1) {
      alerts.push({ type: 'DELIVERY_DELAYS', severity: 'HIGH', rate: delayRate });
    }

    // Check open disputes
    const openDisputes = await Dispute.countDocuments({ status: 'OPEN' });
    if (openDisputes > 10) {
      alerts.push({ type: 'OPEN_DISPUTES', severity: 'MEDIUM', count: openDisputes });
    }

    return alerts;
  }

  static async _suspendSeller(sellerId, reason) {
    const seller = await Shop.findOne({ ownerId: sellerId });
    seller.status = 'SUSPENDED';
    seller.suspensionReason = reason;
    await seller.save();
    return { success: true, sellerId };
  }

  static async _approveSeller(applicationId) {
    const app = await Application.findById(applicationId);
    app.status = 'APPROVED';
    app.approvedAt = new Date();
    await app.save();
    return { success: true, applicationId };
  }

  static async _disableProduct(productId, reason) {
    const product = await Product.findById(productId);
    product.active = false;
    product.disabledReason = reason;
    await product.save();
    return { success: true, productId };
  }

  static async _refundOrder(orderId, amount) {
    const order = await Order.findById(orderId);
    order.refundAmount = amount;
    order.refundedAt = new Date();
    await order.save();
    return { success: true, orderId };
  }

  static async _resolveDispute(disputeId, decision) {
    const dispute = await Dispute.findById(disputeId);
    dispute.resolution = { decision, resolvedAt: new Date() };
    dispute.status = 'RESOLVED';
    await dispute.save();
    return { success: true, disputeId };
  }

  static async _getCurrentMetric(metric) {
    // Stub - implement metric calculation
    return 0;
  }

  static async _getPaymentFailureRate() {
    // Stub
    return 0;
  }

  static async _getDeliveryDelayRate() {
    // Stub
    return 0;
  }

  static _getActionItems(alerts, pendingApps) {
    const items = [];
    if (alerts.length > 0) items.push('Review critical alerts');
    if (pendingApps > 0) items.push(`${pendingApps} seller applications pending`);
    return items;
  }
}

module.exports = AdminMobileConsoleService;
