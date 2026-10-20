/**
 * Seller Metrics Controller
 * FIX #13: KPI dashboard for seller portal
 */

const sellerMetricsService = require('../services/sellerMetrics.service');

function parseAddisDate(value, endOfDay = false) {
  if (!value) return undefined;
  const text = String(value);
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    date = new Date(`${text}T00:00:00+03:00`);
    if (endOfDay) date = new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

class SellerMetricsController {
  /**
   * Get seller metrics (FIX #13)
   * Supports daily, weekly, monthly periods
   */
  async getMetrics(req, res, next) {
    try {
      const { shopId } = req.params;
      const { period = 'daily', startDate, endDate } = req.query;

      const start = parseAddisDate(startDate);
      const end = parseAddisDate(endDate, true);
      if (startDate && !start || endDate && !end || start && end && start > end) {
        return res.status(422).json({ code: 'INVALID_DATE_RANGE', message: 'Invalid date range' });
      }
      const metrics = await sellerMetricsService.getSellerMetrics(shopId, {
        period,
        startDate: start,
        endDate: end,
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
