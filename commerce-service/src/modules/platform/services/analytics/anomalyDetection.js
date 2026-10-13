/**
 * Anomaly detection for unusual platform activity
 * Detects spikes, drops, and suspicious patterns
 */

class AnomalyDetection {
  /**
   * Detect order spike or drop
   */
  static async detectOrderAnomalies(orderRepository, baseline = 7) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const baselineStart = new Date(today);
    baselineStart.setDate(baselineStart.getDate() - baseline);

    const [todayStats, baselineStats] = await Promise.all([
      this._getOrderStats(today, orderRepository),
      this._getOrderStats(baselineStart, baselineStart, orderRepository)
    ]);

    const avgBaseline = baselineStats.count / baseline;
    const percentChange = ((todayStats.count - avgBaseline) / avgBaseline) * 100;

    return {
      anomaly: Math.abs(percentChange) > 30, // Alert if ±30% change
      type: percentChange > 0 ? 'spike' : 'drop',
      percentChange: Math.round(percentChange),
      todayOrders: todayStats.count,
      baselineAvg: Math.round(avgBaseline),
      todayRevenue: todayStats.revenue,
      severity: Math.abs(percentChange) > 50 ? 'CRITICAL' : 'WARNING'
    };
  }

  /**
   * Detect payment failures
   */
  static async detectPaymentAnomalies(paymentRepository) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalPayments, failedPayments] = await Promise.all([
      paymentRepository.count({ createdAt: { $gte: today } }),
      paymentRepository.count({
        createdAt: { $gte: today },
        status: 'FAILED'
      })
    ]);

    const failureRate = (failedPayments / totalPayments) * 100;

    return {
      anomaly: failureRate > 5, // Alert if >5% failure rate
      failureRate: Math.round(failureRate),
      failedPayments,
      totalPayments,
      severity: failureRate > 10 ? 'CRITICAL' : 'WARNING'
    };
  }

  /**
   * Detect seller activity anomalies
   */
  static async detectSellerAnomalies(orderRepository, threshold = 2) {
    const pipeline = [
      {
        $group: {
          _id: '$sellerId',
          orders: { $sum: 1 },
          avgValue: { $avg: '$totalPrice' },
          stdDev: { $stdDevPop: '$totalPrice' }
        }
      },
      {
        $project: {
          _id: 1,
          orders: 1,
          avgValue: 1,
          deviation: {
            $cond: [
              { $gt: ['$stdDev', { $multiply: ['$avgValue', 0.5] }] },
              'HIGH',
              'NORMAL'
            ]
          }
        }
      },
      { $match: { deviation: 'HIGH' } }
    ];

    return orderRepository.aggregate(pipeline);
  }

  /**
   * Detect delivery delays
   */
  static async detectDeliveryDelays(orderRepository, daysThreshold = 3) {
    const expectedDeliveryDate = new Date();
    expectedDeliveryDate.setDate(expectedDeliveryDate.getDate() - daysThreshold);

    const pipeline = [
      {
        $match: {
          status: { $nin: ['DELIVERED', 'CANCELLED'] },
          expectedDeliveryDate: { $lt: expectedDeliveryDate }
        }
      },
      {
        $group: {
          _id: '$sellerId',
          delayedOrders: { $sum: 1 },
          avgDaysLate: {
            $avg: {
              $divide: [
                { $subtract: [new Date(), '$expectedDeliveryDate'] },
                86400000 // ms to days
              ]
            }
          }
        }
      }
    ];

    return orderRepository.aggregate(pipeline);
  }

  /**
   * Get summary of all anomalies
   */
  static async getSummary(orderRepository, paymentRepository) {
    const [orderAnomalies, paymentAnomalies, sellerAnomalies, deliveryDelays] = await Promise.all([
      this.detectOrderAnomalies(orderRepository),
      this.detectPaymentAnomalies(paymentRepository),
      this.detectSellerAnomalies(orderRepository),
      this.detectDeliveryDelays(orderRepository)
    ]);

    const anomalies = [];
    if (orderAnomalies.anomaly) anomalies.push(orderAnomalies);
    if (paymentAnomalies.anomaly) anomalies.push(paymentAnomalies);
    if (sellerAnomalies.length > 0) anomalies.push({ type: 'seller', data: sellerAnomalies });
    if (deliveryDelays.length > 0) anomalies.push({ type: 'delivery', data: deliveryDelays });

    return {
      hasAnomalies: anomalies.length > 0,
      anomalies,
      timestamp: new Date()
    };
  }

  // Helper
  static async _getOrderStats(startDate, endDate, orderRepository) {
    const [stats] = await orderRepository.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lt: endDate }
        }
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: { $sum: '$totalPrice' }
        }
      }
    ]);
    return stats || { count: 0, revenue: 0 };
  }
}

module.exports = AnomalyDetection;
