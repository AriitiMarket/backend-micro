const { hasCapability } = require('../../shared/permissions');

// Capability-based authorization middleware. Replaces scattered role checks:
// routes declare the capability they need, the policy table decides which
// roles hold it. The rejection body matches `authorize()` so failures are
// identical across the service.
function requireCapability(capability) {
  return function requireCapabilityMiddleware(req, res, next) {
    const role = req.user ? req.user.role : null;
    if (hasCapability(role, capability)) return next();
    return res.status(403).json({
      success: false,
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
      errors: [],
    });
  };
}

module.exports = requireCapability;
module.exports.requireCapability = requireCapability;
