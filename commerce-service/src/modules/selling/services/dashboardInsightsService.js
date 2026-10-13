/**
 * Seller dashboard insights service
 * Analytics for sales, trends, customer behavior
 */

class SellerDashboardInsightsService {
  /**
   * Get sales trend analysis
   */
  static async getSalesTrends(orderRepository, sellerId, days = 30) {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const daily = await orderRepository.aggregate([
      {
        $match: {
          sellerId,
          createdAt: { $gte: sinceDate }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
          },
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgOrder: { $avg: '$totalPrice' }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);

    return {
      period: days,
      trend: daily,
      summary: this._calculateTrendMetrics(daily)
    };
  }

  /**
   * Get top products
   */
  static async getTopProducts(orderRepository, sellerId, limit = 10) {
    return orderRepository.aggregate([
      { $match: { sellerId } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          productName: { $first: '$items.productName' },
          sold: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
          avgRating: { $avg: '$items.rating' }
        }
      },
      { $sort: { sold: -1 } },
      { $limit: limit }
    ]);
  }

  /**
   * Get top categories
   */
  static async getTopCategories(orderRepository, sellerId, limit = 5) {
    return orderRepository.aggregate([
      { $match: { sellerId } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.category',
          orders: { $sum: 1 },
          revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
          items: { $sum: '$items.quantity' }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: limit }
    ]);
  }

  /**
   * Get customer insights
   */
  static async getCustomerInsights(orderRepository, sellerId) {
    const customers = await orderRepository.aggregate([
      { $match: { sellerId } },
      {
        $group: {
          _id: '$buyerId',
          orders: { $sum: 1 },
          spent: { $sum: '$totalPrice' },
          lastOrder: { $max: '$createdAt' },
          firstOrder: { $min: '$createdAt' }
        }
      },
      {
        $project: {
          _id: 1,
          orders: 1,
          spent: 1,
          recurring: { $cond: [{ $gt: ['$orders', 1] }, true, false] },
          lastOrder: 1,
          daysSincePurchase: {
            $divide: [{ $subtract: [new Date(), '$lastOrder'] }, 86400000]
          }
        }
      }
    ]);

    return {
      totalCustomers: customers.length,
      recurringCustomers: customers.filter(c => c.recurring).length,
      avgOrdersPerCustomer: customers.reduce((sum, c) => sum + c.orders, 0) / customers.length,
      avgCustomerLTV: customers.reduce((sum, c) => sum + c.spent, 0) / customers.length,
      activeCustomers: customers.filter(c => c.daysSincePurchase < 30).length
    };
  }

  /**
   * Get inventory turnover analysis
   */
  static async getInventoryTurnover(productRepository, sellerId) {
    return productRepository.aggregate([
      { $match: { sellerId } },
      {
        $project: {
          name: 1,
          stock: 1,
          totalSales: 1,
          turnoverRate: {
            $cond: [
              { $eq: ['$stock', 0] },
              0,
              { $divide: ['$totalSales', { $add: ['$stock', '$totalSales'] }] }
            ]
          },
          velocity: { $divide: ['$totalSales', { $max: [1, '$daysListed'] }] }
        }
      },
      { $sort: { turnoverRate: -1 } },
      { $limit: 10 }
    ]);
  }

  /**
   * Get competitor pricing comparison
   */
  static async getCompetitorPricing(productRepository, productId, limit = 5) {
    const product = await productRepository.findById(productId);
    if (!product) return null;

    const competitors = await productRepository.find({
      category: product.category,
      name: new RegExp(product.name.split(' ')[0], 'i'),
      _id: { $ne: productId },
      price: { $exists: true }
    })
      .select(['name', 'sellerId', 'price', 'rating'])
      .sort({ price: 1 })
      .limit(limit)
      .lean();

    return {
      myProduct: {
        name: product.name,
        price: product.price,
        rating: product.rating
      },
      competitors,
      priceComparison: {
        lowest: Math.min(...competitors.map(c => c.price)),
        highest: Math.max(...competitors.map(c => c.price)),
        average: competitors.reduce((sum, c) => sum + c.price, 0) / competitors.length,
        myPosition: this._getPricePosition(product.price, competitors)
      }
    };
  }

  /**
   * Get performance metrics
   */
  static async getPerformanceMetrics(orderRepository, sellerId) {
    const [orders, reviews] = await Promise.all([
      orderRepository.countDocuments({ sellerId }),
      orderRepository.aggregate([
        { $match: { sellerId } },
        { $unwind: '$items' },
        {
          $group: {
            _id: null,
            avgRating: { $avg: '$items.rating' },
            ratedCount: { $sum: { $cond: ['$items.rating', 1, 0] } }
          }
        }
      ])
    ]);

    return {
      totalOrders: orders,
      avgRating: reviews[0]?.avgRating || 0,
      ratedOrders: reviews[0]?.ratedCount || 0,
      ratingPercent: reviews[0]?.ratedCount ? (reviews[0].ratedCount / orders) * 100 : 0
    };
  }

  // Helpers
  static _calculateTrendMetrics(dailyData) {
    if (dailyData.length === 0) return {};

    const totalRevenue = dailyData.reduce((sum, d) => sum + (d.revenue || 0), 0);
    const totalOrders = dailyData.reduce((sum, d) => sum + (d.orders || 0), 0);

    return {
      totalRevenue,
      totalOrders,
      avgDaily: totalRevenue / dailyData.length,
      avgOrder: totalRevenue / totalOrders
    };
  }

  static _getPricePosition(myPrice, competitors) {
    const higherCount = competitors.filter(c => c.price > myPrice).length;
    return {
      percentile: (higherCount / competitors.length) * 100,
      pricePosition: higherCount === competitors.length ? 'lowest' : 'competitive'
    };
  }
}

module.exports = SellerDashboardInsightsService;
