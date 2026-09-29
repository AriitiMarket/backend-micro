// Resolves the caller's identity (if any) from the Bearer access token using
// the Identity Service JWKS. Never rejects the request: endpoints that require
// authentication are guarded downstream, and the identity resolved here is used
// for rate-limit bucketing.
const { verifyToken } = require('../utils/jwks');

async function identify(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = await verifyToken(authHeader.split(' ')[1]);
      // Cache the verified claims so `authenticate` (which runs immediately
      // after this in the chain) does not verify the same token twice.
      req.token = payload;
      req.identity = {
        id: payload.sub,
        email: payload.email || null,
        role: payload.role || null,
      };
    } catch (err) {
      // Invalid/expired token: leave req.identity unset (anonymous bucket).
    }
  }
  return next();
}

module.exports = identify;
