const svc = require('../services/zones.service');
const { ok, created } = require('../../../shared/utils/response');
const { sendAudit, getAdminFromReq } = require('../../../shared/utils/audit-client');

async function createZone(req, res, next) {
  try {
    const result = await svc.createZone(req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_CREATED', adminId, adminName, targetEntity: 'zone', targetId: result._id, ipAddress });
    return created(res, { zone: result }, 'Zone created');
  } catch (err) { return next(err); }
}

async function getZone(req, res, next) {
  try { return ok(res, { zone: await svc.getZone(req.params.id) }); }
  catch (err) { return next(err); }
}

async function updateZone(req, res, next) {
  try {
    const result = await svc.updateZone(req.params.id, req.body);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_UPDATED', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, ipAddress });
    return ok(res, { zone: result }, 'Zone updated');
  } catch (err) { return next(err); }
}

async function deleteZone(req, res, next) {
  try {
    const result = await svc.deleteZone(req.params.id);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_DELETED', level: 'WARNING', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, ipAddress });
    return ok(res, { zone: result }, 'Zone deleted');
  } catch (err) { return next(err); }
}

async function activateZone(req, res, next) {
  try {
    const result = await svc.updateZone(req.params.id, { status: 'active' });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_UPDATED', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, newValue: { status: 'active' }, ipAddress });
    return ok(res, { zone: result }, 'Zone activated');
  } catch (err) { return next(err); }
}

async function deactivateZone(req, res, next) {
  try {
    const result = await svc.updateZone(req.params.id, { status: 'inactive' });
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_UPDATED', level: 'WARNING', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, newValue: { status: 'inactive' }, ipAddress });
    return ok(res, { zone: result }, 'Zone deactivated');
  } catch (err) { return next(err); }
}

async function getZones(req, res, next) {
  try {
    const { status, search, sectorId, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (sectorId) filter.sectorId = sectorId;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { code: rx }];
    }
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;
    const [zones, total] = await Promise.all([svc.getZones(filter, { skip, limit: safeLimit }), svc.countZones(filter)]);
    return ok(res, { zones, count: zones.length, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) || 0 });
  } catch (err) { return next(err); }
}

async function getZoneStats(req, res, next) {
  try { return ok(res, await svc.getZoneStats()); }
  catch (err) { return next(err); }
}

async function addLocationToZone(req, res, next) {
  try {
    const result = await svc.addLocationToZone(req.params.id, req.body.locationId);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_LOCATION_ADDED', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, ipAddress });
    return ok(res, { zone: result }, 'Location added to zone');
  } catch (err) { return next(err); }
}

async function removeLocationFromZone(req, res, next) {
  try {
    const result = await svc.removeLocationFromZone(req.params.id, req.params.locationId);
    const { adminId, adminName, ipAddress } = getAdminFromReq(req);
    sendAudit({ action: 'ZONE_LOCATION_REMOVED', adminId, adminName, targetEntity: 'zone', targetId: req.params.id, ipAddress });
    return ok(res, { zone: result }, 'Location removed from zone');
  } catch (err) { return next(err); }
}

async function checkCoverage(req, res, next) {
  try { return ok(res, await svc.checkCoverage(req.params.locationId)); }
  catch (err) { return next(err); }
}

async function findZoneForLocation(req, res, next) {
  try { const z = await svc.findZoneForLocation(req.params.locationId); return ok(res, { zones: z, count: z.length }); }
  catch (err) { return next(err); }
}

module.exports = {
  createZone, getZone, updateZone, deleteZone, getZones, getZoneStats, activateZone, deactivateZone,
  addLocationToZone, removeLocationFromZone, checkCoverage, findZoneForLocation,
};
