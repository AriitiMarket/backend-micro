/**
 * FIX #13: Seller Metrics and KPIs Service
 * Calculates key seller performance indicators with caching
 */

const orderRepository = require('../../fulfillment/repositories/orders.repository');
const returnsRepository = require('../../fulfillment/repositories/returns.repository');
const Product = require('../../catalog/models/Products');
const SellerAllocation = require('../../fulfillment/models/SellerAllocation');

function normalizedStatus(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

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
          $or: [{ shopId }, { 'sellerShipments.shopId': shopId }, { sellerId: shopId }],
          createdAt: { $gte: start, $lte: end },
        },
      }),
      returnsRepository.find({
        filter: {
          shopId,
          createdAt: { $gte: start, $lte: end },
        },
        limit: 0,
      }),
      this._getReviewStats(shopId, start, end),
    ]);

    // Calculate metrics
    const completedOrders = orders.filter(
      o => ['DELIVERED', 'COMPLETED'].includes(normalizedStatus(o.status))
    ).length;
    const completed = orders.filter(o => ['DELIVERED', 'COMPLETED'].includes(normalizedStatus(o.status)));
    const totalOrders = orders.length;
    // Reports describe sales of goods, excluding delivery. Only completed
    // orders contribute; cancelled/refunded orders remain in status counts.
    const grossSales = completed.reduce((sum, o) => sum + Number(o.subtotal ?? Math.max(0, Number(o.totalPrice ?? o.total ?? 0) - Number(o.shippingFee || 0))), 0);
    const completedIds = completed.map((order) => String(order._id));
    const allocations = completedIds.length
      ? await SellerAllocation.find({ shopId: String(shopId), orderId: { $in: completedIds } }).lean()
      : [];
    const commissionByOrder = new Map(allocations.map((row) => [String(row.orderId), Number(row.platformCommission) || 0]));
    const commission = completed.reduce((sum, order) => sum + (commissionByOrder.get(String(order._id)) ?? Number(order.commissionAmount || (order.cart || []).reduce((lineSum, item) => lineSum + Number(item.commissionAmount || 0), 0))), 0);
    const netEarnings = Math.round((grossSales - commission) * 100) / 100;
    const averageOrderValue = completedOrders > 0 ? grossSales / completedOrders : 0;
    const statusCounts = orders.reduce((counts, order) => {
      const status = normalizedStatus(order.status);
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    const unitsSold = completed.reduce((sum, order) => sum + (order.cart || []).reduce((lineSum, item) => lineSum + Number(item.quantity ?? item.qty ?? 0), 0), 0);
    const fulfillmentRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;

    const totalReturns = returns.length;
    const approvedReturns = returns.filter(r => normalizedStatus(r.status) === 'APPROVED').length;
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
        cancelled: orders.filter(o => ['CANCELLED', 'CANCELED'].includes(normalizedStatus(o.status))).length,
        refunded: orders.filter(o => ['REFUNDED', 'REFUND_SUCCESS'].includes(normalizedStatus(o.status)) || o.paymentStatus === 'REFUNDED').length,
        pending: orders.filter(o => ['PROCESSING', 'PENDING', 'NEW'].includes(normalizedStatus(o.status))).length,
        byStatus: statusCounts,
      },
      revenue: {
        total: grossSales,
        grossSales,
        commission,
        netEarnings,
        unitsSold,
        deliveryOrders: completed.filter(o => o.fulfilmentType !== 'pickup').length,
        pickupOrders: completed.filter(o => o.fulfilmentType === 'pickup').length,
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
          Math.round((grossSales / this._getDaysDifference(start, end)) * 100) /
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
          value: `${metrics.revenue.total.toFixed(2)} ETB`,
          subtext: `Avg: ${metrics.revenue.average.toFixed(2)} ETB`,
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
    const deliveredOrders = orders.filter(o => ['DELIVERED', 'COMPLETED'].includes(normalizedStatus(o.status)));
    if (deliveredOrders.length === 0) return 0;

    const onTime = deliveredOrders.filter(o => {
      // Estimate: delivered within 10 days of creation
      const createdAt = new Date(o.createdAt);
      const deliveredAt = new Date(o.deliveredAt);
      if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(deliveredAt.getTime())) return false;
      const daysDiff = (deliveredAt - createdAt) / (1000 * 60 * 60 * 24);
      return daysDiff >= 0 && daysDiff <= 10;
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
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter['reviews.createdAt'] = {};
      if (startDate) dateFilter['reviews.createdAt'].$gte = startDate;
      if (endDate) dateFilter['reviews.createdAt'].$lte = endDate;
    }
    const rows = await Product.aggregate([
      { $match: { shopId: String(shopId), 'reviews.moderationStatus': 'approved' } },
      { $unwind: '$reviews' },
      { $match: { 'reviews.moderationStatus': 'approved', ...dateFilter } },
      {
        $group: {
          _id: '$reviews.rating',
          count: { $sum: 1 },
          totalRating: { $sum: '$reviews.rating' },
        },
      },
    ]);
    const byRating = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let totalReviews = 0;
    let totalRating = 0;
    for (const row of rows) {
      const rating = Number(row._id);
      if (byRating[rating] !== undefined) byRating[rating] = row.count;
      totalReviews += row.count;
      totalRating += row.totalRating;
    }
    return {
      totalReviews,
      totalRating,
      byRating,
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
