const IDENTITY_HEADERS = {
  USER_ID: 'x-user-id',
  EMAIL: 'x-user-email',
  ROLE: 'x-user-role',
  // Multi-actor capability set (comma-separated) derived by the gateway from the
  // verified token's `capabilities` claim. Absent on a legacy token, in which
  // case authorize() falls back to the primary role alone.
  CAPABILITIES: 'x-user-capabilities',
  // Membership STATUS per actor role, JSON ({ SELLER: 'PENDING', ... }) — the
  // input authorize() needs to answer ROLE_NOT_APPROVED / ROLE_REJECTED /
  // ROLE_SUSPENDED instead of a bare 403. Absent on a legacy token.
  ROLE_STATUSES: 'x-user-role-statuses',
};

function authenticate(req, res, next) {
  if (!req.fromGateway) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: requests must arrive through the API Gateway',
      errors: [],
    });
  }

  const userId = req.headers[IDENTITY_HEADERS.USER_ID];
  const role = req.headers[IDENTITY_HEADERS.ROLE];

  if (userId) {
    req.user = {
      id: userId,
      sub: userId,
      email: req.headers[IDENTITY_HEADERS.EMAIL] || null,
      role: role || 'BUYER',
      capabilities: parseCapabilities(req.headers[IDENTITY_HEADERS.CAPABILITIES]),
      roleStatuses: parseRoleStatuses(req.headers[IDENTITY_HEADERS.ROLE_STATUSES]),
    };
    return next();
  }

  return res.status(401).json({ success: false, message: 'Unauthorized: missing identity', errors: [] });
}

/** `"BUYER,SELLER,PROVIDER"` -> ['BUYER','SELLER','PROVIDER']; null when absent. */
function parseCapabilities(header) {
  if (!header) return null;
  return String(header)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** `{"SELLER":"PENDING"}` -> object; null when absent or unparseable. */
function parseRoleStatuses(header) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

module.exports = { authenticate, IDENTITY_HEADERS, parseCapabilities, parseRoleStatuses };
