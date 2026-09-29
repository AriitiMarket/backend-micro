// Guards the service-to-service (/internal/*) routes.
//
// These endpoints are called by the API Gateway (proxying a cluster client) and
// directly by the Commerce and Delivery services — never by browsers. The caller
// must identify itself in `x-internal-service` and prove it with the cluster
// credential issued to that caller (`x-internal-token`; per-service secrets from
// INTERNAL_SERVICE_TOKENS, with the legacy shared INTERNAL_SERVICE_TOKEN as a
// fallback).
//
// The credential is deliberately NOT the JWT signing key: a leaked internal
// credential can never be used to mint or verify user tokens.
'use strict';

const { verifyInternalRequest, loadCredentials } = require('../shared/internal-auth');

const credentials = loadCredentials(process.env);

function internalOnly(req, res, next) {
  const verdict = verifyInternalRequest(req, credentials);
  // Fail closed: with no configured credential the endpoint is disabled.
  if (!verdict.ok) {
    return res.status(403).json({
      success: false,
      code: verdict.code,
      message: verdict.message,
      errors: [],
    });
  }
  req.internalCaller = verdict.caller;
  // Only traffic proxied from the public edge may carry a user identity.
  if (verdict.caller === 'gateway') req.fromGateway = true;
  return next();
}

module.exports = internalOnly;
