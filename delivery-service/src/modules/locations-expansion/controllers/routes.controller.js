const svc = require('../services/routes.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');
const { validationError } = require('../../../shared/errors');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

async function createRoute(req, res, next) {
  try {
    const result = await svc.createRoute(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ROUTE_CREATED', adminId, adminName, targetEntity: 'route', targetId: result._id, ipAddress });
    return created(res, { route: result }, 'Route created');
  } catch (err) { return next(err); }
}

async function getRoute(req, res, next) {
  try { return ok(res, { route: await svc.getRoute(req.params.id) }); }
  catch (err) { return next(err); }
}

async function updateRoute(req, res, next) {
  try {
    const result = await svc.updateRoute(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ROUTE_UPDATED', adminId, adminName, targetEntity: 'route', targetId: req.params.id, ipAddress });
    return ok(res, { route: result }, 'Route updated');
  } catch (err) { return next(err); }
}

async function deleteRoute(req, res, next) {
  try {
    const result = await svc.deleteRoute(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ROUTE_DELETED', level: 'WARNING', adminId, adminName, targetEntity: 'route', targetId: req.params.id, ipAddress });
    return ok(res, { route: result }, 'Route deleted');
  } catch (err) { return next(err); }
}

async function getRoutes(req, res, next) {
  try {
    const { status, originId, destinationId, search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (originId) filter.originLocationId = originId;
    if (destinationId) filter.destinationLocationId = destinationId;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [routes, total] = await Promise.all([svc.getRoutes(filter, { skip, limit: safeLimit }), svc.countRoutes(filter)]);
    return ok(res, { routes, count: routes.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 });
  } catch (err) { return next(err); }
}

async function getRouteStats(req, res, next) {
  try { return ok(res, await svc.getRouteStats()); }
  catch (err) { return next(err); }
}

/**
 * `GET /delivery/route/search?originId&destinationId` — the existing connection
 * between two locations, or `route: null`.
 *
 * The admin console calls this before creating a connection so it can offer
 * "reactivate the existing route" instead of a duplicate (which the service
 * refuses with 409). Without this route the request fell through to `/:id`,
 * where `id = 'search'` raised `INVALID_ID` — so that check could never pass.
 */
async function searchRoute(req, res, next) {
  try {
    const { originId, destinationId } = req.query;
    if (!originId || !destinationId) {
      throw validationError(['"originId" and "destinationId" are required']);
    }
    for (const [field, value] of [['originId', originId], ['destinationId', destinationId]]) {
      if (!isValidObjectId(value)) throw validationError([`"${field}" must be a valid location identifier`]);
    }
    const route = await svc.findRouteByEndpoints(originId, destinationId);
    return ok(res, { route: route || null }, route ? 'Connection found' : 'No connection yet');
  } catch (err) { return next(err); }
}

module.exports = { createRoute, getRoute, updateRoute, deleteRoute, getRoutes, getRouteStats, searchRoute };
