/**
 * ENHANCED: Admin Dashboard Analytics Service
 * Complete analytics engine for platform admins with hierarchy scoping
 */

const orderRepo = require('../../fulfillment/repositories/orders.repository');
const shopRepo = require('../../selling/repositories/shops.repository');
const productRepo = require('../../catalog/repositories/products.repository');
const sellerAppRepo = require('../../selling/repositories/sellerApplications.repository');
const disputesRepo = require('../../fulfillment/repositories/disputes.repository');
const { deliveryClient } = require('../../../app/clients/delivery.client');
const hierarchyScope = require('../../../shared/utils/hierarchyScope');

class AdminAnalyticsService {
  /**
   * Get dashboard overview with hierarchy scope
   */
  async getDashboardOverview(scopeFilters = {}) {
    try {
      const query = await hierarchyScope.resolveHierarchyScope(scopeFilters);

      if (query === hierarchyScope.MATCHES_NOTHING) {
        return this._emptyDashboard();
      }

      // Parallel queries for performance
      const [
        stats,
        revenueData,
        orderStats,
        deliveryStats,
        applicationsStats,
        disputesStats
      ] = await Promise.all([
        this._getBasicStats(query),
        this._getRevenueData(query),
        this._getOrderStats(query),
        this._getDeliveryStats(query),
        this._getApplicationsStats(query),
        this._getDisputesStats(query)
      ]);

      return {
        timestamp: new Date(),
        scope: query,
        overview: stats,
        revenue: revenueData,
        orders: orderStats,
        delivery: deliveryStats,
        applications: applicationsStats,
        disputes: disputesStats
      };
    } catch (err) {
      console.error('[AdminAnalytics.getDashboardOverview]', err);
      return this._emptyDashboard();
    }
  }

  /**
   * Get basic platform stats
   */
  async _getBasicStats(query) {
    const shops = await shopRepo.count(query);
    const products = await productRepo.count({ ...query, isActive: true });
    const orders = await orderRepo.count(query);
    const sellers = await shopRepo.distinct('ownerId', query);

    return {
      shops,
      products,
      orders,
      activeSellers: sellers.length,
      avgProductsPerShop: shops > 0 ? (products / shops).toFixed(2) : 0
    };
  }

