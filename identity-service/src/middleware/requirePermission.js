// Permission-level authorization, layered on top of the role gate.
//
// Why this is a separate middleware: `authorize()` deliberately has NO implicit
// ADMIN bypass (see the shared-middleware contract and its test). Permission
// checks are opt-in per route and are applied AFTER `authorize('ADMIN')`.
//
// Semantics: an admin holding the wildcard passes — which includes every admin
// that has no explicit RBAC assignment yet, so turning RBAC on can only narrow
// access, never lock an existing admin out.
function requirePermission(permission) {
  const required = Array.isArray(permission) ? permission : [permission];
  return function (req, res, next) {
    const permissions = (req.user && req.user.permissions) || [];
    if (permissions.includes('*')) return next();
    if (required.every((key) => permissions.includes(key))) return next();

    const err = new Error('You do not have permission to perform this action');
    err.statusCode = 403;
    return next(err);
  };
}

module.exports = requirePermission;
module.exports.requirePermission = requirePermission;
