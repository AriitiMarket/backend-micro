/**
 * Complete Analytics Service - Integrates all analytics modules
 * Exposes unified API for dashboard, reports, and real-time updates
 */

const {
  DateRangeFilter,
  DrillDownAnalytics,
  AnomalyDetection,
  PredictiveAnalytics,
  ReportService,
  RealtimeDashboard
} = require('./index');

class CompleteAnalyticsService {
  constructor(repositories) {
    this.orderRepository = repositories.orders;
    this.paymentRepository = repositories.payments;
    this.shopRepository = repositories.shops;
    this.reportService = new ReportService();
  }

  /**
   * Get complete dashboard data with all analytics
   */
  async getDashboard(params = {}) {
    DateRangeFilter.validate(params.startDate, params.endDate);

    const dateFilter = DateRangeFilter.build(params.startDate, params.endDate);

    const [
      stats,
      anomalies,
      forecast,
      drillDown
    ] = await Promise.all([
      this._getBaseStats(dateFilter),
      AnomalyDetection.getSummary(this.orderRepository, this.paymentRepository),
      PredictiveAnalytics.forecastRevenue(this.orderRepository),
      params.region ? DrillDownAnalytics.getRegionBreakdown(
        params.startDate,
        params.endDate,
        this.orderRepository
      ) : null
    ]);

    return {
      period: {
        startDate: params.startDate,
        endDate: params.endDate,
        label: this._getPeriodLabel(params.startDate, params.endDate)
      },
      metrics: stats,
      anomalies,
      forecast,
      hierarchy: drillDown,
      exportOptions: ['csv', 'pdf'],
      lastUpdated: new Date()
    };
  }

  /**
   * Get drill-down analytics
   */
  async getDrillDown(hierarchy = {}) {
    const { region, city, shopId, startDate, endDate } = hierarchy;

    return DrillDownAnalytics.getHierarchyPath(
      region,
      city,
      shopId,
      startDate,
      endDate,
      this.orderRepository
    );
  }

  /**
   * Get anomaly report
   */
  async getAnomalies() {
    return AnomalyDetection.getSummary(this.orderRepository, this.paymentRepository);
  }

  /**
   * Get forecast
   */
  async getForecast(type = 'revenue', days = 7) {
    if (type === 'revenue') {
      return PredictiveAnalytics.forecastRevenue(this.orderRepository, days);
    } else if (type === 'orders') {
      return PredictiveAnalytics.forecastOrders(this.orderRepository, days);
    }
  }

  /**
   * Get seasonal patterns
   */
  async getSeasonalPatterns() {
    return PredictiveAnalytics.getSeasonalPatterns(this.orderRepository);
  }

  /**
   * Export dashboard data
   */
  async exportDashboard(dashboardData, format = 'csv') {
    if (format === 'csv') {
      return this.reportService.exportToCSV(
        this._flattenDashboardData(dashboardData),
        `dashboard-${Date.now()}`
      );
    } else if (format === 'pdf') {
      return this.reportService.exportToPDF(
        dashboardData,
        'Dashboard Report',
        `dashboard-${Date.now()}`
      );
    }
  }

  /**
   * Create scheduled report
   */
  createScheduledReport(config) {
    return this.reportService.createScheduledReport(config);
  }

  /**
   * Get report history
   */
  async getReportHistory() {
    return this.reportService.getReportHistory();
  }

  /**
   * Start real-time dashboard
   */
  startRealtimeUpdates(interval = 60000) {
    return RealtimeDashboard.startRealtimeUpdates(this, interval);
  }

  /**
   * Get current health
   */
  async getHealthStatus() {
    return RealtimeDashboard.getHealthStatus(this);
  }

  // Internal methods

  async _getBaseStats(dateFilter) {
    const [orderStats] = await this.orderRepository.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$totalPrice' },
          avgOrderValue: { $avg: '$totalPrice' },
          maxOrderValue: { $max: '$totalPrice' },
          minOrderValue: { $min: '$totalPrice' }
        }
      }
    ]);

    const statuses = await this.orderRepository.countByField('status', dateFilter);
    const sellers = await this.orderRepository.aggregate([
      { $match: dateFilter },
      { $group: { _id: '$sellerId' } },
      { $count: 'total' }
    ]);

    return {
      totalOrders: orderStats?.totalOrders || 0,
      totalRevenue: orderStats?.totalRevenue || 0,
      avgOrderValue: Math.round(orderStats?.avgOrderValue || 0),
      maxOrderValue: orderStats?.maxOrderValue || 0,
      minOrderValue: orderStats?.minOrderValue || 0,
      uniqueSellers: sellers?.[0]?.total || 0,
      byStatus: statuses
    };
  }

  _getPeriodLabel(startDate, endDate) {
    if (!startDate && !endDate) return 'All Time';
    const start = new Date(startDate);
    const end = new Date(endDate);
    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
  }

  _flattenDashboardData(dashboard) {
    return [{
      ...dashboard.metrics,
      period: dashboard.period.label,
      timestamp: dashboard.lastUpdated
    }];
  }

  // Stub methods for integration (implement in main analytics service)
  async getActiveOrdersCount() { return 0; }
  async getTodayRevenue() { return 0; }
  async getOnlineUsersCount() { return 0; }
  async checkOrderHealth() { return { status: 'HEALTHY' }; }
  async checkPaymentHealth() { return { status: 'HEALTHY' }; }
  async checkDeliveryHealth() { return { status: 'HEALTHY' }; }
}

module.exports = CompleteAnalyticsService;
