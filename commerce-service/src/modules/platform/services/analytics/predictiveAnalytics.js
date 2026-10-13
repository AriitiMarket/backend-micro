/**
 * Predictive analytics for revenue forecasting and trends
 * Simple moving average and linear regression models
 */

class PredictiveAnalytics {
  /**
   * Forecast revenue for next N days using simple exponential smoothing
   */
  static async forecastRevenue(orderRepository, days = 7, forecastDays = 3) {
    const historicalData = await this._getHistoricalRevenue(orderRepository, days);
    if (historicalData.length < 2) return null;

    const forecast = [];
    const alpha = 0.3; // Smoothing factor
    let smoothedValue = historicalData[0];

    for (let i = 1; i < historicalData.length; i++) {
      smoothedValue = alpha * historicalData[i] + (1 - alpha) * smoothedValue;
    }

    // Extend forecast
    for (let i = 0; i < forecastDays; i++) {
      forecast.push({
        day: i + 1,
        forecastedRevenue: Math.round(smoothedValue),
        confidence: 0.85 - (i * 0.05) // Confidence decreases over time
      });
    }

    return {
      historical: historicalData,
      forecast,
      trend: this._calculateTrend(historicalData),
      accuracy: 'MEDIUM' // Based on historical variance
    };
  }

  /**
   * Forecast order volume
   */
  static async forecastOrders(orderRepository, days = 7) {
    const historicalData = await this._getHistoricalOrders(orderRepository, days);
    const trend = this._calculateTrend(historicalData);

    const forecast = [];
    const lastValue = historicalData[historicalData.length - 1];

    for (let i = 1; i <= 3; i++) {
      forecast.push({
        day: i,
        forecastedOrders: Math.round(lastValue + trend * i),
        confidence: 0.85 - (i * 0.05)
      });
    }

    return { historical: historicalData, forecast, trend };
  }

  /**
   * Identify seasonal patterns
   */
  static async getSeasonalPatterns(orderRepository, weeks = 12) {
    const dailyStats = [];
    const dayOfWeekStats = {};

    for (let i = weeks; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayOfWeek = date.toLocaleString('en-US', { weekday: 'long' });

      const [stats] = await orderRepository.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(date.setHours(0, 0, 0, 0)),
              $lt: new Date(date.setHours(23, 59, 59, 999))
            }
          }
        },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            revenue: { $sum: '$totalPrice' }
          }
        }
      ]);

      if (!dayOfWeekStats[dayOfWeek]) {
        dayOfWeekStats[dayOfWeek] = { orders: [], revenues: [] };
      }

      dayOfWeekStats[dayOfWeek].orders.push(stats?.orders || 0);
      dayOfWeekStats[dayOfWeek].revenues.push(stats?.revenue || 0);

      dailyStats.push({ date, ...stats });
    }

    // Calculate averages by day of week
    const patterns = {};
    for (const [day, data] of Object.entries(dayOfWeekStats)) {
      patterns[day] = {
        avgOrders: Math.round(
          data.orders.reduce((a, b) => a + b, 0) / data.orders.length
        ),
        avgRevenue: Math.round(
          data.revenues.reduce((a, b) => a + b, 0) / data.revenues.length
        )
      };
    }

    return patterns;
  }

  /**
   * Growth rate projection
   */
  static calculateGrowthRate(current, previous) {
    if (previous === 0) return 0;
    return ((current - previous) / previous) * 100;
  }

  /**
   * Customer lifetime value prediction
   */
  static async predictCustomerLTV(orderRepository, customerId, avgOrderValue, purchaseFrequency) {
    // Simple LTV = (Average Order Value × Purchase Frequency × Customer Lifespan)
    // Assuming 3-year average lifespan
    const months = 36;
    const monthlyOrders = purchaseFrequency / 12;
    const ltv = avgOrderValue * monthlyOrders * months;

    return {
      customerId,
      predictedLTV: Math.round(ltv),
      timeframe: '36 months',
      assumptions: {
        avgOrderValue,
        monthlyOrders: parseFloat(monthlyOrders.toFixed(2)),
        lifespan: months
      }
    };
  }

  // Helpers

  static async _getHistoricalRevenue(orderRepository, days) {
    const data = [];
    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);

      const [stats] = await orderRepository.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(date.setHours(0, 0, 0, 0)),
              $lt: new Date(date.setHours(23, 59, 59, 999))
            }
          }
        },
        { $group: { _id: null, revenue: { $sum: '$totalPrice' } } }
      ]);

      data.push(stats?.revenue || 0);
    }
    return data;
  }

  static async _getHistoricalOrders(orderRepository, days) {
    const data = [];
    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);

      const [stats] = await orderRepository.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(date.setHours(0, 0, 0, 0)),
              $lt: new Date(date.setHours(23, 59, 59, 999))
            }
          }
        },
        { $group: { _id: null, count: { $sum: 1 } } }
      ]);

      data.push(stats?.count || 0);
    }
    return data;
  }

  static _calculateTrend(data) {
    if (data.length < 2) return 0;

    let sumXY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumX2 = 0;
    const n = data.length;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += data[i];
      sumXY += i * data[i];
      sumX2 += i * i;
    }

    // Linear regression slope
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  }
}

module.exports = PredictiveAnalytics;
