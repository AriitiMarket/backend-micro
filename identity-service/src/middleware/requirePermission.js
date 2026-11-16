// Permission-level authorization, layered on top of the role gate.
//
// Why this is a separate middleware: `authorize()` deliberately has NO implicit
// ADMIN bypass (see the shared-middleware contract and its test). Permission
// checks are opt-in per route and are applied AFTER `authorize('ADMIN')`.
//
// Semantics: an admin holding the wildcard passes. Standardized permission checking
// against @packages/authz and explicit permission string arrays.
let AuthorizationManager = null;
try {
  ({ AuthorizationManager } = require('@packages/authz'));
} catch (e) {
  AuthorizationManager = null;
}

function requirePermission(permission) {
  const required = Array.isArray(permission) ? permission : [permission];
  return function (req, res, next) {
    const permissions = (req.user && req.user.permissions) || [];
    const role = (req.user && req.user.role) || '';

    // Direct wildcard permission bypass
    if (permissions.includes('*')) return next();

    // Check against user token permissions or AuthorizationManager fallback
    const hasAll = required.every((key) => {
      if (permissions.includes(key)) return true;
      if (AuthorizationManager && AuthorizationManager.hasPermission(role, key)) return true;
      return false;
    });

    if (hasAll) return next();

    const err = new Error('You do not have permission to perform this action');
    err.statusCode = 403;
    return next(err);
  };
}

module.exports = requirePermission;
module.exports.requirePermission = requirePermission;
