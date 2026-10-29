// Admin roles controller — handles HTTP requests for role and permission management.
'use strict';

const adminRolesService = require('../services/admin-roles.service');
const { ok } = require('../utils/response');

/**
 * List all registered system permissions available across modules.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listPermissions(req, res, next) {
  try {
    const permissions = await adminRolesService.listPermissions();
    return ok(res, { permissions });
  } catch (err) {
    return next(err);
  }
}

/**
 * Group and list all permissions categorized by module.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listPermissionsByModule(req, res, next) {
  try {
    const permissions = await adminRolesService.listPermissionsByModule();
    return ok(res, { permissions });
  } catch (err) {
    return next(err);
  }
}

/**
 * List all admin roles (both system-defined and custom roles).
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listRoles(req, res, next) {
  try {
    const roles = await adminRolesService.listRoles();
    return ok(res, { roles });
  } catch (err) {
    return next(err);
  }
}

/**
 * Fetch details and permission definitions for a specific admin role.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getRole(req, res, next) {
  try {
    const role = await adminRolesService.getRole(req.params.id);
    return ok(res, { role });
  } catch (err) {
    return next(err);
  }
}

/**
 * Create a new custom admin role with defined permissions, audited by caller.
 * 
 * @param {import('express').Request} req - Express request with body { name, display_name, description, permissions }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function createRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const role = await adminRolesService.createRole(req.body, adminId, adminName, req);
    return ok(res, { role }, 'Role created');
  } catch (err) {
    return next(err);
  }
}

/**
 * Update an existing admin role's display name, description, or permissions.
 * 
 * @param {import('express').Request} req - Express request with params { id } and update body
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function updateRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const role = await adminRolesService.updateRole(req.params.id, req.body, adminId, adminName, req);
    return ok(res, { role }, 'Role updated');
  } catch (err) {
    return next(err);
  }
}

/**
 * Delete a custom admin role (system-defined roles are protected against deletion).
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function deleteRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    await adminRolesService.deleteRole(req.params.id, adminId, adminName, req);
    return ok(res, {}, 'Role deleted');
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve assigned admin roles and effective permissions for a user.
 * 
 * @param {import('express').Request} req - Express request with params { userId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getUserRoles(req, res, next) {
  try {
    const data = await adminRolesService.getUserRoles(req.params.userId);
    return ok(res, data);
  } catch (err) {
    return next(err);
  }
}

/**
 * List all administrative role assignments across all admin accounts.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getAllUserRoles(req, res, next) {
  try {
    const assignments = await adminRolesService.getAllUserRoles();
    return ok(res, { assignments });
  } catch (err) {
    return next(err);
  }
}

/**
 * Assign an admin role to a user and record the audit trail.
 * 
 * @param {import('express').Request} req - Express request with params { userId, roleId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function assignRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const roles = await adminRolesService.assignRole(req.params.userId, req.params.roleId, adminId, adminName, req);
    return ok(res, { roles }, 'Role assigned');
  } catch (err) {
    return next(err);
  }
}

/**
 * Revoke an admin role assignment from a user and record the audit trail.
 * 
 * @param {import('express').Request} req - Express request with params { userId, roleId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function removeRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const roles = await adminRolesService.removeRole(req.params.userId, req.params.roleId, adminId, adminName, req);
    return ok(res, { roles }, 'Role removed');
  } catch (err) {
    return next(err);
  }
}

/**
 * Calculate and return the flattened effective permissions for a user.
 * 
 * @param {import('express').Request} req - Express request with params { userId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getEffectivePermissions(req, res, next) {
  try {
    const permissions = await adminRolesService.getEffectivePermissions(req.params.userId);
    return ok(res, { permissions });
  } catch (err) {
    return next(err);
  }
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
