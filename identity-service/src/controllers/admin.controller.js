// Administrator controller — handles user administration, roles, status, scopes, and seller oversight.
'use strict';

const adminService = require('../services/admin.service');
const auditService = require('../services/audit.service');
const { getPool } = require('../config/database');
const twoFactorService = require('../services/twoFactor.service');
const authService = require('../services/auth.service');
const { audit2FA } = require('../services/auditLog.service');
const { ok } = require('../utils/response');

/**
 * List paginated users with optional filtering by role, status, search term, or specific IDs.
 * 
 * @param {import('express').Request} req - Express request with query params { role, status, search, ids, page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listUsers(req, res, next) {
  try {
    const { role, status, search, ids, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const offset = (pageNum - 1) * limitNum;

    const result = await adminService.listUsers({ role, status, search, ids, limit: limitNum, offset });
    return ok(res, {
      users: result.users || [],
      total: result.total || 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((result.total || 0) / limitNum),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve detailed user profile by ID.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getUser(req, res, next) {
  try {
    const user = await adminService.getUser(req.params.id);
    return ok(res, { user });
  } catch (err) {
    return next(err);
  }
}

/**
 * Update a user's role and record an audit log entry.
 * 
 * @param {import('express').Request} req - Express request with body { role } and authenticated user token
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function setRole(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const user = await adminService.setRole(req.params.id, req.body.role, adminId, adminName, req);
    return ok(res, { user }, 'Role updated');
  } catch (err) {
    return next(err);
  }
}

/**
 * Update a user's account status (e.g. active, suspended) and record an audit log entry.
 * 
 * @param {import('express').Request} req - Express request with body { status } and authenticated user token
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function setUserStatus(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const user = await adminService.setUserStatus(req.params.id, req.body.status, adminId, adminName, req);
    return ok(res, { user }, 'Status updated');
  } catch (err) {
    return next(err);
  }
}

/**
 * Configure geographical and service admin scope for an administrator account.
 * 
 * @param {import('express').Request} req - Express request with body { scope }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function setAdminScope(req, res, next) {
  try {
    const adminId = req.user?.id || req.user?.sub || 'unknown';
    const adminName = req.user?.name || req.user?.email || 'Admin';
    const oldScope = await adminService.getAdminScope(req.params.id);
    const user = await adminService.setAdminScope(req.params.id, req.body.scope);
    await auditService.logAdminScopeChanged(adminId, adminName, req.params.id, oldScope, req.body.scope, req);
    return ok(res, { user, scope: user.adminScope }, 'Admin scope updated');
  } catch (err) {
    return next(err);
  }
}

/**
 * Fetch the configured administrative scope for a user.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getAdminScope(req, res, next) {
  try {
    const scope = await adminService.getAdminScope(req.params.id);
    return ok(res, { scope });
  } catch (err) {
    return next(err);
  }
}

/**
 * List paginated seller accounts with optional status and search filtering.
 * 
 * @param {import('express').Request} req - Express request with query params { status, search, page, limit }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function listSellers(req, res, next) {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const offset = (pageNum - 1) * limitNum;

    const result = await adminService.listSellers({ status, search, limit: limitNum, offset });
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve seller profile details by ID.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getSeller(req, res, next) {
  try {
    const seller = await adminService.getSeller(req.params.id);
    return ok(res, { seller });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve aggregated platform-wide administrative dashboard statistics.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getDashboardStats(req, res, next) {
  try {
    const stats = await adminService.getDashboardStats();
    return ok(res, { stats });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve counts of pending applications, approvals, and reviews.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getPendingStats(req, res, next) {
  try {
    const data = await adminService.getPendingStats();
    return ok(res, { data });
  } catch (err) {
    return next(err);
  }
}

/**
 * Emergency administrative reset of user 2FA.
 * Disables 2FA on the user's account, terminates all active sessions, and logs an audit trail.
 * 
 * @param {import('express').Request} req - Express request with params { id }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function resetUser2FA(req, res, next) {
  try {
    const pool = await getPool();

    await twoFactorService.disable2FA(pool, req.params.id);
    await authService.revokeAllUserTokens(req.params.id);

    audit2FA.disabled(req.params.id);

    return ok(res, { success: true }, 'User 2FA has been disabled and all sessions terminated.');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listUsers,
  getUser,
  setRole,
  setUserStatus,
  setAdminScope,
  getAdminScope,
  listSellers,
  getSeller,
  getDashboardStats,
  getPendingStats,
  resetUser2FA,
};
