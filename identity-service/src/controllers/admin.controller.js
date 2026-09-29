const adminService = require('../services/admin.service');
const auditService = require('../services/audit.service');
const { ok } = require('../utils/response');

async function listUsers(req, res, next) {
  try {
    const { role, status, search, ids, page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await adminService.listUsers({ role, status, search, ids, limit: parseInt(limit), offset });
    return ok(res, {
      users: result.users || [],
      total: result.total || 0,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil((result.total || 0) / parseInt(limit)),
    });
  } catch (err) { return next(err); }
}

async function getUser(req, res, next) {
  try {
    const user = await adminService.getUser(req.params.id);
    return ok(res, { user });
  } catch (err) { return next(err); }
}

async function setRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const user = await adminService.setRole(req.params.id, req.body.role, adminId, adminName, req);
    return ok(res, { user }, 'Role updated');
  } catch (err) { return next(err); }
}

async function setUserStatus(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const user = await adminService.setUserStatus(req.params.id, req.body.status, adminId, adminName, req);
    return ok(res, { user }, 'Status updated');
  } catch (err) { return next(err); }
}

async function setAdminScope(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const oldScope = await adminService.getAdminScope(req.params.id);
    const user = await adminService.setAdminScope(req.params.id, req.body.scope);
    await auditService.logAdminScopeChanged(adminId, adminName, req.params.id, oldScope, req.body.scope, req);
    return ok(res, { user, scope: user.adminScope }, 'Admin scope updated');
  } catch (err) { return next(err); }
}

async function getAdminScope(req, res, next) {
  try {
    const scope = await adminService.getAdminScope(req.params.id);
    return ok(res, { scope });
  } catch (err) { return next(err); }
}

async function listSellers(req, res, next) {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await adminService.listSellers({ status, search, limit: parseInt(limit), offset });
    return ok(res, result);
  } catch (err) { return next(err); }
}

async function getSeller(req, res, next) {
  try {
    const seller = await adminService.getSeller(req.params.id);
    return ok(res, { seller });
  } catch (err) { return next(err); }
}

async function getDashboardStats(req, res, next) {
  try {
    const stats = await adminService.getDashboardStats();
    return ok(res, { stats });
  } catch (err) { return next(err); }
}

async function getPendingStats(req, res, next) {
  try {
    const data = await adminService.getPendingStats();
    return ok(res, { data });
  } catch (err) { return next(err); }
}

module.exports = { listUsers, getUser, setRole, setUserStatus, setAdminScope, getAdminScope, listSellers, getSeller, getDashboardStats, getPendingStats };
