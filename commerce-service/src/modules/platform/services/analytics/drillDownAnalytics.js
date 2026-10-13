/**
 * Drill-down capability for hierarchical analytics
 * Navigate from platform → region → city → shop level
 */

const hierarchyScope = require('../../../../shared/utils/hierarchyScope');

class DrillDownAnalytics {
  /**
   * Get analytics at region level
   */
  static async getRegionBreakdown(startDate, endDate, orderRepository) {
    const pipeline = [
      { $match: this._buildTimeFilter(startDate, endDate) },
      {
        $group: {
          _id: '$sellerRegion',
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgOrderValue: { $avg: '$totalPrice' }
        }
      },
      { $sort: { revenue: -1 } }
    ];

    return orderRepository.aggregate(pipeline);
  }

  /**
   * Get analytics at city level (drill down from region)
   */
  static async getCityBreakdown(region, startDate, endDate, orderRepository) {
    const pipeline = [
      { $match: this._buildTimeFilter(startDate, endDate, { sellerRegion: region }) },
      {
        $group: {
          _id: '$sellerCity',
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgOrderValue: { $avg: '$totalPrice' }
        }
      },
      { $sort: { revenue: -1 } }
    ];

    return orderRepository.aggregate(pipeline);
  }

  /**
   * Get shop-level analytics (drill down from city)
   */
  static async getShopBreakdown(region, city, startDate, endDate, orderRepository) {
    const pipeline = [
      {
        $match: this._buildTimeFilter(startDate, endDate, {
          sellerRegion: region,
          sellerCity: city
        })
      },
      {
        $group: {
          _id: '$shopId',
          shopName: { $first: '$shopName' },
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgOrderValue: { $avg: '$totalPrice' },
          avgRating: { $avg: '$shopRating' }
        }
      },
      { $sort: { revenue: -1 } }
    ];

    return orderRepository.aggregate(pipeline);
  }

  /**
   * Get hierarchical path with metrics at each level
   */
  static async getHierarchyPath(region, city, shopId, startDate, endDate, orderRepository) {
    const [platformTotal, regionData, cityData, shopData] = await Promise.all([
      this._getPlatformTotal(startDate, endDate, orderRepository),
      this.getRegionBreakdown(startDate, endDate, orderRepository),
      city ? this.getCityBreakdown(region, startDate, endDate, orderRepository) : null,
      shopId ? this._getShopMetrics(shopId, startDate, endDate, orderRepository) : null
    ]);

    return {
      platform: platformTotal,
      regions: regionData,
      cities: cityData,
      shop: shopData
    };
  }

  // Helpers
  static _buildTimeFilter(startDate, endDate, additionalFilter = {}) {
    const filter = { ...additionalFilter };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    return filter;
  }

  static async _getPlatformTotal(startDate, endDate, orderRepository) {
    const [row] = await orderRepository.aggregate([
      { $match: this._buildTimeFilter(startDate, endDate) },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' }
        }
      }
    ]);
    return row || { orders: 0, revenue: 0 };
  }

  static async _getShopMetrics(shopId, startDate, endDate, orderRepository) {
    const [row] = await orderRepository.aggregate([
      { $match: this._buildTimeFilter(startDate, endDate, { shopId }) },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgRating: { $avg: '$shopRating' }
        }
      }
    ]);
    return row;
  }
}

module.exports = DrillDownAnalytics;
