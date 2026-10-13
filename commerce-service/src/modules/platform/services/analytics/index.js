/**
 * Analytics modules index
 * Exports all analytics utilities
 */

const DateRangeFilter = require('./dateRangeFilter');
const DrillDownAnalytics = require('./drillDownAnalytics');
const AnomalyDetection = require('./anomalyDetection');
const PredictiveAnalytics = require('./predictiveAnalytics');
const ReportService = require('./reportService');
const RealtimeDashboard = require('./realtimeDashboard');

module.exports = {
  DateRangeFilter,
  DrillDownAnalytics,
  AnomalyDetection,
  PredictiveAnalytics,
  ReportService,
  RealtimeDashboard
};
