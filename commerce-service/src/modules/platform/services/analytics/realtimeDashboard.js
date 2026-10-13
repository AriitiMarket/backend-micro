/**
 * Real-time dashboard data aggregator
 * Pushes live updates via WebSocket
 */

const realtimeClient = require('../../../../shared/utils/realtime-client');

class RealtimeDashboard {
  /**
   * Start real-time dashboard updates (runs every minute)
   */
  static async startRealtimeUpdates(analyticsService, interval = 60000) {
    setInterval(async () => {
      try {
        const dashboardData = await this.collectDashboardData(analyticsService);
        await realtimeClient.emit('dashboard_update', dashboardData);
      } catch (error) {
        console.error('Dashboard update error:', error);
      }
    }, interval);
  }

  /**
   * Collect all real-time dashboard metrics
   */
  static async collectDashboardData(analyticsService) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStats = await analyticsService.getStats(today, now);

    return {
      timestamp: now,
      today: {
        orders: todayStats.totalOrders || 0,
        revenue: todayStats.totalRevenue || 0,
        sellers: todayStats.totalSellers || 0,
        avgOrderValue: todayStats.totalRevenue / Math.max(todayStats.totalOrders, 1)
      },
      activeMetrics: {
        ordersInProgress: todayStats.ordersInProgress || 0,
        paymentsProcessing: todayStats.paymentsProcessing || 0,
        deliveriesActive: todayStats.deliveriesActive || 0
      },
      performance: {
        orderCompletionRate: this._calculateCompletionRate(todayStats),
        paymentSuccessRate: todayStats.paymentSuccessRate || 0,
        avgDeliveryTime: todayStats.avgDeliveryTime || 0
      }
    };
  }

  /**
   * Stream specific metric (e.g., for dashboard widget)
   */
  static async streamMetric(metricName, analyticsService, interval = 30000) {
    setInterval(async () => {
      try {
        let value;
        if (metricName === 'activeOrders') {
          value = await analyticsService.getActiveOrdersCount();
        } else if (metricName === 'revenueToday') {
          value = await analyticsService.getTodayRevenue();
        } else if (metricName === 'onlineUsers') {
          value = await analyticsService.getOnlineUsersCount();
        }

        await realtimeClient.emit(`metric_update_${metricName}`, {
          metric: metricName,
          value,
          timestamp: new Date()
        });
      } catch (error) {
        console.error(`Metric stream error for ${metricName}:`, error);
      }
    }, interval);
  }

  /**
   * Get current health status
   */
  static async getHealthStatus(analyticsService) {
    try {
      const [orders, payments, deliveries] = await Promise.all([
        analyticsService.checkOrderHealth(),
        analyticsService.checkPaymentHealth(),
        analyticsService.checkDeliveryHealth()
      ]);

      const overallStatus = [orders.status, payments.status, deliveries.status]
        .includes('CRITICAL') ? 'CRITICAL'
        : [orders.status, payments.status, deliveries.status]
          .includes('WARNING') ? 'WARNING'
          : 'HEALTHY';

      return {
        status: overallStatus,
        components: { orders, payments, deliveries },
        timestamp: new Date()
      };
    } catch (error) {
      return { status: 'UNKNOWN', error: error.message };
    }
  }

  // Helper
  static _calculateCompletionRate(stats) {
    if (!stats.totalOrders) return 0;
    return Math.round(
      ((stats.deliveredOrders || 0) / stats.totalOrders) * 100
    );
  }
}

module.exports = RealtimeDashboard;
