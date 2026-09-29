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
//   * an ADMIN with NO assignment keeps the wildcard, so enabling RBAC cannot
//     lock the seeded admin (created without an admin_roles link) out of the
//     console.
const adminRolesRepo = require('../repositories/admin-roles.repository');

const WILDCARD = '*';
const UNRESTRICTED_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * Resolves the effective admin authorization for a user.
 *
 * @param {{ id: string, role: string, adminScope?: object }} user
 * @returns {Promise<{ adminRoles: string[], permissions: string[], adminScope: object }>}
 */
async function resolveAdminAuthorization(user) {
  if (!user || user.role !== 'ADMIN') {
    return { adminRoles: [], permissions: [], adminScope: {} };
  }

  const adminScope = user.adminScope || {};

  let roles = [];
  try {
    roles = await adminRolesRepo.getUserRoles(user.id);
  } catch {
    // A missing/unreadable RBAC table must not strip a working admin. The
    // assignment is the restriction mechanism, so failing open here preserves
    // the pre-RBAC behaviour.
    roles = [];
  }

  if (!roles.length) {
    return {
      adminRoles: [UNRESTRICTED_ADMIN_ROLE],
      permissions: [WILDCARD],
      adminScope,
    };
  }

  const permissions = new Set();
  for (const role of roles) {
    for (const key of role.permissions || []) permissions.add(key);
  }

  return {
    adminRoles: roles.map((role) => role.name).filter(Boolean),
    permissions: [...permissions],
    adminScope,
  };
}

module.exports = {
  resolveAdminAuthorization,
  WILDCARD,
  UNRESTRICTED_ADMIN_ROLE,
};
