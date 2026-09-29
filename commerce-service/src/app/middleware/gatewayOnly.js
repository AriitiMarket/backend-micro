// Only the API Gateway (and named peer services, on the internal API) may talk
// to this service.
//
// The service is not publicly reachable (see docker-compose: no published
// ports) and every request must carry a cluster credential issued to a named
// caller: `x-internal-service` says who is calling and `x-internal-token`
// proves it. This is what makes the gateway-supplied x-user-id / x-user-role
// headers trustworthy — without this check any direct caller could simply
// assert an identity.
//
// Two caller classes are distinguished:
//
//   * `gateway`    — traffic proxied from the public edge. Only here are the
//                    x-user-* headers trusted, so only here is
//                    `req.fromGateway` set (which is what `authenticate`
//                    requires before it will read them).
//   * peer service — a direct service-to-service call. It may use the
//                    `/internal/*` namespace only, never a user-facing route,
//                    and it never gets `req.fromGateway`, so its requests can
//                    never be read as carrying a user identity.
//
// Byte-identical across commerce-service and delivery-service (same convention
// as middleware/authorize.js).
'use strict';

const { verifyInternalRequest, loadCredentials } = require('../../shared/internal-auth');

// Inbound verification only needs the credential set, not this component's own
// name, so the file stays identical in every service.
const credentials = loadCredentials(process.env);

// Paths that must stay reachable without a cluster credential:
// liveness/readiness probes (used by docker-compose) and static media (fetched
// by the gateway's uploads proxy, which sends no service headers).
const OPEN_PATHS = ['/', '/health', '/uploads'];

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
