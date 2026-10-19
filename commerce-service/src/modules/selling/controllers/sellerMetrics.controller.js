/**
 * Seller Metrics Controller
 * FIX #13: KPI dashboard for seller portal
 */

const sellerMetricsService = require('../services/sellerMetrics.service');

class SellerMetricsController {
  /**
   * Get seller metrics (FIX #13)
   * Supports daily, weekly, monthly periods
   */
  async getMetrics(req, res, next) {
    try {
      const { shopId } = req.params;
      const { period = 'daily', startDate, endDate } = req.query;

      const metrics = await sellerMetricsService.getSellerMetrics(shopId, {
        period,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      res.json(metrics);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get dashboard summary (quick view for seller dashboard)
   * FIX #13: Displays cards with trends
   */
  async getDashboardSummary(req, res, next) {
    try {
      const { shopId } = req.params;

      const summary = await sellerMetricsService.getDashboardSummary(shopId);

      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new SellerMetricsController();
