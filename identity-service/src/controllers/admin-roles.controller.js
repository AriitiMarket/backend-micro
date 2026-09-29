// Admin roles controller — handles HTTP requests for role and permission management.
const adminRolesService = require('../services/admin-roles.service');
const { ok } = require('../utils/response');

async function listPermissions(req, res, next) {
  try {
    const permissions = await adminRolesService.listPermissions();
    return ok(res, { permissions });
  } catch (err) { return next(err); }
}

async function listPermissionsByModule(req, res, next) {
  try {
    const permissions = await adminRolesService.listPermissionsByModule();
    return ok(res, { permissions });
  } catch (err) { return next(err); }
}

async function listRoles(req, res, next) {
  try {
    const roles = await adminRolesService.listRoles();
    return ok(res, { roles });
  } catch (err) { return next(err); }
}

async function getRole(req, res, next) {
  try {
    const role = await adminRolesService.getRole(req.params.id);
    return ok(res, { role });
  } catch (err) { return next(err); }
}

async function createRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const role = await adminRolesService.createRole(req.body, adminId, adminName, req);
    return ok(res, { role }, 'Role created');
  } catch (err) { return next(err); }
}

async function updateRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const role = await adminRolesService.updateRole(req.params.id, req.body, adminId, adminName, req);
    return ok(res, { role }, 'Role updated');
  } catch (err) { return next(err); }
}

async function deleteRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    await adminRolesService.deleteRole(req.params.id, adminId, adminName, req);
    return ok(res, {}, 'Role deleted');
  } catch (err) { return next(err); }
}

async function getUserRoles(req, res, next) {
  try {
    const data = await adminRolesService.getUserRoles(req.params.userId);
    return ok(res, data);
  } catch (err) { return next(err); }
}

async function getAllUserRoles(req, res, next) {
  try {
    const assignments = await adminRolesService.getAllUserRoles();
    return ok(res, { assignments });
  } catch (err) { return next(err); }
}

async function assignRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const roles = await adminRolesService.assignRole(req.params.userId, req.params.roleId, adminId, adminName, req);
    return ok(res, { roles }, 'Role assigned');
  } catch (err) { return next(err); }
}

async function removeRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const roles = await adminRolesService.removeRole(req.params.userId, req.params.roleId, adminId, adminName, req);
    return ok(res, { roles }, 'Role removed');
  } catch (err) { return next(err); }
}

async function getEffectivePermissions(req, res, next) {
  try {
    const permissions = await adminRolesService.getEffectivePermissions(req.params.userId);
    return ok(res, { permissions });
  } catch (err) { return next(err); }
}

module.exports = {
  listPermissions,
  listPermissionsByModule,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getUserRoles,
  getAllUserRoles,
  assignRole,
  removeRole,
  getEffectivePermissions,
};
