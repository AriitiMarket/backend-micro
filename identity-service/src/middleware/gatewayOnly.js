// Only the API Gateway (and named peer services, on the internal API) may talk
// to this service.
//
// Identity is not publicly reachable (see docker-compose: no published port) —
// every browser/SPA call arrives through the gateway. Without this gate, any
// container that can reach identity's private address could call the public
// /auth, /user, /admin surfaces directly and bypass the gateway's rate limiting,
// authorisation table and identity injection.
//
// Caller classes are the same as in Commerce/Delivery's gatewayOnly:
//
//   * `gateway`    — proxied from the public edge; only here are the x-user-*
//                    headers trustworthy, so only here is `req.fromGateway` set.
//   * peer service — direct service-to-service call; `/internal/*` only, never
//                    a user-facing route, and never a user identity.
'use strict';

const { verifyInternalRequest, loadCredentials } = require('../shared/internal-auth');

const credentials = loadCredentials(process.env);

// Open paths: liveness/readiness probes (docker-compose), OIDC discovery/JWKS
// (public by specification) and static media (the gateway's uploads proxy sends
// no service headers).
const OPEN_PATHS = ['/', '/health', '/.well-known', '/uploads'];

const INTERNAL_PREFIX = '/internal';

function isOpen(path) {
  for (const open of OPEN_PATHS) {
    if (path === open || path.indexOf(open + '/') === 0) return true;
  }
  return false;
}

function deny(res, code, message) {
  return res.status(403).json({ success: false, code, message, errors: [] });
}

function gatewayOnly(req, res, next) {
  const path = req.path || '/';
  if (isOpen(path)) return next();

  const verdict = verifyInternalRequest(req, credentials);
  if (!verdict.ok) return deny(res, verdict.code, verdict.message);

  req.internalCaller = verdict.caller;

  if (verdict.caller === 'gateway') {
    req.fromGateway = true;
    return next();
  }

  if (path === INTERNAL_PREFIX || path.indexOf(INTERNAL_PREFIX + '/') === 0) return next();

  return deny(res, 'FORBIDDEN', 'Forbidden: service-to-service calls may only use the internal API');
}

module.exports = gatewayOnly;
