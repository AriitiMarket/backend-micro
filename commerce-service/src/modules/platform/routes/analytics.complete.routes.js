/**
 * Analytics API Routes
 * Integrates complete analytics system
 */

const express = require('express');
const router = express.Router();
const authenticate = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');
const CompleteAnalyticsService = require('../services/analytics.complete');

// Initialize with repositories (inject in app setup)
let analyticsService;

const setAnalyticsService = (repositories) => {
  analyticsService = new CompleteAnalyticsService(repositories);
};

/**
 * GET /api/analytics/dashboard
 * Get complete dashboard with all metrics
 */
router.get('/dashboard', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const dashboard = await analyticsService.getDashboard({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      region: req.query.region
    });

    res.json({
      success: true,
      data: dashboard
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/drill-down
 * Get hierarchical drill-down data
 */
router.get('/drill-down', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const drillDown = await analyticsService.getDrillDown({
      region: req.query.region,
      city: req.query.city,
      shopId: req.query.shopId,
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });

    res.json({ success: true, data: drillDown });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/anomalies
 * Get anomaly detection report
 */
router.get('/anomalies', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const anomalies = await analyticsService.getAnomalies();
    res.json({ success: true, data: anomalies });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/forecast
 * Get predictive forecast (revenue or orders)
 */
router.get('/forecast', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const forecast = await analyticsService.getForecast(
      req.query.type || 'revenue',
      parseInt(req.query.days || 7)
    );

    res.json({ success: true, data: forecast });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/seasonal-patterns
 * Get seasonal business patterns
 */
router.get('/seasonal-patterns', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const patterns = await analyticsService.getSeasonalPatterns();
    res.json({ success: true, data: patterns });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/analytics/export
 * Export dashboard data to CSV/PDF
 */
router.post('/export', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const { format, dashboardData } = req.body;

    const exported = await analyticsService.exportDashboard(
      dashboardData,
      format || 'csv'
    );

    res.json({ success: true, data: exported });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/analytics/scheduled-reports
 * Create scheduled report
 */
router.post('/scheduled-reports', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const report = analyticsService.createScheduledReport({
      name: req.body.name,
      type: req.body.type, // daily, weekly, monthly
      metrics: req.body.metrics,
      recipients: req.body.recipients,
      format: req.body.format || 'csv'
    });

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/reports-history
 * Get report history
 */
router.get('/reports-history', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const history = await analyticsService.getReportHistory();
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/analytics/health
 * Get platform health status
 */
router.get('/health', authenticate, authorize(['admin']), async (req, res) => {
  try {
    const health = await analyticsService.getHealthStatus();
    res.json({ success: true, data: health });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = { router, setAnalyticsService };
