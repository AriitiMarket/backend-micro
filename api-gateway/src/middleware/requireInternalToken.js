// Gate for /internal/* at the public edge.
//
// Internal endpoints exist for service-to-service traffic only. The gateway is
// the only publicly reachable component, so it demands a cluster credential
// here: a request that does not name a known caller in `x-internal-service` and
// prove it with that caller's credential never reaches a service, no matter what
// other headers it carries.
//
// The credential is verified with the canonical `shared/internal-auth` module,
// so the edge and the services enforce exactly the same rules. The gateway also
// stops trusting any client-supplied `x-internal-service` downstream (see
// proxies/forward.js): it always re-signs outbound traffic as itself.
'use strict';

const { verifyInternalRequest, loadCredentials } = require('../shared/internal-auth');

const credentials = loadCredentials(process.env, 'gateway');

function requireInternalToken(req, res, next) {
  const verdict = verifyInternalRequest(req, credentials);
  // Fail closed: no valid credential ⇒ internal routes are disabled at the edge.
  if (!verdict.ok) {
    return res.status(403).json({
      success: false,
      code: verdict.code,
      message: verdict.message,
      errors: [],
    });
  }
  req.internalCaller = verdict.caller;
  return next();
}

module.exports = requireInternalToken;
