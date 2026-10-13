const adminPlatformService = require('../services/adminPlatform.service');
const { ok, created } = require('../../../shared/utils/response');
const { pickHierarchyFilters } = require('../../../shared/utils/hierarchyScope');

/**
 * Admin Platform Controller
 * Handles hierarchical platform exploration and management
 *
 * Every read forwards the full hierarchy filter set (regionId/cityId/areaId/
 * sectorId/businessId/shopId, plus the legacy locationId/location/region/city/
 * sector spellings) so the service — the single place that resolves them — can
 * never be handed a filter it does not see.
 */

/**
 * Picks the hierarchy filter keys out of a request query object.
 * Delegates to the shared helper so a new spelling cannot be added in one place
 * and forgotten in another.
 */
function hierarchyFilters(query = {}) {
  return pickHierarchyFilters(query);
}

async function getPlatformStats(req, res, next) {
  try {
    const stats = await adminPlatformService.getPlatformStats(hierarchyFilters(req.query));
    return ok(res, { stats });
  } catch (err) {
    return next(err);
  }
}

async function getPendingActions(req, res, next) {
  try {
    const pending = await adminPlatformService.getPendingActions();
    return ok(res, { pending });
  } catch (err) {
    return next(err);
  }
}

async function getHierarchy(req, res, next) {
  try {
    const { location, sector } = req.query;
    const hierarchy = await adminPlatformService.getHierarchy({ location, sector });
    return ok(res, { hierarchy });
  } catch (err) {
    return next(err);
  }
}

async function getBusinesses(req, res, next) {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const result = await adminPlatformService.getBusinesses({
      ...hierarchyFilters(req.query),
      status,
      search,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function getShops(req, res, next) {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const result = await adminPlatformService.getShops({
      ...hierarchyFilters(req.query),
      status,
      search,
      // Batch owner lookup (comma-separated) — the Sellers tab needs the shops
      // of exactly its own page's sellers, in ONE commerce call.
      ownerIds: req.query.ownerIds || undefined,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function getOrders(req, res, next) {
  try {
    const { status, paymentStatus, stage, search, from, to, sellerId, page = 1, limit = 50 } = req.query;
    // The service supports `from`/`to`/`stage`/`sellerId`/`search`, but they were
    // never forwarded — so the console's date range, search box and stage pills
    // all sent values the service never saw and quietly filtered nothing.
    const result = await adminPlatformService.getOrders({
      ...hierarchyFilters(req.query),
      status,
      paymentStatus,
      stage,
      search,
      from,
      to,
      sellerId,
      page: parseInt(page),
      limit: parseInt(limit)
    });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function getOrderPickupDelivery(req, res, next) {
  try {
    const { orderId } = req.params;
    const lifecycle = await adminPlatformService.getOrderPickupDeliveryLifecycle(orderId);
    return ok(res, { lifecycle });
  } catch (err) {
    return next(err);
  }
}

async function getBusinessDetail(req, res, next) {
  try {
    const result = await adminPlatformService.getBusinessDetail(req.params.applicationId);
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

async function approveBusiness(req, res, next) {
  try {
    const { applicationId } = req.params;
    const { notes, reason } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.email || req.headers['x-user-email'] || 'Admin';
    const approved = await adminPlatformService.approveBusiness(applicationId, adminId, notes || reason, adminName);
    return ok(res, { business: approved }, 'Business approved successfully');
  } catch (err) {
    return next(err);
  }
}

async function rejectBusiness(req, res, next) {
  try {
    const { applicationId } = req.params;
    const { reason } = req.body;
    const adminId = req.user?.id || req.headers['x-admin-id'];
    const adminName = req.user?.email || req.headers['x-user-email'] || 'Admin';
    const rejected = await adminPlatformService.rejectBusiness(applicationId, adminId, reason, adminName);
    return ok(res, { business: rejected }, 'Business rejected');
  } catch (err) {
    return next(err);
  }
}

async function getGrowthAnalytics(req, res, next) {
  try {
    const { granularity = 'day', days = 30, from, to } = req.query;
    const analytics = await adminPlatformService.getGrowthAnalytics({
      ...hierarchyFilters(req.query),
      granularity,
      days: parseInt(days),
      from,
      to,
    });
    return ok(res, { analytics });
  } catch (err) {
    return next(err);
  }
}

async function getOperationsOverview(req, res, next) {
  try {
    const overview = await adminPlatformService.getOperationsOverview();
    return ok(res, { operations: overview });
  } catch (err) {
    return next(err);
  }
}

async function getOperationsOrders(req, res, next) {
  try {
    const { stage } = req.params;
    const { status, paymentStatus, from, to, page, limit } = req.query;
    const result = await adminPlatformService.getOperationsOrders(stage, {
      ...hierarchyFilters(req.query),
      status, paymentStatus, from, to,
      page: parseInt(page), limit: parseInt(limit),
    });
    return ok(res, { operations: { stage, ...result } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getPlatformStats,
  getPendingActions,
  getHierarchy,
  getBusinesses,
  getBusinessDetail,
  getShops,
  getOrders,
  getOrderPickupDelivery,
  approveBusiness,
  rejectBusiness,
  getGrowthAnalytics,
  getOperationsOverview,
  getOperationsOrders,
};
