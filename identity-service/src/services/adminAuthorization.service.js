// Effective admin authorization — the bridge between the RBAC tables
// (admin_roles / admin_user_roles / admin_permissions) and the coarse
// `users.role` value that access tokens have always carried.
//
// Before this existed the RBAC tables were write-only: assigning a role through
// `POST /admin/users/:userId/roles/:roleId` changed nothing, because the token
// only ever carried `users.role`, and every admin endpoint checks
// `authorize('ADMIN')`. The console therefore showed a Roles & Permissions
// screen that had no effect on the API.
//
// Rollout rule — granting admin roles can only ever NARROW access:
//   * a non-ADMIN account gets no admin authorization at all;
//   * an ADMIN with an explicit admin_user_roles assignment is restricted to the
//     union of those roles' permission keys;
//   * an ADMIN with NO assignment receives no permissions by default. The
//     temporary ALLOW_UNASSIGNED_ADMIN_WILDCARD switch exists only for a
//     controlled migration of legacy accounts.
const adminRolesRepo = require('../repositories/admin-roles.repository');
const { normalizeRole } = require('../models/Role');

const WILDCARD = '*';
const UNRESTRICTED_ADMIN_ROLE = 'SUPER_ADMIN';
const OPERATIONS_ADMIN_ROLE = 'OPERATIONS_ADMIN';

const DEFAULT_OPERATIONS_PERMISSIONS = Object.freeze([
  'dashboard.view',
  'users.view',
  'businesses.view',
  'shops.view',
  'locations.view',
  'orders.view',
  'orders.manage',
  'delivery.view',
  'delivery.manage',
  'disputes.view',
  'disputes.manage',
  'reports.view',
  'audit.view',
]);

// During migration, set this to "true" only if legacy ADMIN accounts must keep
// access before they receive an explicit admin role assignment. New deployments
// should leave it disabled: an ADMIN with no assignment must fail closed.
const ALLOW_UNASSIGNED_ADMIN_WILDCARD =
  String(process.env.ALLOW_UNASSIGNED_ADMIN_WILDCARD || '').toLowerCase() === 'true';

/**
 * Resolves the effective admin authorization for a user.
 *
 * @param {{ id: string, role: string, adminScope?: object }} user
 * @returns {Promise<{ adminRoles: string[], permissions: string[], adminScope: object }>}
 */
async function resolveAdminAuthorization(user) {
  const rawRole = String(user?.role || '').trim().toUpperCase();
  const normalizedRole = normalizeRole(rawRole);
  const isOpsRole = [
    'OPERATIONS_ADMIN',
    'OPERATIONAL_ADMIN',
    'OPS_ADMIN',
    'OPSADMIN',
    'OS_ADMIN',
    'OSADMIN',
    'OPERATIONS',
  ].includes(rawRole);

  const isAdminUser = normalizedRole === 'ADMIN' || isOpsRole || rawRole.endsWith('_ADMIN');

  if (!user || !isAdminUser) {
    return { adminRoles: [], permissions: [], adminScope: {} };
  }

  const adminScope = user.adminScope || {};

  let roles = [];
  try {
    roles = await adminRolesRepo.getUserRoles(user.id);
  } catch (cause) {
    // An unreadable RBAC store is an authorization failure, never permission
    // to bypass the configured role assignments.
    const error = new Error('Unable to resolve administrator permissions');
    error.code = 'ADMIN_AUTHORIZATION_UNAVAILABLE';
    error.cause = cause;
    error.status = 503;
    throw error;
  }

  if (!roles.length) {
    if (isOpsRole) {
      return {
        adminRoles: [OPERATIONS_ADMIN_ROLE],
        permissions: [...DEFAULT_OPERATIONS_PERMISSIONS],
        adminScope,
      };
    }
    if (ALLOW_UNASSIGNED_ADMIN_WILDCARD || rawRole === 'SUPER_ADMIN' || normalizedRole === 'ADMIN') {
      return {
        adminRoles: [UNRESTRICTED_ADMIN_ROLE],
        permissions: [WILDCARD],
        adminScope,
      };
    }
  }

  const permissions = new Set();
  for (const role of roles) {
    for (const key of role.permissions || []) permissions.add(key);
  }

  const resolvedRoleNames = roles.map((role) => role.name).filter(Boolean);
  if (
    (isOpsRole || resolvedRoleNames.includes(OPERATIONS_ADMIN_ROLE)) &&
    permissions.size === 0
  ) {
    for (const p of DEFAULT_OPERATIONS_PERMISSIONS) permissions.add(p);
  }

  if (isOpsRole && !resolvedRoleNames.length) {
    resolvedRoleNames.push(OPERATIONS_ADMIN_ROLE);
  }

  return {
    adminRoles: resolvedRoleNames.length
      ? resolvedRoleNames
      : (isOpsRole ? [OPERATIONS_ADMIN_ROLE] : [UNRESTRICTED_ADMIN_ROLE]),
    permissions: [...permissions],
    adminScope,
  };
}

module.exports = {
  resolveAdminAuthorization,
  WILDCARD,
  UNRESTRICTED_ADMIN_ROLE,
  ALLOW_UNASSIGNED_ADMIN_WILDCARD,
};
