// Gateway authentication middleware.
//
// Verifies the Bearer access token with the Identity Service JWKS (RS256) and
// attaches the verified claims to `req.token`.
//
// This is the ONLY place the full claim set is read. Downstream services receive
// just the coarse identity (x-user-id / email / role) injected by the proxy —
// permissions and jurisdiction never travel to a service as data (see
// tests/identity-boundary.test.js).
//
// Correctness note: `verifyToken()` is ASYNC. This middleware previously called it
// without `await`, so `payload` was a pending Promise, `payload.sub` was
// undefined, nothing threw, and the request was treated as authenticated. The
// middleware was never wired in, so the bug was latent — it is fixed here rather
// than left as a trap for the next caller.
const { verifyToken } = require('../utils/jwks');

/** Permission key that grants everything (an admin with no RBAC assignment). */
const WILDCARD = '*';

/** The permission keys carried by a verified token. */
function readPermissions(payload) {
  if (!payload || !Array.isArray(payload.permissions)) return [];
  return payload.permissions.map(String);
}

async function authenticate(req, res, next) {
  // `identify` already verified this exact request's token earlier in the
  // chain and stored it on `req.token`. Re-verifying would repeat the RSA
  // signature check and JWKS lookup for no benefit, so reuse it.
  if (req.token && req.token.sub) {
    req.identity = {
      id: req.token.sub,
      email: req.token.email || null,
      role: req.token.role || null,
    };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHENTICATED',
      message: 'Unauthorized: no token',
      errors: [],
    });
  }

  try {
    const payload = await verifyToken(authHeader.split(' ')[1]);
    req.token = payload;
    req.identity = {
      id: payload.sub,
      email: payload.email || null,
      role: payload.role || null,
    };
    return next();
  } catch (err) {
    console.error(`[authenticate] Token verification failed: ${err.message}`);
    return res.status(401).json({
      success: false,
      code: 'UNAUTHENTICATED',
      message: 'Unauthorized: invalid or expired token',
      errors: [],
    });
  }
}

module.exports = authenticate;
module.exports.authenticate = authenticate;
module.exports.WILDCARD = WILDCARD;
module.exports.readPermissions = readPermissions;
