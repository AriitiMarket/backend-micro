const svc = require('../services/locations.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function createLocation(req, res, next) {
  try {
    const result = await svc.createLocation(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'LOCATION_CREATED', adminId, adminName, targetEntity: 'location', targetId: result._id, ipAddress });
    return created(res, { location: result }, 'Location created');
  } catch (err) { return next(err); }
}

async function getLocation(req, res, next) {
  try { return ok(res, { location: await svc.getLocation(req.params.id) }); }
  catch (err) { return next(err); }
}

async function updateLocation(req, res, next) {
  try {
    const result = await svc.updateLocation(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'LOCATION_UPDATED', adminId, adminName, targetEntity: 'location', targetId: req.params.id, ipAddress });
    return ok(res, { location: result }, 'Location updated');
  } catch (err) { return next(err); }
}

async function deactivateLocation(req, res, next) {
  try {
    const result = await svc.deactivateLocation(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'LOCATION_DEACTIVATED', level: 'WARNING', adminId, adminName, targetEntity: 'location', targetId: req.params.id, ipAddress });
    return ok(res, { location: result }, 'Location deactivated');
  } catch (err) { return next(err); }
}

async function activateLocation(req, res, next) {
  try {
    const result = await svc.activateLocation(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'LOCATION_ACTIVATED', adminId, adminName, targetEntity: 'location', targetId: req.params.id, ipAddress });
    return ok(res, { location: result }, 'Location activated');
  } catch (err) { return next(err); }
}

async function getChildren(req, res, next) {
  try { const c = await svc.getChildren(req.params.id); return ok(res, { children: c, count: c.length }); }
  catch (err) { return next(err); }
}

async function getLocations(req, res, next) {
  try {
    const { type, parentId, q, status, serviceable, port, expansionStatus, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (parentId) filter.parentId = parentId;
    if (status === 'active') filter.isActive = true;
    else if (status === 'inactive') filter.isActive = false;
    else if (status !== 'all') filter.isActive = true;
    if (serviceable === 'true' || serviceable === 'false') filter['serviceability.serviceable'] = serviceable === 'true';
    if (port === 'true' || port === 'false') filter['port.isPort'] = port === 'true';
    if (expansionStatus) filter.expansionStatus = expansionStatus;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { localName: rx }, { code: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [locations, total] = await Promise.all([
      svc.getLocations(filter, { skip, limit: safeLimit }),
      svc.countLocations(filter),
    ]);
    return ok(res, { locations, count: locations.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 });
  } catch (err) { return next(err); }
}

async function getLocationStats(_req, res, next) {
  try { return ok(res, await svc.getLocationStats()); }
  catch (err) { return next(err); }
}

async function searchLocations(req, res, next) {
  try {
    const { q } = req.query;
    if (!q) return ok(res, { locations: [], count: 0 });
    const r = await svc.searchLocations(q);
    return ok(res, { locations: r, count: r.length });
  } catch (err) { return next(err); }
}

async function getAncestors(req, res, next) {
  try { const a = await svc.getAncestors(req.params.id); return ok(res, { ancestors: a, count: a.length }); }
  catch (err) { return next(err); }
}

async function getTypeRules(_req, res) { return ok(res, svc.getTypeRules()); }

async function getHierarchy(req, res, next) {
  try { return ok(res, { hierarchy: await svc.getHierarchy() }); }
  catch (err) { return next(err); }
}

async function bulkCreateLocations(req, res, next) {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body && req.body.rows;
    const result = await svc.bulkCreateLocations(rows);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'LOCATION_CREATED', adminId, adminName, targetEntity: 'location', details: { bulk: true, created: result.createdCount, failed: result.failedCount }, ipAddress });
    return created(res, result, `${result.createdCount} of ${result.total} locations imported`);
  } catch (err) { return next(err); }
}

module.exports = {
  createLocation, getLocation, updateLocation, deactivateLocation, activateLocation,
  getChildren, getLocations, getLocationStats, searchLocations, getAncestors, getTypeRules, getHierarchy, bulkCreateLocations,
};
