const analyticsService = require('../services/analytics.service');
const { ok } = require('../../../shared/utils/response');
const { pickHierarchyFilters } = require('../../../shared/utils/hierarchyScope');

/**
 * Analytics controller.
 *
 * The order/shop/dispute metrics accept the admin console's hierarchy filters, so
 * the dashboard can be scoped to a selected region/city/sector/business. Metrics
 * whose domain is not scopeable (users, riders, products, deliveries) report
 * platform-wide values and say so via `scopeNote` on the stats payload.
 */
async function getStats(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const stats = await analyticsService.getStats(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { stats });
  } catch (err) { return next(err); }
}

async function getUsersGrowth(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const growth = await analyticsService.getGrowth(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { growth });
  } catch (err) { return next(err); }
}

async function getOrdersByType(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const slices = await analyticsService.getOrdersByType(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { slices });
  } catch (err) { return next(err); }
}

async function getSalesByType(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const sales = await analyticsService.getSalesByType(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { sales });
  } catch (err) { return next(err); }
}

async function getSalesOverTime(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getSalesOverTime(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getOrdersByStatus(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getOrdersByStatus(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getCategoryActivity(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getCategoryActivity(startDate, endDate);
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getProductStats(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getProductStats(startDate, endDate);
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getDisputeStats(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getDisputeStats(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getDeliveryStats(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getDeliveryStats(startDate, endDate);
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getRiderPerformance(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getRiderPerformance(startDate, endDate);
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getShopStats(req, res, next) {
  try {
    const { startDate, endDate } = req.query;
    const data = await analyticsService.getShopStats(startDate, endDate, pickHierarchyFilters(req.query));
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getDashboardUsers(req, res, next) {
  try {
    const counts = await analyticsService.getDashboardUsers();
    return ok(res, { counts });
  } catch (err) { return next(err); }
}

async function getPendingApprovals(req, res, next) {
  try {
    const data = await analyticsService.getPendingApprovals();
    return ok(res, { data });
  } catch (err) { return next(err); }
}

async function getRecentActivity(req, res, next) {
  try {
    const data = await analyticsService.getRecentActivity();
    return ok(res, { data });
  } catch (err) { return next(err); }
}

module.exports = {
  getStats, getUsersGrowth, getOrdersByType, getSalesByType,
  getSalesOverTime, getOrdersByStatus, getCategoryActivity, getProductStats,
  getDisputeStats, getDeliveryStats, getRiderPerformance, getShopStats,
  getDashboardUsers, getPendingApprovals, getRecentActivity,
};