  /**
   * Get revenue data
   */
  async _getRevenueData(query) {
    const orders = await orderRepo.find(query);
    
    const totalRevenue = orders.reduce((sum, order) => {
      if (order.status === 'COMPLETED') return sum + (order.total || 0);
      return sum;
    }, 0);

    const sellerRevenue = {};
    for (const order of orders) {
      if (order.status === 'COMPLETED') {
        const seller = order.sellerId;
        sellerRevenue[seller] = (sellerRevenue[seller] || 0) + (order.total || 0);
      }
    }

    const topSellers = Object.entries(sellerRevenue)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sellerId, revenue]) => ({ sellerId, revenue }));

    return {
      totalRevenue,
      totalOrders: orders.length,
      avgOrderValue: orders.length > 0 ? (totalRevenue / orders.length).toFixed(2) : 0,
      topSellers,
      revenueByStatus: this._groupByStatus(orders, 'total')
    };
  }

  /**
   * Get order statistics
   */
  async _getOrderStats(query) {
    const orders = await orderRepo.find(query);

    const statuses = {
      PENDING: 0,
      PAYMENT_CONFIRMED: 0,
      READY_FOR_PICKUP: 0,
      PICKED_UP: 0,
      DELIVERED: 0,
      COMPLETED: 0,
      CANCELLED: 0,
      FAILED: 0
    };

    for (const order of orders) {
      const status = order.status || 'PENDING';
      if (statuses[status] !== undefined) {
        statuses[status]++;
      }
    }

    const avgDeliveryTime = this._calculateAvgDeliveryTime(orders);
    const completionRate = orders.length > 0 
      ? ((statuses.COMPLETED / orders.length) * 100).toFixed(2)
      : 0;

    return {
      byStatus: statuses,
      total: orders.length,
      avgDeliveryTime: `${avgDeliveryTime} hours`,
      completionRate: `${completionRate}%`,
      trend: await this._getOrderTrend(query)
    };
  }

  /**
   * Get delivery statistics
   */
  async _getDeliveryStats(query) {
    try {
      const deliveryStats = await deliveryClient.getDeliveryStats(query);
      
      if (!deliveryStats) {
        return {
          totalDeliveries: 0,
          avgDeliveryTime: 0,
          successRate: 0,
          activeProviders: 0
        };
      }

      return {
        totalDeliveries: deliveryStats.total || 0,
        avgDeliveryTime: deliveryStats.avgTime || 0,
        successRate: deliveryStats.successRate || 0,
        activeProviders: deliveryStats.activeProviders || 0,
        topRoutes: deliveryStats.topRoutes || []
      };
    } catch (err) {
      console.warn('[AdminAnalytics._getDeliveryStats]', err.message);
      return {
        totalDeliveries: 0,
        avgDeliveryTime: 0,
        successRate: 0,
        activeProviders: 0,
        error: 'Unable to fetch delivery stats'
      };
    }
  }

  /**
   * Get seller applications statistics
   */
  async _getApplicationsStats(query) {
    const applications = await sellerAppRepo.find(query);

    const statuses = {
      DRAFT: 0,
      PENDING_REVIEW: 0,
      MORE_INFORMATION_REQUIRED: 0,
      APPROVED: 0,
      REJECTED: 0,
      SUSPENDED: 0
    };

    for (const app of applications) {
      const status = app.status || 'DRAFT';
      if (statuses[status] !== undefined) {
        statuses[status]++;
      }
    }

    return {
      byStatus: statuses,
      total: applications.length,
      pendingReview: statuses.PENDING_REVIEW + statuses.MORE_INFORMATION_REQUIRED,
      approvalRate: applications.length > 0
        ? ((statuses.APPROVED / applications.length) * 100).toFixed(2)
        : 0
    };
  }

  /**
   * Get disputes statistics
   */
  async _getDisputesStats(query) {
    const disputes = await disputesRepo.find(query);

    const statuses = {
      OPEN: 0,
      IN_PROGRESS: 0,
      RESOLVED: 0,
      REJECTED: 0
    };

    const priorities = {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0
    };

    for (const dispute of disputes) {
      const status = dispute.status || 'OPEN';
      const priority = dispute.priority || 'MEDIUM';

      if (statuses[status] !== undefined) statuses[status]++;
      if (priorities[priority] !== undefined) priorities[priority]++;
    }

    const avgResolutionTime = this._calculateAvgResolutionTime(disputes);

    return {
      byStatus: statuses,
      byPriority: priorities,
      total: disputes.length,
      open: statuses.OPEN + statuses.IN_PROGRESS,
      avgResolutionTime: `${avgResolutionTime} hours`,
      resolved: statuses.RESOLVED
    };
  }

  /**
   * Get time-series data for charts
   */
  async getTimeSeries(scopeFilters = {}, days = 30) {
    try {
      const query = await hierarchyScope.resolveHierarchyScope(scopeFilters);
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const orders = await orderRepo.find({
        ...query,
        createdAt: { $gte: startDate }
      });

      const timeSeries = {};
      for (let i = 0; i < days; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        timeSeries[dateStr] = {
          orders: 0,
          revenue: 0,
          completed: 0
        };
      }

      for (const order of orders) {
        const dateStr = new Date(order.createdAt).toISOString().split('T')[0];
        if (timeSeries[dateStr]) {
          timeSeries[dateStr].orders++;
          if (order.status === 'COMPLETED') {
            timeSeries[dateStr].revenue += order.total || 0;
            timeSeries[dateStr].completed++;
          }
        }
      }

      return timeSeries;
    } catch (err) {
      console.error('[AdminAnalytics.getTimeSeries]', err);
      return {};
    }
  }

  // Helper methods
  _emptyDashboard() {
    return {
      timestamp: new Date(),
      overview: { shops: 0, products: 0, orders: 0, activeSellers: 0 },
      revenue: { totalRevenue: 0 },
      orders: { byStatus: {}, total: 0 },
      delivery: { totalDeliveries: 0 },
      applications: { total: 0 },
      disputes: { total: 0 },
      error: 'No data for scope'
    };
  }

  _groupByStatus(items, field) {
    const grouped = {};
    for (const item of items) {
      const status = item.status || 'UNKNOWN';
      grouped[status] = (grouped[status] || 0) + (item[field] || 0);
    }
    return grouped;
  }

  _calculateAvgDeliveryTime(orders) {
    let total = 0;
    let count = 0;

    for (const order of orders) {
      if (order.deliveredAt && order.createdAt) {
        const hours = (new Date(order.deliveredAt) - new Date(order.createdAt)) / (1000 * 60 * 60);
        total += hours;
        count++;
      }
    }

    return count > 0 ? Math.round(total / count) : 0;
  }

  _calculateAvgResolutionTime(disputes) {
    let total = 0;
    let count = 0;

    for (const dispute of disputes) {
      if (dispute.resolvedAt && dispute.createdAt) {
        const hours = (new Date(dispute.resolvedAt) - new Date(dispute.createdAt)) / (1000 * 60 * 60);
        total += hours;
        count++;
      }
    }

    return count > 0 ? Math.round(total / count) : 0;
  }

  async _getOrderTrend(query) {
    const now = new Date();
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const ordersThisWeek = await orderRepo.count({
      ...query,
      createdAt: { $gte: lastWeek }
    });

    const ordersLastMonth = await orderRepo.count({
      ...query,
      createdAt: { $gte: lastMonth }
    });

    return {
      thisWeek: ordersThisWeek,
      thisMonth: ordersLastMonth,
      weeklyAvg: Math.round(ordersLastMonth / 4)
    };
  }
}

module.exports = new AdminAnalyticsService();
