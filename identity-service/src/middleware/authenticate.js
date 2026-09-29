// Authentication middleware — verifies Bearer JWT access tokens (RS256).
// No cookies, no server-side sessions. Pure token-based.
const { verifyAccessToken } = require('../utils/jwt');
const { ROLES, normalizeRole } = require('../models/Role');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const err = new Error('Not Authorized. Login again');
      err.statusCode = 401;
      return next(err);
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded || !decoded.sub) {
      const err = new Error('Not Authorized. Login again');
      err.statusCode = 401;
      return next(err);
    }
    req.user = {
      id: decoded.sub,
      sub: decoded.sub,
      email: decoded.email || null,
      role: normalizeRole(decoded.role) || ROLES.BUYER,
      scope: decoded.scope || null,
      // Multi-actor capability set (BUYER + each ACTIVE actor membership). A token
      // minted before this claim existed has none, and authorize() then falls back
      // to the primary role alone.
      capabilities: Array.isArray(decoded.capabilities) ? decoded.capabilities : null,
      // The account's primary role — preserved even when `role` above is switched
      // to another actor, so nothing about the account's home role is lost.
      primaryRole: normalizeRole(decoded.primary_role || decoded.role) || ROLES.BUYER,
      // Membership STATUS per actor role ({ SELLER: 'PENDING', ... }) — the input
      // authorize() uses to answer ROLE_NOT_APPROVED / ROLE_REJECTED /
      // ROLE_SUSPENDED. Null when the token predates the claim.
      roleStatuses: decoded.role_statuses && typeof decoded.role_statuses === 'object'
        ? decoded.role_statuses
        : null,
      // RBAC bridge (Identity-owned; see services/adminAuthorization.service.js).
      // A token minted before these claims existed has none — that is NOT the
      // same as "assigned a role granting nothing", so admins fall back to the
      // wildcard (the pre-RBAC behaviour) and everyone else to an empty set.
      adminRoles: Array.isArray(decoded.admin_roles) ? decoded.admin_roles : [],
      permissions: Array.isArray(decoded.permissions)
        ? decoded.permissions
        : (decoded.role === 'ADMIN' ? ['*'] : []),
      adminScope: decoded.admin_scope && typeof decoded.admin_scope === 'object'
        ? decoded.admin_scope
        : null,
    };
    return next();
  } catch (err) {
    err.statusCode = 401;
    return next(err);
  }
}

module.exports = authenticate;
