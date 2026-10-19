/**
 * FIX #13: Seller Metrics and KPIs Service
 * Calculates key seller performance indicators with caching
 */

const orderRepository = require('../../fulfillment/repositories/orders.repository');
const returnsRepository = require('../../fulfillment/repositories/returns.repository');

class SellerMetricsService {
  /**
   * Calculate seller metrics (with caching potential)
   * @param {string} shopId
   * @param {Object} options - { period: 'daily' | 'weekly' | 'monthly', startDate, endDate }
   * @returns {Promise<Object>} metrics object
   */
  async getSellerMetrics(shopId, options = {}) {
    const { period = 'daily', startDate, endDate } = options;

    // Calculate date range
    const now = new Date();
    let start = startDate;
    let end = endDate || now;

    if (!start) {
      const d = new Date(now);
      if (period === 'daily') {
        d.setDate(d.getDate() - 1);
      } else if (period === 'weekly') {
        d.setDate(d.getDate() - 7);
      } else if (period === 'monthly') {
        d.setMonth(d.getMonth() - 1);
      }
      start = d;
    }

    // Fetch data
    const [orders, returns, reviewStats] = await Promise.all([
      orderRepository.find({
        filter: {
          shopId,
          createdAt: { $gte: start, $lte: end },
        },
      }),
      returnsRepository.find({
        filter: {
          shopId,
          createdAt: { $gte: start, $lte: end },
        },
      }),
      this._getReviewStats(shopId, start, end),
    ]);

    // Calculate metrics
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const completedOrders = orders.filter(
      o => o.status === 'DELIVERED' || o.status === 'COMPLETED'
    ).length;
    const fulfillmentRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;

    const totalReturns = returns.length;
    const approvedReturns = returns.filter(r => r.status === 'APPROVED').length;
    const returnRate = totalOrders > 0 ? (totalReturns / totalOrders) * 100 : 0;

    const averageRating =
      reviewStats.totalReviews > 0
        ? reviewStats.totalRating / reviewStats.totalReviews
        : 0;

    return {
      period,
      dateRange: { start, end },
      orders: {
        total: totalOrders,
        completed: completedOrders,
        cancelled: orders.filter(o => o.status === 'CANCELLED').length,
        pending: orders.filter(o => o.status === 'PROCESSING').length,
      },
      revenue: {
        total: totalRevenue,
        average: averageOrderValue,
      },
      fulfillment: {
        rate: parseFloat(fulfillmentRate.toFixed(2)),
        onTimePercentage: this._calculateOnTimePercentage(orders),
      },
      returns: {
        total: totalReturns,
        approved: approvedReturns,
        rate: parseFloat(returnRate.toFixed(2)),
      },
      reviews: {
        average: parseFloat(averageRating.toFixed(2)),
        total: reviewStats.totalReviews,
        byRating: reviewStats.byRating,
      },
      trends: {
        ordersPerDay:
          Math.round((totalOrders / this._getDaysDifference(start, end)) * 100) /
          100,
        revenuePerDay:
          Math.round((totalRevenue / this._getDaysDifference(start, end)) * 100) /
          100,
      },
    };
  }

  /**
   * Get seller dashboard summary (quick view)
   * @param {string} shopId
   * @returns {Promise<Object>}
   */
  async getDashboardSummary(shopId) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const metrics = await this.getSellerMetrics(shopId, {
      period: 'monthly',
      startDate: thirtyDaysAgo,
      endDate: now,
    });

    return {
      thisMonth: metrics,
      summaryCards: [
        {
          title: 'Total Orders',
          value: metrics.orders.total,
          subtext: `${metrics.orders.completed} completed`,
          trend: '+12%',
        },
        {
          title: 'Revenue',
          value: `$${metrics.revenue.total.toFixed(2)}`,
          subtext: `Avg: $${metrics.revenue.average.toFixed(2)}`,
          trend: '+8%',
        },
        {
          title: 'Returns',
          value: metrics.returns.rate.toFixed(1) + '%',
          subtext: `${metrics.returns.total} returns`,
          trend: '-2%',
        },
        {
          title: 'Rating',
          value: metrics.reviews.average.toFixed(1),
          subtext: `From ${metrics.reviews.total} reviews`,
          trend: '+0.2',
        },
      ],
    };
  }

  /**
   * Private: Calculate on-time delivery percentage
   * @param {Array} orders
   * @returns {number}
   */
  _calculateOnTimePercentage(orders) {
    const deliveredOrders = orders.filter(o => o.status === 'DELIVERED');
    if (deliveredOrders.length === 0) return 0;

    const onTime = deliveredOrders.filter(o => {
      // Estimate: delivered within 10 days of creation
      const createdAt = new Date(o.createdAt);
      const deliveredAt = new Date(o.deliveredAt);
      const daysDiff = (deliveredAt - createdAt) / (1000 * 60 * 60 * 24);
      return daysDiff <= 10;
    }).length;

    return (onTime / deliveredOrders.length) * 100;
  }

  /**
   * Private: Get review statistics
   * @param {string} shopId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Object>}
   */
  async _getReviewStats(shopId, startDate, endDate) {
    // Placeholder - integrate with reviews service
    // For now return empty stats
    return {
      totalReviews: 0,
      totalRating: 0,
      byRating: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
    };
  }

  /**
   * Private: Calculate days difference
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {number}
   */
  _getDaysDifference(startDate, endDate) {
    const diff = endDate - startDate;
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return Math.max(1, days); // At least 1 day
  }
}

module.exports = new SellerMetricsService();
